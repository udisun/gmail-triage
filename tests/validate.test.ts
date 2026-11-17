import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateVerdicts } from '../src/validate.ts'
import type { ThreadInput } from '../src/types.ts'

const input = (threadId: string, listUnsubscribe: string | null = null): ThreadInput => ({
  threadId, messageId: `m-${threadId}`, from: 'a@x.com', toOrCcMe: true, automated: false, humanDirectUnread: true, subject: 's', date: 'd', internalDate: 0, allUnread: true, messageCount: 1, listId: null, listUnsubscribe, listUnsubscribePost: null, snippet: '',
})
const fallback = { bucket: 'attention', reason: 'unclassified' }

test('malformed raw sends every input to attention', () => {
  for (const raw of [null, undefined, 'x', 42, [], {}, { verdicts: 'x' }, { verdicts: null }]) {
    const out = validateVerdicts([input('a'), input('b')], raw)
    assert.equal(out.size, 2)
    assert.deepEqual(out.get('a'), fallback)
    assert.deepEqual(out.get('b'), fallback)
  }
})

test('input id missing from raw falls back', () => {
  const out = validateVerdicts([input('a'), input('b')], { verdicts: [{ id: 'a', bucket: 'receipts', reason: 'invoice' }] })
  assert.deepEqual(out.get('a'), { bucket: 'receipts', reason: 'invoice' })
  assert.deepEqual(out.get('b'), fallback)
})

test('bucket outside the enum falls back', () => {
  const out = validateVerdicts([input('a')], { verdicts: [{ id: 'a', bucket: 'spam', reason: 'junk' }] })
  assert.deepEqual(out.get('a'), fallback)
})

test('malformed entries fall back and never throw', () => {
  const out = validateVerdicts([input('a'), input('b'), input('c')], {
    verdicts: [null, 'x', { id: 'a', bucket: 'urgent' }, { id: 'b', bucket: 7, reason: 'r' }, { id: 7, bucket: 'urgent', reason: 'r' }],
  })
  assert.equal(out.size, 3)
  for (const id of ['a', 'b', 'c']) {
    assert.deepEqual(out.get(id), fallback)
  }
})

test('unknown ids are ignored', () => {
  const out = validateVerdicts([input('a')], { verdicts: [{ id: 'zzz', bucket: 'urgent', reason: 'r' }, { id: 'a', bucket: 'nonwork', reason: 'r' }] })
  assert.equal(out.size, 1)
  assert.equal(out.has('zzz'), false)
})

test('any duplicated id falls back, whatever the combination', () => {
  const v = (bucket: string) => ({ id: 'a', bucket, reason: 'r' })
  const combos = [
    [v('receipts'), v('attention')],
    [v('attention'), v('receipts')],
    [v('receipts'), v('receipts')],
    [v('spam'), v('nonwork')],
    [v('nonwork'), v('spam')],
    [v('receipts'), v('receipts'), v('receipts')],
  ]
  for (const verdicts of combos) {
    const out = validateVerdicts([input('a'), input('b')], { verdicts: [...verdicts, { id: 'b', bucket: 'receipts', reason: 'ok' }] })
    assert.deepEqual(out.get('a'), fallback)
    assert.deepEqual(out.get('b'), { bucket: 'receipts', reason: 'ok' })
  }
})

test('fallback verdicts are fresh objects per thread and per call', () => {
  const first = validateVerdicts([input('a'), input('b')], null)
  first.get('a')!.bucket = 'receipts'
  assert.equal(first.get('b')?.bucket, 'attention')
  assert.notEqual(first.get('a'), first.get('b'))
  assert.deepEqual(validateVerdicts([input('a')], null).get('a'), fallback)
})

test('unsubscribe without List-Unsubscribe becomes outreach', () => {
  const raw = { verdicts: [{ id: 'a', bucket: 'unsubscribe', reason: 'r' }, { id: 'b', bucket: 'unsubscribe', reason: 'r' }] }
  const out = validateVerdicts([input('a', null), input('b', '<https://x/u>')], raw)
  assert.equal(out.get('a')?.bucket, 'outreach')
  assert.equal(out.get('b')?.bucket, 'unsubscribe')
})

test('reason is truncated to 12 words', () => {
  const reason = '  one two three four five six seven eight nine ten eleven twelve thirteen fourteen '
  const out = validateVerdicts([input('a')], { verdicts: [{ id: 'a', bucket: 'attention', reason }] })
  assert.equal(out.get('a')?.reason, 'one two three four five six seven eight nine ten eleven twelve')
})

test('valid entry passes through', () => {
  const out = validateVerdicts([input('a')], { verdicts: [{ id: 'a', bucket: 'notifications', reason: 'GitHub CI' }] })
  assert.deepEqual(out.get('a'), { bucket: 'notifications', reason: 'GitHub CI' })
})
