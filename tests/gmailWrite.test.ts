import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyArchiveOld, applyDedupe, applyTriage, applyUndo, archiveOldBody, assertArchiveOldBody, assertDedupeBody, assertTriageBody, assertUndoBody, dedupeBody, ensureLabels, triageBody } from '../src/gmailWrite.ts'
import type { LabelsApi, ModifyBody, Retry, ThreadsApi } from '../src/gmailWrite.ts'
import { ARCHIVED_OLD_LABEL, DUPLICATE_LABEL, LABEL_NAME, RESOLVED_LABEL, STALE_LABEL } from '../src/buckets.ts'

const fakeThreads = () => {
  const calls: Parameters<ThreadsApi['modify']>[0][] = []
  const api: ThreadsApi = { modify: async (p) => { calls.push(p) } }
  return { api, calls }
}
const body = (addLabelIds: string[], removeLabelIds: string[]): ModifyBody => ({ addLabelIds, removeLabelIds })
const triageIds = new Set(['L1', 'L2'])
const logged = new Set(['L1'])

test('triageBody builds star and archive bodies', () => {
  assert.deepEqual(triageBody('L1', { star: true, archive: false }), body(['L1', 'STARRED'], []))
  assert.deepEqual(triageBody('L1', { star: false, archive: true }), body(['L1'], ['INBOX']))
  assert.deepEqual(triageBody('L1', { star: false, archive: false }), body(['L1'], []))
})

test('triage allows triage label, STARRED, and INBOX removal with one modify call', async () => {
  const { api, calls } = fakeThreads()
  await applyTriage(api, 't1', body(['L1', 'STARRED'], ['INBOX']), triageIds)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { userId: 'me', id: 't1', requestBody: body(['L1', 'STARRED'], ['INBOX']) })
})

test('triage rejects anything outside the allowlist with zero calls', async () => {
  const bad = [body(['INBOX'], []), body(['TRASH'], []), body(['Label_9'], []), body(['L1'], ['UNREAD']), body(['L1'], ['SPAM']), body([], []), body(['L1'], ['INBOX', 'TRASH'])]
  for (const b of bad) {
    const { api, calls } = fakeThreads()
    await assert.rejects(applyTriage(api, 't1', b, triageIds))
    assert.equal(calls.length, 0)
    assert.throws(() => assertTriageBody(b, triageIds))
  }
})

test('undo allows INBOX add and removal of logged labels or STARRED', async () => {
  const { api, calls } = fakeThreads()
  await applyUndo(api, 't1', body(['INBOX'], ['L1', 'STARRED']), logged)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].requestBody, body(['INBOX'], ['L1', 'STARRED']))
})

test('undo rejects anything outside the allowlist with zero calls', async () => {
  const bad = [body(['TRASH'], []), body([], ['L2']), body(['STARRED'], []), body([], []), body(['INBOX'], ['UNREAD'])]
  for (const b of bad) {
    const { api, calls } = fakeThreads()
    await assert.rejects(applyUndo(api, 't1', b, logged))
    assert.equal(calls.length, 0)
    assert.throws(() => assertUndoBody(b, logged))
  }
})

test('ensureLabels creates only the missing labels (buckets plus the duplicate, archived-old, resolved and stale audit labels) and returns 11 ids', async () => {
  const created: string[] = []
  const names = [...Object.values(LABEL_NAME), DUPLICATE_LABEL, ARCHIVED_OLD_LABEL, RESOLVED_LABEL, STALE_LABEL]
  const api: LabelsApi = {
    list: async () => ({ data: { labels: [
      { id: 'x1', name: 'INBOX' },
      { id: 'e1', name: names[0] },
      { id: 'e2', name: names[1] },
      { id: 'e3', name: names[2] },
    ] } }),
    create: async (p) => {
      created.push(p.requestBody.name)
      return { data: { id: `new-${created.length}` } }
    },
  }
  const ids = await ensureLabels(api)
  assert.equal(created.length, 8)
  assert.ok(created.includes(DUPLICATE_LABEL) && created.includes(ARCHIVED_OLD_LABEL))
  for (const n of created) {
    assert.ok(names.includes(n))
  }
  assert.equal(Object.keys(ids).length, 11)
  assert.equal(new Set(Object.values(ids)).size, 11)
  assert.equal(ids.urgent, 'e1')
})

test('ensureLabels throws when create returns no id', async () => {
  const api: LabelsApi = { list: async () => ({ data: {} }), create: async () => ({ data: {} }) }
  await assert.rejects(ensureLabels(api))
})

