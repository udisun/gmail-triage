import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendRunEntry, appendUndone, loadState, readUndone, saveState } from '../src/state.ts'
import type { RunEntry } from '../src/state.ts'
import { undoRun } from '../src/undo.ts'
import type { UndoApi } from '../src/undo.ts'

beforeEach(() => {
  process.env.GMAIL_TRIAGE_HOME = mkdtempSync(join(tmpdir(), 'gt-undo-'))
})

const fakeApi = (failIds: string[] = [], newer: string[] = []) => {
  const calls: Parameters<UndoApi['modify']>[0][] = []
  const reads: string[] = []
  const api: UndoApi = {
    get: async (p) => {
      reads.push(p.id)
      return { data: { messages: [{ id: `m-${p.id}`, internalDate: '1000' }, ...(newer.includes(p.id) ? [{ id: `new-${p.id}`, internalDate: '2000' }] : [])] } }
    },
    modify: async (p) => {
      if (failIds.includes(p.id)) {
        throw new Error('boom')
      }
      calls.push(p)
    },
  }
  return { api, calls, reads }
}
const e = (threadId: string, labelId: string, starred: boolean, archived: boolean): RunEntry => ({ threadId, messageId: `m-${threadId}`, bucket: 'receipts', labelId, starred, archived })
const D = '2026-11-15'

test('undoRun reverses each entry and drops them from processed', async () => {
  await appendRunEntry(D, e('t1', 'L1', true, true))
  await appendRunEntry(D, e('t2', 'L2', false, false))
  await saveState({ mode: 'live', artifactUrl: null, processed: { t1: 'm-t1', t2: 'm-t2', t3: 'm-t3' } })
  const { api, calls } = fakeApi()
  assert.deepEqual(await undoRun(api, D), { restored: 2, skipped: 0, superseded: [] })
  assert.deepEqual(calls, [
    { userId: 'me', id: 't1', requestBody: { addLabelIds: ['INBOX'], removeLabelIds: ['L1', 'STARRED'] } },
    { userId: 'me', id: 't2', requestBody: { addLabelIds: [], removeLabelIds: ['L2'] } },
  ])
  assert.deepEqual((await loadState()).processed, { t3: 'm-t3' })
})

test('undoRun on an unknown date throws "no run log"', async () => {
  await assert.rejects(undoRun(fakeApi().api, '2026-01-01'), /no run log/)
})

test('a partial failure keeps going, throws the failed ids, removes only successes', async () => {
  await appendRunEntry(D, e('t1', 'L1', false, true))
  await appendRunEntry(D, e('t2', 'L1', false, true))
  await appendRunEntry(D, e('t3', 'L1', false, true))
  await saveState({ mode: 'live', artifactUrl: null, processed: { t1: 'm-t1', t2: 'm-t2', t3: 'm-t3' } })
  const { api, calls } = fakeApi(['t2'])
  await assert.rejects(undoRun(api, D), /t2/)
  assert.deepEqual(calls.map((c) => c.id), ['t1', 't3'])
  assert.deepEqual((await loadState()).processed, { t2: 'm-t2' })
})

test('an entry that changed nothing is skipped', async () => {
  await appendRunEntry(D, { ...e('t1', 'L1', false, false), labelId: '' })
  await saveState({ mode: 'live', artifactUrl: null, processed: { t1: 'm-t1' } })
  const { api, calls } = fakeApi()
  assert.deepEqual(await undoRun(api, D), { restored: 0, skipped: 1, superseded: [] })
  assert.equal(calls.length, 0)
})

test('undoing twice makes zero calls the second time', async () => {
  await appendRunEntry(D, e('t1', 'L1', false, true))
  await appendRunEntry(D, e('t2', 'L1', false, true))
  await saveState({ mode: 'live', artifactUrl: null, processed: { t1: 'm-t1', t2: 'm-t2' } })
  const { api, calls } = fakeApi()
  await undoRun(api, D)
  assert.equal(calls.length, 2)
  assert.deepEqual(await undoRun(api, D), { restored: 0, skipped: 2, superseded: [] })
  assert.equal(calls.length, 2)
})

test('a thread retriaged before any undo is superseded: no call, state kept', async () => {
  await appendRunEntry(D, e('t9', 'L1', false, true))
  await saveState({ mode: 'live', artifactUrl: null, processed: { t9: 'm-other' } })
  const { api, calls } = fakeApi()
  assert.deepEqual(await undoRun(api, D), { restored: 0, skipped: 0, superseded: ['t9'] })
  assert.equal(calls.length, 0)
  assert.deepEqual((await loadState()).processed, { t9: 'm-other' })
})

