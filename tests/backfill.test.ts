import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runUnsubCapture } from '../src/run.ts'
import type { GmailLike } from '../src/run.ts'
import { acquireLock, appendRunEntry } from '../src/state.ts'
import type { UnsubEntry } from '../src/unsubscribe.ts'

const DATE = '2026-11-16'

beforeEach(() => {
  process.env.GMAIL_TRIAGE_HOME = mkdtempSync(join(tmpdir(), 'gt-backfill-'))
})

type Extra = { id: string, from: string, lu?: string, post?: string }
type Spec = { id: string, from: string, lu?: string, post?: string, read?: boolean, extra?: Extra[] }
const fakeGmail = (specs: Spec[]) => {
  const calls: string[] = []
  const boom = (name: string) => async () => {
    calls.push(name)
    throw new Error('write attempted')
  }
  const g = {
    users: {
      getProfile: boom('getProfile'),
      threads: {
        list: boom('list'), modify: boom('modify'),
        get: async (p: { id: string, format: string, metadataHeaders: string[] }) => {
          calls.push(`get:${p.format}`)
          const s = specs.find((x) => x.id === p.id)
          if (!s) {
            throw new Error('404')
          }
          const headers = [{ name: 'From', value: s.from }, { name: 'Subject', value: 'secret subject' }, ...(s.lu ? [{ name: 'List-Unsubscribe', value: s.lu }] : []), ...(s.post ? [{ name: 'List-Unsubscribe-Post', value: s.post }] : [])]
          const hdr = (x: Extra) => [{ name: 'From', value: x.from }, ...(x.lu ? [{ name: 'List-Unsubscribe', value: x.lu }] : []), ...(x.post ? [{ name: 'List-Unsubscribe-Post', value: x.post }] : [])]
          const more = (s.extra ?? []).map((x, i) => ({ id: x.id, labelIds: ['UNREAD'], internalDate: String(2000 + i), snippet: 'SNIPPET-TEXT', payload: { headers: hdr(x) } }))
          return { data: { id: s.id, messages: [{ id: `m-${s.id}`, labelIds: s.read ? ['INBOX'] : ['UNREAD'], internalDate: '1000', snippet: 'SNIPPET-TEXT', payload: { headers } }, ...more] } }
        },
      },
      labels: { list: boom('labels.list'), create: boom('labels.create') },
    },
  } as unknown as GmailLike
  return { g, calls }
}

const log = async (id: string, bucket: string, over: object = {}): Promise<void> => {
  await appendRunEntry(DATE, { threadId: id, messageId: `m-${id}`, bucket, labelId: 'L', starred: false, archived: true, ...over } as never)
}
const capture = (): UnsubEntry[] => JSON.parse(readFileSync(join(process.env.GMAIL_TRIAGE_HOME!, 'unsub', `${DATE}.json`), 'utf8'))
const io = () => {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } }
}

test('3 unsubscribe entries (2 from one sender) and 1 notifications entry: 2 rows, 1 one-click, 0 Gmail writes', async () => {
  const { g, calls } = fakeGmail([
    { id: 't1', from: 'News <News@Shop.com>', lu: '<https://shop.com/u1>', post: 'List-Unsubscribe=One-Click' },
    { id: 't2', from: 'news@shop.com', lu: '<https://shop.com/u2>', post: 'List-Unsubscribe=One-Click', read: true },
    { id: 't3', from: 'Other <o@other.com>', lu: '<https://other.com/u>', read: true },
    { id: 't4', from: 'n@notif.com', lu: '<https://notif.com/u>', post: 'List-Unsubscribe=One-Click' },
  ])
  await log('t1', 'unsubscribe')
  await log('t2', 'unsubscribe')
  await log('t3', 'unsubscribe')
  await log('t4', 'notifications')
  await appendRunEntry(DATE, { kind: 'dedupe', threadId: 't9', messageId: 'm-t9', labelId: 'D' })
  const h = io()
  assert.equal(await runUnsubCapture(async () => g, DATE, h.io), 0)
  const rows = capture()
  assert.deepEqual(rows.map((r) => [r.sender, r.httpsUrl, r.oneClick, r.threadId]), [['news@shop.com', 'https://shop.com/u1', true, 't1'], ['o@other.com', 'https://other.com/u', false, 't3']])
  assert.ok(calls.length > 0 && calls.every((c) => c === 'get:metadata'), calls.join())
  assert.equal(calls.length, 3)
  assert.match(h.out.join('\n'), /captured 2 senders, 1 one-click/)
  assert.equal(statSync(join(process.env.GMAIL_TRIAGE_HOME!, 'unsub', `${DATE}.json`)).mode & 0o777, 0o600)
  assert.doesNotMatch(readFileSync(join(process.env.GMAIL_TRIAGE_HOME!, 'unsub', `${DATE}.json`), 'utf8'), /SNIPPET|secret subject/)
})