test('snapshot: toJSON, custom iterator, extra field and non-plain bodies are rejected with zero calls', async () => {
  const withToJSON = { addLabelIds: ['L1'], removeLabelIds: [], toJSON: () => body(['TRASH'], []) }
  const evilArr = ['SPAM'] as string[]
  Object.defineProperty(evilArr, Symbol.iterator, { value: function* () { yield 'L1' } })
  class Evil { addLabelIds = ['L1']; removeLabelIds: string[] = []; toJSON () { return body(['TRASH'], []) } }
  const bad: unknown[] = [
    withToJSON,
    { addLabelIds: evilArr, removeLabelIds: [] },
    { addLabelIds: ['L1'], removeLabelIds: [], extra: 1 },
    { addLabelIds: ['L1'] },
    { addLabelIds: ['L1', 5], removeLabelIds: [] },
    { addLabelIds: 'L1', removeLabelIds: [] },
    new Evil(),
    null,
  ]
  for (const b of bad) {
    const { api, calls } = fakeThreads()
    await assert.rejects(applyTriage(api, 't1', b as ModifyBody, triageIds))
    await assert.rejects(applyUndo(api, 't1', b as ModifyBody, logged))
    assert.equal(calls.length, 0)
  }
})

test('snapshot: mutating the caller arrays after the call starts does not change what is sent', async () => {
  const add = ['L1']
  const original = body(add, ['INBOX'])
  let sent = ''
  const api: ThreadsApi = {
    modify: async (p) => {
      add.push('TRASH')
      original.removeLabelIds.push('TRASH')
      sent = JSON.stringify(p.requestBody)
    },
  }
  await applyTriage(api, 't1', original, triageIds)
  assert.equal(sent, JSON.stringify(body(['L1'], ['INBOX'])))
})

const retryOnce = (): { retry: Retry, runs: () => number } => {
  let runs = 0
  const retry: Retry = async (fn) => {
    runs++
    try {
      return await fn()
    } catch {
      return await fn()
    }
  }
  return { retry, runs: () => runs }
}

test('a rate-limited modify retried by the wrapper sends the same guarded body twice', async () => {
  const sent: ModifyBody[] = []
  let n = 0
  const api: ThreadsApi = { modify: async (p) => { sent.push(p.requestBody); if (n++ === 0) { throw new Error('429') } } }
  const { retry } = retryOnce()
  await applyTriage(api, 't1', body(['L1', 'STARRED'], ['INBOX']), triageIds, retry)
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[0], body(['L1', 'STARRED'], ['INBOX']))
  assert.deepEqual(sent[1], sent[0])
})

test('the same wrapper retries undo and label calls', async () => {
  const sent: ModifyBody[] = []
  let n = 0
  const api: ThreadsApi = { modify: async (p) => { sent.push(p.requestBody); if (n++ === 0) { throw new Error('429') } } }
  await applyUndo(api, 't1', body(['INBOX'], ['L1']), logged, retryOnce().retry)
  assert.deepEqual(sent, [body(['INBOX'], ['L1']), body(['INBOX'], ['L1'])])
  let lists = 0
  const labels: LabelsApi = { list: async () => { if (lists++ === 0) { throw new Error('429') } return { data: { labels: [...Object.values(LABEL_NAME), DUPLICATE_LABEL, ARCHIVED_OLD_LABEL, RESOLVED_LABEL, STALE_LABEL].map((name, i) => ({ id: `e${i}`, name })) } } }, create: async () => ({ data: {} }) }
  assert.equal(Object.keys(await ensureLabels(labels, retryOnce().retry)).length, 11)
  assert.equal(lists, 2)
})

test('a guard rejection never reaches the retry wrapper', async () => {
  for (const b of [body(['TRASH'], []), body([], []), body(['L1'], ['UNREAD'])]) {
    const { api, calls } = fakeThreads()
    const { retry, runs } = retryOnce()
    await assert.rejects(applyTriage(api, 't1', b, triageIds, retry))
    await assert.rejects(applyUndo(api, 't1', b, logged, retry))
    assert.equal(runs(), 0)
    assert.equal(calls.length, 0)
  }
})

const DUP = 'D1'

test('dedupeBody marks read, labels and archives', () => {
  assert.deepEqual(dedupeBody(DUP), body([DUP], ['UNREAD', 'INBOX']))
})

test('dedupe allows exactly the dup label add and UNREAD/INBOX removal with one modify call', async () => {
  const { api, calls } = fakeThreads()
  await applyDedupe(api, 't1', dedupeBody(DUP), DUP)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { userId: 'me', id: 't1', requestBody: body([DUP], ['UNREAD', 'INBOX']) })
  const { api: api2, calls: calls2 } = fakeThreads()
  await applyDedupe(api2, 't1', body([DUP], ['INBOX']), DUP)
  assert.equal(calls2.length, 1)
})