test('undo, retriage, undo again: the retriaged thread is listed as superseded', async () => {
  await appendRunEntry(D, e('t1', 'L1', false, true))
  await saveState({ mode: 'live', artifactUrl: null, processed: { t1: 'm-t1' } })
  const { api, calls } = fakeApi(['t1'])
  await assert.rejects(undoRun(api, D), /t1/)
  await saveState({ mode: 'live', artifactUrl: null, processed: { t1: 'm-new' } })
  assert.deepEqual(await undoRun(api, D), { restored: 0, skipped: 0, superseded: ['t1'] })
  assert.equal(calls.length, 0)
  assert.deepEqual((await loadState()).processed, { t1: 'm-new' })
})

test('after a partial failure a retry only redoes the failed threads', async () => {
  await appendRunEntry(D, e('t1', 'L1', false, true))
  await appendRunEntry(D, e('t2', 'L1', false, true))
  await saveState({ mode: 'live', artifactUrl: null, processed: { t1: 'm-t1', t2: 'm-t2' } })
  await assert.rejects(undoRun(fakeApi(['t2']).api, D), /t2/)
  const { api, calls } = fakeApi()
  assert.deepEqual(await undoRun(api, D), { restored: 1, skipped: 1, superseded: [] })
  assert.deepEqual(calls.map((c) => c.id), ['t2'])
  assert.deepEqual((await loadState()).processed, {})
})

test('a persisted receipt with a leftover marker is reconciled with no Gmail call; a newer marker is kept', async () => {
  await appendRunEntry(D, e('t1', 'L1', false, true))
  await appendRunEntry(D, e('t2', 'L1', false, true))
  await appendUndone(D, { threadId: 't1', messageId: 'm-t1' })
  await appendUndone(D, { threadId: 't2', messageId: 'm-t2' })
  await saveState({ mode: 'live', artifactUrl: null, processed: { t1: 'm-t1', t2: 'm-newer', t3: 'm-t3' } })
  const { api, calls } = fakeApi()
  assert.deepEqual(await undoRun(api, D), { restored: 0, skipped: 2, superseded: [] })
  assert.equal(calls.length, 0)
  assert.deepEqual((await loadState()).processed, { t2: 'm-newer', t3: 'm-t3' })
})

test('a missing processed marker is an uncertain write: undone; a different marker is superseded', async () => {
  await appendRunEntry(D, e('t1', 'L1', false, true))
  await appendRunEntry(D, e('t2', 'L1', false, true))
  await saveState({ mode: 'live', artifactUrl: null, processed: { t2: 'm-other' } })
  const { api, calls } = fakeApi()
  assert.deepEqual(await undoRun(api, D), { restored: 1, skipped: 0, superseded: ['t2'] })
  assert.deepEqual(calls.map((c) => c.id), ['t1'])
  assert.deepEqual((await loadState()).processed, { t2: 'm-other' })
})

test('undoRun passes its retry wrapper to the guarded write', async () => {
  await appendRunEntry(D, e('t1', 'L1', false, true))
  await saveState({ mode: 'live', artifactUrl: null, processed: { t1: 'm-t1' } })
  const calls: string[] = []
  let n = 0
  const api: UndoApi = { get: async () => ({ data: {} }), modify: async (p) => { calls.push(p.id); if (n++ === 0) { throw new Error('429') } } }
  const retry = async <T>(fn: () => Promise<T>): Promise<T> => { try { return await fn() } catch { return await fn() } }
  assert.deepEqual(await undoRun(api, D, retry), { restored: 1, skipped: 0, superseded: [] })
  assert.deepEqual(calls, ['t1', 't1'])
})

const dd = (threadId: string, labelId = 'D1'): RunEntry => ({ kind: 'dedupe', threadId, messageId: `m-${threadId}`, labelId })

test('a dedupe entry restores UNREAD and INBOX and removes the dup label, next to a triage entry', async () => {
  await appendRunEntry(D, e('t1', 'L1', true, true))
  await appendRunEntry(D, dd('t2'))
  await saveState({ mode: 'live', artifactUrl: null, processed: { t1: 'm-t1', t2: 'm-t2' } })
  const { api, calls } = fakeApi()
  assert.deepEqual(await undoRun(api, D), { restored: 2, skipped: 0, superseded: [] })
  assert.deepEqual(calls, [
    { userId: 'me', id: 't1', requestBody: { addLabelIds: ['INBOX'], removeLabelIds: ['L1', 'STARRED'] } },
    { userId: 'me', id: 't2', requestBody: { addLabelIds: ['UNREAD', 'INBOX'], removeLabelIds: ['D1'] } },
  ])
  assert.deepEqual((await loadState()).processed, {})
})

