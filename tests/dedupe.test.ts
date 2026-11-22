import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupDuplicates as group } from '../src/dedupe.ts'
import type { Pins, ThreadInput } from '../src/types.ts'

const t = (threadId: string, over: Partial<ThreadInput> = {}): ThreadInput =>
  ({ threadId, messageId: `m-${threadId}`, from: 'Datadog <digest@dtdg.co>', toOrCcMe: false, automated: true, humanDirectUnread: false, subject: 'Weekly digest', date: 'd', internalDate: 1000, allUnread: true, messageCount: 1, labelIds: [], listId: null, listUnsubscribe: null, listUnsubscribePost: null, snippet: '', ...over })
const NO_PINS: Pins = { neverArchive: [], alwaysUrgent: [] }
const groupDuplicates = (xs: ThreadInput[], pins: Pins = NO_PINS) => group(xs, pins)
const ids = (xs: ThreadInput[]): string[] => xs.map((x) => x.threadId)

test('three copies: the newest is kept as the group head, two older copies', () => {
  const r = groupDuplicates([t('a', { internalDate: 1 }), t('b', { internalDate: 3 }), t('c', { internalDate: 2 })])
  assert.deepEqual(ids(r.keep), [])
  assert.equal(r.dupes.length, 1)
  assert.equal(r.dupes[0].newest.threadId, 'b')
  assert.deepEqual(ids(r.dupes[0].older), ['c', 'a'])
})

test('a subject differing only by digits is not grouped', () => {
  const r = groupDuplicates([t('a', { subject: '[P1] outage' }), t('b', { subject: '[P2] outage' })])
  assert.deepEqual(ids(r.keep), ['a', 'b'])
  assert.deepEqual(r.dupes, [])
})

test('case and surrounding whitespace do not matter, address case and display name do not either', () => {
  const r = groupDuplicates([t('a', { subject: ' Weekly Digest ', internalDate: 1 }), t('b', { subject: 'weekly digest', from: 'X <DIGEST@dtdg.co>', internalDate: 2 })])
  assert.equal(r.dupes.length, 1)
  assert.deepEqual(ids(r.dupes[0].older), ['a'])
})

test('different senders with the same subject are not grouped', () => {
  const r = groupDuplicates([t('a'), t('b', { from: 'other@x.com' })])
  assert.deepEqual(ids(r.keep), ['a', 'b'])
})

test('a null mailbox is never grouped, even with equal subjects', () => {
  const r = groupDuplicates([t('a', { from: '' }), t('b', { from: '' }), t('c', { from: 'a@x.com, b@x.com' }), t('d', { from: 'a@x.com, b@x.com' })])
  assert.deepEqual(ids(r.keep), ['a', 'b', 'c', 'd'])
  assert.deepEqual(r.dupes, [])
})

test('an older copy with unread direct human mail is protected: not collapsed, not in keep', () => {
  const r = groupDuplicates([t('a', { internalDate: 1, humanDirectUnread: true }), t('b', { internalDate: 2 }), t('c', { internalDate: 3 })])
  assert.deepEqual(ids(r.keep), [])
  assert.deepEqual(ids(r.protectedOlder), ['a'])
  assert.equal(r.dupes[0].newest.threadId, 'c')
  assert.deepEqual(ids(r.dupes[0].older), ['b'])
})

test('a group whose only older copy is direct mail dissolves: the newest is kept, the older one is protected', () => {
  const r = groupDuplicates([t('a', { internalDate: 1, humanDirectUnread: true }), t('b', { internalDate: 2 })])
  assert.deepEqual(ids(r.keep), ['b'])
  assert.deepEqual(ids(r.protectedOlder), ['a'])
  assert.deepEqual(r.dupes, [])
})

test('a pinned sender is never grouped, for both pin types and domain entries', () => {
  for (const pins of [{ neverArchive: ['digest@dtdg.co'], alwaysUrgent: [] }, { neverArchive: [], alwaysUrgent: ['@dtdg.co'] }]) {
    const r = groupDuplicates([t('a', { internalDate: 1 }), t('b', { internalDate: 2 })], pins)
    assert.deepEqual(ids(r.keep), ['a', 'b'])
    assert.deepEqual(r.dupes, [])
    assert.deepEqual(r.protectedOlder, [])
  }
})

test('a thread with any already-read message is never grouped', () => {
  const r = groupDuplicates([t('a', { internalDate: 1, allUnread: false, messageCount: 2 }), t('b', { internalDate: 2 }), t('c', { internalDate: 3 })])
  assert.deepEqual(ids(r.keep), ['a'])
  assert.deepEqual(ids(r.dupes[0].older), ['b'])
})

test('human-looking mail (not automated, no List-Id) is never grouped; automated or List-Id mail is', () => {
  const human = groupDuplicates([t('a', { automated: false }), t('b', { automated: false })])
  assert.deepEqual(ids(human.keep), ['a', 'b'])
  assert.deepEqual(human.dupes, [])
  const list = groupDuplicates([t('a', { automated: false, listId: '<l.x.com>' }), t('b', { automated: false, listId: '<l.x.com>' })])
  assert.equal(list.dupes.length, 1)
  const mixed = groupDuplicates([t('a', { automated: false }), t('b', { internalDate: 1 }), t('c', { internalDate: 5 })])
  assert.deepEqual(ids(mixed.keep), ['a'])
  assert.deepEqual(ids(mixed.dupes[0].older), ['b'])
  assert.equal(mixed.dupes[0].newest.threadId, 'c')
})

test('a newest copy with direct mail is still the head; older plain copies collapse', () => {
  const r = groupDuplicates([t('a', { internalDate: 1 }), t('b', { internalDate: 2, humanDirectUnread: true })])
  assert.equal(r.dupes[0].newest.threadId, 'b')
  assert.deepEqual(ids(r.dupes[0].older), ['a'])
})

test('a date tie is broken by the larger threadId, whatever the input order', () => {
  const a = groupDuplicates([t('x1'), t('x9'), t('x5')])
  const b = groupDuplicates([t('x5'), t('x9'), t('x1')])
  assert.equal(a.dupes[0].newest.threadId, 'x9')
  assert.equal(b.dupes[0].newest.threadId, 'x9')
  assert.deepEqual(ids(a.dupes[0].older).sort(), ['x1', 'x5'])
})

test('singletons keep their input order and separate groups stay separate', () => {
  const r = groupDuplicates([t('s1', { subject: 'one' }), t('a', { internalDate: 1 }), t('s2', { subject: 'two' }), t('b', { internalDate: 2 }), t('c', { subject: 'z', internalDate: 1 }), t('d', { subject: 'z', internalDate: 5 })])
  assert.deepEqual(ids(r.keep), ['s1', 's2'])
  assert.deepEqual(r.dupes.map((d) => [d.newest.threadId, ids(d.older)]), [['b', ['a']], ['d', ['c']]])
})