test('dedupe rejects TRASH, other labels, adding UNREAD or INBOX, STARRED and empty bodies with zero calls', async () => {
  const bad = [body(['TRASH'], []), body([DUP, 'TRASH'], ['UNREAD']), body(['L1'], ['UNREAD', 'INBOX']), body([DUP, 'UNREAD'], ['INBOX']), body([DUP], ['UNREAD', 'TRASH']), body([DUP], ['SPAM']), body([DUP, 'STARRED'], ['INBOX']), body(['INBOX'], []), body([], ['UNREAD']), body([], [])]
  for (const b of bad) {
    const { api, calls } = fakeThreads()
    await assert.rejects(applyDedupe(api, 't1', b, DUP))
    assert.equal(calls.length, 0)
    assert.throws(() => assertDedupeBody(b, DUP))
  }
})

test('dedupe fails closed on a system label id standing in for the dup label', () => {
  for (const id of ['', 'INBOX', 'UNREAD', 'STARRED', 'TRASH', 'SPAM']) {
    assert.throws(() => assertDedupeBody(body([id], ['UNREAD']), id), id)
  }
})

test('dedupe bodies go through the same snapshot checks', async () => {
  const { api, calls } = fakeThreads()
  await assert.rejects(applyDedupe(api, 't1', { addLabelIds: [DUP], removeLabelIds: ['UNREAD'], extra: 1 } as ModifyBody, DUP))
  assert.equal(calls.length, 0)
})

test('the triage shape still rejects removing UNREAD', () => {
  assert.throws(() => assertTriageBody(body(['L1'], ['UNREAD']), triageIds))
  assert.throws(() => assertTriageBody(body(['L1'], ['UNREAD', 'INBOX']), triageIds))
  assert.throws(() => assertTriageBody(body(['D1'], ['INBOX']), triageIds))
})

test('undo of a dedupe entry may add UNREAD and INBOX and remove the dup label only', async () => {
  const { api, calls } = fakeThreads()
  await applyUndo(api, 't1', body(['UNREAD', 'INBOX'], [DUP]), new Set([DUP]), undefined, true)
  assert.deepEqual(calls[0].requestBody, body(['UNREAD', 'INBOX'], [DUP]))
  for (const b of [body(['UNREAD', 'INBOX'], [DUP, 'STARRED']), body(['TRASH'], [DUP]), body(['UNREAD'], ['L2']), body(['STARRED'], [DUP]), body([], [])]) {
    const { api: a, calls: c } = fakeThreads()
    await assert.rejects(applyUndo(a, 't1', b, new Set([DUP]), undefined, true))
    assert.equal(c.length, 0)
  }
})

test('a triage undo still may not add UNREAD', async () => {
  for (const b of [body(['UNREAD'], ['L1']), body(['INBOX', 'UNREAD'], ['L1'])]) {
    const { api, calls } = fakeThreads()
    await assert.rejects(applyUndo(api, 't1', b, logged))
    assert.equal(calls.length, 0)
    assert.throws(() => assertUndoBody(b, logged))
  }
  assert.doesNotThrow(() => assertUndoBody(body(['UNREAD'], ['L1']), logged, true))
})

test('a dedupe guard rejection never reaches the retry wrapper, and an allowed body is retried with the same body', async () => {
  const { api, calls } = fakeThreads()
  const { retry, runs } = retryOnce()
  await assert.rejects(applyDedupe(api, 't1', body([DUP, 'TRASH'], ['UNREAD']), DUP, retry))
  await assert.rejects(applyUndo(api, 't1', body(['UNREAD'], ['L1']), logged, retry))
  assert.equal(runs(), 0)
  assert.equal(calls.length, 0)
  const sent: ModifyBody[] = []
  let n = 0
  const flaky: ThreadsApi = { modify: async (p) => { sent.push(p.requestBody); if (n++ === 0) { throw new Error('429') } } }
  await applyDedupe(flaky, 't1', dedupeBody(DUP), DUP, retryOnce().retry)
  assert.deepEqual(sent, [dedupeBody(DUP), dedupeBody(DUP)])
})

const OLD = 'A1'

test('archiveOldBody labels and archives, never touching UNREAD or STARRED', () => {
  assert.deepEqual(archiveOldBody(OLD), body([OLD], ['INBOX']))
})