test('dedupe entries follow the superseded, already-undone and uncertain rules', async () => {
  await appendRunEntry(D, dd('t1'))
  await appendRunEntry(D, dd('t2'))
  await appendRunEntry(D, dd('t3'))
  await appendUndone(D, { threadId: 't3', messageId: 'm-t3' })
  await saveState({ mode: 'live', artifactUrl: null, processed: { t2: 'm-other', t3: 'm-t3' } })
  const { api, calls } = fakeApi()
  assert.deepEqual(await undoRun(api, D), { restored: 1, skipped: 1, superseded: ['t2'] })
  assert.deepEqual(calls.map((c) => c.id), ['t1'])
  assert.deepEqual((await loadState()).processed, { t2: 'm-other' })
})

test('a triage entry never gets to add UNREAD even when a dedupe entry shares the log', async () => {
  await appendRunEntry(D, dd('t1', 'D1'))
  await appendRunEntry(D, e('t2', 'D1', false, true))
  await saveState({ mode: 'live', artifactUrl: null, processed: { t1: 'm-t1', t2: 'm-t2' } })
  const { api, calls } = fakeApi()
  await undoRun(api, D)
  assert.deepEqual(calls.map((c) => c.requestBody.addLabelIds), [['UNREAD', 'INBOX'], ['INBOX']])
})

test('a dedupe entry whose thread got a newer message is superseded: no modify, state kept, no receipt', async () => {
  await appendRunEntry(D, dd('t1'))
  await appendRunEntry(D, dd('t2'))
  await saveState({ mode: 'live', artifactUrl: null, processed: { t1: 'm-t1', t2: 'm-t2' } })
  const { api, calls, reads } = fakeApi([], ['t1'])
  assert.deepEqual(await undoRun(api, D), { restored: 1, skipped: 0, superseded: ['t1'] })
  assert.deepEqual(reads, ['t1', 't2'])
  assert.deepEqual(calls.map((c) => c.id), ['t2'])
  assert.deepEqual((await loadState()).processed, { t1: 'm-t1' })
})

test('triage entries are undone without reading the thread', async () => {
  await appendRunEntry(D, e('t1', 'L1', false, true))
  await saveState({ mode: 'live', artifactUrl: null, processed: { t1: 'm-t1' } })
  const { api, reads } = fakeApi()
  await undoRun(api, D)
  assert.deepEqual(reads, [])
})

test('a failing thread read on a dedupe entry counts as a failed undo with no modify', async () => {
  await appendRunEntry(D, dd('t1'))
  await saveState({ mode: 'live', artifactUrl: null, processed: { t1: 'm-t1' } })
  const calls: string[] = []
  const api: UndoApi = { get: async () => { throw new Error('boom') }, modify: async (p) => { calls.push(p.id) } }
  await assert.rejects(undoRun(api, D), /t1/)
  assert.deepEqual(calls, [])
})

const ao = (threadId: string, labelId = 'A1'): RunEntry => ({ kind: 'archiveOld', threadId, messageId: `m-${threadId}`, labelId })

test('an archive-old entry adds INBOX and removes its label, and never touches state.processed', async () => {
  await appendRunEntry(D, ao('t1'))
  await appendRunEntry(D, ao('t2'))
  await saveState({ mode: 'live', artifactUrl: null, processed: { t1: 'm-triaged-earlier', t3: 'm-t3' } })
  const { api, calls, reads } = fakeApi()
  assert.deepEqual(await undoRun(api, D), { restored: 2, skipped: 0, superseded: [] })
  assert.deepEqual(reads, ['t1', 't2'])
  assert.deepEqual(calls, [
    { userId: 'me', id: 't1', requestBody: { addLabelIds: ['INBOX'], removeLabelIds: ['A1'] } },
    { userId: 'me', id: 't2', requestBody: { addLabelIds: ['INBOX'], removeLabelIds: ['A1'] } },
  ])
  assert.deepEqual((await loadState()).processed, { t1: 'm-triaged-earlier', t3: 'm-t3' })
})

test('an archive-old entry whose thread got a newer message is superseded: no write, no receipt', async () => {
  await appendRunEntry(D, ao('t1'))
  await appendRunEntry(D, ao('t2'))
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const { api, calls } = fakeApi([], ['t1'])
  assert.deepEqual(await undoRun(api, D), { restored: 1, skipped: 0, superseded: ['t1'] })
  assert.deepEqual(calls.map((c) => c.id), ['t2'])
})