test('a missing run log is a clear error with exit 2 and no Gmail call; a bad date is exit 2 too', async () => {
  const { g, calls } = fakeGmail([])
  const h = io()
  assert.equal(await runUnsubCapture(async () => g, DATE, h.io), 2)
  assert.match(h.err.join('\n'), /no run log for 2026-11-16/)
  assert.equal(await runUnsubCapture(async () => g, '../x', h.io), 2)
  assert.equal(calls.length, 0)
})

test('merges with an earlier capture and holds the run lock', async () => {
  const first = fakeGmail([{ id: 't1', from: 'a@one.com', lu: '<https://one.com/u>' }])
  await log('t1', 'unsubscribe')
  await runUnsubCapture(async () => first.g, DATE, io().io)
  const second = fakeGmail([{ id: 't2', from: 'b@two.com', lu: '<https://two.com/u>' }])
  await log('t2', 'unsubscribe')
  const release = await acquireLock()
  assert.ok(release)
  const busy = io()
  assert.equal(await runUnsubCapture(async () => second.g, DATE, busy.io), 0)
  assert.match(busy.out.join('\n'), /already running/)
  assert.equal(second.calls.length, 0)
  await release()
  // t1 is in the log but not in this fake, so it counts as unreadable while its earlier row is kept
  assert.equal(await runUnsubCapture(async () => second.g, DATE, io().io), 1)
  assert.deepEqual(capture().map((r) => r.sender).sort(), ['a@one.com', 'b@two.com'])
})

test('a thread that cannot be read is counted, the rest is still captured, exit 1', async () => {
  const { g } = fakeGmail([{ id: 't2', from: 'b@two.com', lu: '<https://two.com/u>' }])
  await log('gone', 'unsubscribe')
  await log('t2', 'unsubscribe')
  const h = io()
  assert.equal(await runUnsubCapture(async () => g, DATE, h.io), 1)
  assert.deepEqual(capture().map((r) => r.sender), ['b@two.com'])
  assert.match(h.err.join('\n'), /1 logged message/)
})

test('several logged messages in one thread are each replayed: one fetch, distinct senders all captured', async () => {
  const { g, calls } = fakeGmail([{
    id: 'tm', from: 'plain@one.com',
    extra: [{ id: 'm2', from: 'b@two.com', lu: '<https://two.com/u>', post: 'List-Unsubscribe=One-Click' }, { id: 'm3', from: 'c@three.com', lu: '<https://three.com/u>' }],
  }])
  await log('tm', 'unsubscribe')
  await log('tm', 'unsubscribe', { messageId: 'm2' })
  await log('tm', 'unsubscribe', { messageId: 'm3' })
  await log('tm', 'unsubscribe', { messageId: 'm3' })
  const h = io()
  assert.equal(await runUnsubCapture(async () => g, DATE, h.io), 0)
  assert.deepEqual(capture().map((r) => [r.sender, r.oneClick]), [['b@two.com', true], ['c@three.com', false]])
  assert.equal(calls.length, 1)
  assert.match(h.out.join('\n'), /captured 2 senders, 1 one-click/)
})