test('archive-old allows exactly the label add and INBOX removal with one modify call', async () => {
  const { api, calls } = fakeThreads()
  await applyArchiveOld(api, 't1', archiveOldBody(OLD), OLD)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { userId: 'me', id: 't1', requestBody: body([OLD], ['INBOX']) })
})

test('archive-old rejects UNREAD, STARRED, TRASH, other labels and incomplete or empty bodies with zero calls', async () => {
  const bad = [
    body([OLD], ['INBOX', 'UNREAD']), body([OLD], ['UNREAD']), body([OLD, 'STARRED'], ['INBOX']), body([OLD], ['INBOX', 'STARRED']), body([OLD, 'TRASH'], ['INBOX']), body(['TRASH'], ['INBOX']),
    body(['L1'], ['INBOX']), body([OLD, 'L1'], ['INBOX']), body([OLD], ['INBOX', 'SPAM']), body(['UNREAD'], ['INBOX']), body([OLD, 'INBOX'], ['INBOX']),
    body([OLD], []), body([], ['INBOX']), body([], []),
  ]
  for (const b of bad) {
    const { api, calls } = fakeThreads()
    await assert.rejects(applyArchiveOld(api, 't1', b, OLD))
    assert.equal(calls.length, 0)
    assert.throws(() => assertArchiveOldBody(b, OLD))
  }
})

test('archive-old fails closed on a system label id standing in for the label', () => {
  for (const id of ['', 'INBOX', 'UNREAD', 'STARRED', 'TRASH', 'SPAM']) {
    assert.throws(() => assertArchiveOldBody(body([id], ['INBOX']), id), id)
  }
})

test('archive-old bodies go through the same snapshot checks and a rejection never reaches retry', async () => {
  const { api, calls } = fakeThreads()
  const { retry, runs } = retryOnce()
  await assert.rejects(applyArchiveOld(api, 't1', { addLabelIds: [OLD], removeLabelIds: ['INBOX'], extra: 1 } as ModifyBody, OLD, retry))
  await assert.rejects(applyArchiveOld(api, 't1', body([OLD], ['UNREAD']), OLD, retry))
  assert.equal(runs(), 0)
  assert.equal(calls.length, 0)
  const sent: ModifyBody[] = []
  let n = 0
  const flaky: ThreadsApi = { modify: async (p) => { sent.push(p.requestBody); if (n++ === 0) { throw new Error('429') } } }
  await applyArchiveOld(flaky, 't1', archiveOldBody(OLD), OLD, retryOnce().retry)
  assert.deepEqual(sent, [archiveOldBody(OLD), archiveOldBody(OLD)])
})

test('undo of an archive-old entry may add INBOX and remove its label only', async () => {
  const { api, calls } = fakeThreads()
  await applyUndo(api, 't1', body(['INBOX'], [OLD]), new Set([OLD]), undefined, 'archiveOld')
  assert.deepEqual(calls[0].requestBody, body(['INBOX'], [OLD]))
  for (const b of [body(['INBOX'], [OLD, 'STARRED']), body(['INBOX', 'UNREAD'], [OLD]), body(['TRASH'], [OLD]), body(['INBOX'], ['L2']), body(['STARRED'], [OLD]), body([], [])]) {
    const { api: a, calls: c } = fakeThreads()
    await assert.rejects(applyUndo(a, 't1', b, new Set([OLD]), undefined, 'archiveOld'))
    assert.equal(c.length, 0)
  }
})

test('triage may swap bucket labels but never add and remove the same label or touch a user label', async () => {
  assert.deepEqual(triageBody('L1', { star: false, archive: true }, ['L2']), body(['L1'], ['INBOX', 'L2']))
  const { api, calls } = fakeThreads()
  await applyTriage(api, 't1', body(['L1'], ['L2']), triageIds)
  assert.equal(calls.length, 1)
  for (const b of [body(['L1'], ['L1']), body(['L1'], ['Label_9']), body(['L1', 'STARRED'], ['STARRED'])]) {
    assert.throws(() => assertTriageBody(b, triageIds))
  }
})

test('a triage undo may re-add only the bucket labels its entries logged as removed', () => {
  assert.doesNotThrow(() => assertUndoBody(body(['L2'], ['L1']), logged, false, new Set(['L2'])))
  assert.throws(() => assertUndoBody(body(['L2'], ['L1']), logged))
  assert.throws(() => assertUndoBody(body(['L3'], ['L1']), logged, false, new Set(['L2'])))
  assert.throws(() => assertUndoBody(body(['L1'], ['L1']), logged, false, new Set(['L1'])))
})