test('an archive-old entry is undone once and a failing read counts as a failed undo', async () => {
  await appendRunEntry(D, ao('t1'))
  await appendUndone(D, { threadId: 't1', messageId: 'm-t1' })
  await saveState({ mode: 'live', artifactUrl: null, processed: { t1: 'm-t1' } })
  const { api, calls } = fakeApi()
  assert.deepEqual(await undoRun(api, D), { restored: 0, skipped: 1, superseded: [] })
  assert.deepEqual(calls, [])
  assert.deepEqual((await loadState()).processed, { t1: 'm-t1' })
  await appendRunEntry(D, ao('t2'))
  const badCalls: string[] = []
  const bad: UndoApi = { get: async () => { throw new Error('boom') }, modify: async (p) => { badCalls.push(p.id) } }
  await assert.rejects(undoRun(bad, D), /t2/)
  assert.deepEqual(badCalls, [])
})

test('archive-old and triage entries share one log without sharing label allowances', async () => {
  await appendRunEntry(D, e('t1', 'L1', true, true))
  await appendRunEntry(D, ao('t2'))
  await saveState({ mode: 'live', artifactUrl: null, processed: { t1: 'm-t1' } })
  const { api, calls } = fakeApi()
  await undoRun(api, D)
  assert.deepEqual(calls.map((c) => c.requestBody), [{ addLabelIds: ['INBOX'], removeLabelIds: ['L1', 'STARRED'] }, { addLabelIds: ['INBOX'], removeLabelIds: ['A1'] }])
  assert.deepEqual((await loadState()).processed, {})
})

test('archive, undo, archive again, undo again on one date: the second undo restores', async () => {
  const first = { ...ao('t1'), opId: 'op-1' }
  const second = { ...ao('t1'), opId: 'op-2' }
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const { api, calls } = fakeApi()
  await appendRunEntry(D, first)
  assert.deepEqual(await undoRun(api, D), { restored: 1, skipped: 0, superseded: [] })
  await appendRunEntry(D, second)
  assert.deepEqual(await undoRun(api, D), { restored: 1, skipped: 1, superseded: [] })
  assert.deepEqual(calls.map((c) => c.id), ['t1', 't1'])
  assert.deepEqual((await readUndone(D)).map((u) => u.opId), ['op-1', 'op-2'])
  assert.deepEqual(await undoRun(api, D), { restored: 0, skipped: 2, superseded: [] })
  assert.equal(calls.length, 2)
})

test('a triage and an archive-old entry for the same thread and message do not mask each other', async () => {
  await appendRunEntry(D, { ...e('t1', 'L1', false, true), opId: 'op-a' })
  await appendRunEntry(D, { ...ao('t1'), opId: 'op-b' })
  await appendRunEntry(D, { ...dd('t1'), opId: 'op-c' })
  await appendUndone(D, { threadId: 't1', messageId: 'm-t1', opId: 'op-a' })
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const { api, calls } = fakeApi()
  assert.deepEqual(await undoRun(api, D), { restored: 2, skipped: 1, superseded: [] })
  assert.deepEqual(calls.map((c) => c.requestBody.removeLabelIds), [['A1'], ['D1']])
})

test('a legacy log without operation ids undoes once and is idempotent, with synthetic receipt ids', async () => {
  await appendRunEntry(D, e('t1', 'L1', false, true))
  await appendRunEntry(D, ao('t2'))
  await appendRunEntry(D, dd('t3'))
  await saveState({ mode: 'live', artifactUrl: null, processed: { t1: 'm-t1', t3: 'm-t3' } })
  const { api, calls } = fakeApi()
  assert.deepEqual(await undoRun(api, D), { restored: 3, skipped: 0, superseded: [] })
  assert.deepEqual((await readUndone(D)).map((u) => u.opId), ['legacy:triage:t1:m-t1:1', 'legacy:archiveOld:t2:m-t2:2', 'legacy:dedupe:t3:m-t3:3'])
  assert.deepEqual(await undoRun(api, D), { restored: 0, skipped: 3, superseded: [] })
  assert.equal(calls.length, 3)
})

test('a legacy receipt covers only legacy entries, never an entry that has an operation id', async () => {
  await appendRunEntry(D, { ...ao('t1'), opId: 'op-new' })
  await appendRunEntry(D, ao('t2'))
  await appendUndone(D, { threadId: 't1', messageId: 'm-t1' })
  await appendUndone(D, { threadId: 't2', messageId: 'm-t2' })
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const { api, calls } = fakeApi()
  assert.deepEqual(await undoRun(api, D), { restored: 1, skipped: 1, superseded: [] })
  assert.deepEqual(calls.map((c) => c.id), ['t1'])
})
