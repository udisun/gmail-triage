import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runArchiveOld } from '../src/archiveOld.ts'
import type { ArchiveOldDeps } from '../src/archiveOld.ts'
import type { GmailLike } from '../src/run.ts'
import { acquireLock, loadState, readRun, saveState } from '../src/state.ts'

beforeEach(() => {
  process.env.GMAIL_TRIAGE_HOME = mkdtempSync(join(tmpdir(), 'gt-old-'))
})

const DAY = 86_400_000
const NOW = new Date(2026, 10, 16, 12, 0, 0)
const ago = (days: number): string => String(NOW.getTime() - days * DAY)
type Msg = { id: string, labelIds?: string[], internalDate?: string }
type Spec = { id: string, messages: Msg[] }
const read = (id: string, days = 60, labels: string[] = ['INBOX']): Spec => ({ id, messages: [{ id: `m-${id}`, labelIds: labels, internalDate: ago(days) }] })
const gaxios = (status: number, reason?: string): Error => Object.assign(new Error('boom'), { response: { status, data: { error: { errors: reason ? [{ reason }] : [] } } } })

type Kind = 'older' | 'newer' | 'unread' | 'starred'
type Opts = { onGet?: (id: string, n: number) => void, failModify?: string[], throttleModify?: boolean, throttleFirst?: number, throttleGets?: number, override?: Partial<Record<Kind, string[]>>, pageSize?: number, getErrors?: Record<string, number>, getThrows?: boolean, clock?: () => number }
const kindOf = (q: string): Kind => (q.includes('older_than') ? 'older' : q.includes('newer_than') ? 'newer' : q.includes('is:unread') ? 'unread' : 'starred')
// Gmail matches a thread when ANY message matches the query
const matches = (s: Spec, kind: Kind, days: number): boolean => s.messages.some((m) => {
  const at = Number(m.internalDate)
  const age = Number.isFinite(at) ? NOW.getTime() - at : null
  return (m.labelIds ?? []).includes('INBOX') && (kind === 'older' ? age !== null && age > days * DAY : kind === 'newer' ? age !== null && age <= days * DAY : (m.labelIds ?? []).includes(kind === 'unread' ? 'UNREAD' : 'STARRED'))
})
const fake = (specs: Spec[], opts: Opts = {}) => {
  const modifies: { id: string, requestBody: { addLabelIds: string[], removeLabelIds: string[] } }[] = []
  const lists: { q?: string, maxResults?: number, pageToken?: string }[] = []
  const created: string[] = []
  const events: { t: number, units: number }[] = []
  const spend = (units: number): void => { events.push({ t: opts.clock?.() ?? 0, units }) }
  const getCounts = new Map<string, number>()
  let gets = 0
  let modifyCalls = 0
  let getCalls = 0
  let inFlight = 0
  let maxInFlight = 0
  const byId = new Map(specs.map((s) => [s.id, s]))
  const size = opts.pageSize ?? 500
  const track = async (): Promise<void> => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((r) => setImmediate(r))
    inFlight--
  }
  const g = {
    users: {
      getProfile: async () => ({ data: { emailAddress: 'me@x.com' } }),
      labels: {
        list: async () => {
          spend(10)
          return { data: { labels: [] } }
        },
        create: async (p: { requestBody: { name: string } }) => {
          spend(10)
          created.push(p.requestBody.name)
          return { data: { id: `L-${p.requestBody.name}` } }
        },
      },
      threads: {
        list: async (p: { q?: string, maxResults?: number, pageToken?: string }) => {
          lists.push(p)
          spend(10)
          const kind = kindOf(p.q ?? '')
          const days = Number(/(?:older|newer)_than:(\d+)d/.exec(p.q ?? '')?.[1] ?? 0)
          const ids = opts.override?.[kind] ?? specs.filter((x) => matches(x, kind, days)).map((x) => x.id)
          const start = Number(p.pageToken ?? 0)
          const next = start + size
          return { data: { threads: ids.slice(start, next).map((id) => ({ id })), nextPageToken: next < ids.length ? String(next) : undefined } }
        },
        get: async (p: { id: string, format: string }) => {
          gets++
          spend(40)
          if (opts.getThrows) {
            throw new Error('get called')
          }
          await track()
          if (getCalls++ < (opts.throttleGets ?? 0)) {
            throw gaxios(429)
          }
          assert.equal(p.format, 'minimal')
          const n = (getCounts.get(p.id) ?? 0) + 1
          getCounts.set(p.id, n)
          opts.onGet?.(p.id, n)
          const status = opts.getErrors?.[p.id]
          if (status !== undefined) {
            throw gaxios(status)
          }
          const s = byId.get(p.id)
          return { data: { id: p.id, messages: s?.messages ?? [] } }
        },
        modify: async (p: { id: string, requestBody: { addLabelIds: string[], removeLabelIds: string[] } }) => {
          spend(10)
          await track()
          if (opts.throttleModify || modifyCalls++ < (opts.throttleFirst ?? 0)) {
            throw gaxios(429)
          }
          if (opts.failModify?.includes(p.id)) {
            throw new Error('boom')
          }
          modifies.push(p)
        },
      },
    },
  } as unknown as GmailLike
  return { g, modifies, lists, created, events, gets: () => gets, maxInFlight: () => maxInFlight }
}

const run = async (g: GmailLike, args: string[], extra: Partial<ArchiveOldDeps> = {}) => {
  const out: string[] = []
  const err: string[] = []
  let opened = 0
  const code = await runArchiveOld({ gmail: async () => { opened++; return g }, now: () => NOW, sleep: async () => {}, ...extra }, args, { out: (s) => out.push(s), err: (s) => err.push(s) })
  return { code, out, err, opened: () => opened }
}

const MIX: Spec[] = [
  read('ok'),
  { id: 'unr', messages: [{ id: 'a', labelIds: ['INBOX'], internalDate: ago(90) }, { id: 'b', labelIds: ['INBOX', 'UNREAD'], internalDate: ago(80) }] },
  { id: 'star', messages: [{ id: 'a', labelIds: ['INBOX', 'STARRED'], internalDate: ago(90) }] },
  { id: 'reply', messages: [{ id: 'a', labelIds: ['INBOX'], internalDate: ago(90) }, { id: 'b', labelIds: ['INBOX'], internalDate: ago(2) }] },
  read('out', 60, ['Label_1']),
]

test('preview runs the four id-only queries in order, counts each skip reason and makes zero gets and zero writes', async () => {
  const f = fake(MIX, { getThrows: true })
  const r = await run(f.g, [])
  assert.equal(r.code, 0)
  assert.deepEqual(f.lists.map((l) => [l.q, l.maxResults, l.pageToken]), [
    ['in:inbox older_than:30d', 500, undefined], ['in:inbox newer_than:30d', 500, undefined], ['in:inbox is:unread', 500, undefined], ['in:inbox is:starred', 500, undefined],
  ])
  assert.deepEqual(r.out, ['candidates 4', 'eligible 1', 'skipped 3 (recent 1, unread 1, starred 1)', 'estimated time 1 min', 're-run with --yes to archive 1 threads'])
  assert.equal(f.gets(), 0)
  assert.equal(f.modifies.length, 0)
  assert.equal(f.created.length, 0)
  await assert.rejects(readRun('2026-11-16'), /no run log/)
})

test('set arithmetic: older minus newer, unread and starred; an id in several sets counts under the first reason', async () => {
  const f = fake([], { getThrows: true, override: {
    older: ['ok', 'rec', 'unr', 'star', 'all', 'unrstar'], newer: ['rec', 'all', 'other'], unread: ['unr', 'all', 'unrstar'], starred: ['star', 'all', 'unrstar'],
  } })
  const r = await run(f.g, [])
  assert.deepEqual(r.out.slice(0, 3), ['candidates 6', 'eligible 1', 'skipped 5 (recent 2, unread 2, starred 1)'])
})

test('a thread is eligible only when it is read, unstarred, in the inbox and has no message newer than N days', async () => {
  for (const [spec, eligible] of [[read('a'), 1], [read('a', 29), 0], [read('a', 31), 1], [read('a', 60, ['Label_1']), 0], [read('a', 60, ['INBOX', 'UNREAD']), 0], [read('a', 60, ['INBOX', 'STARRED']), 0]] as [Spec, number][]) {
    const r = await run(fake([spec]).g, [])
    assert.ok(r.out.includes(`eligible ${eligible}`), JSON.stringify(spec))
  }
})

test('any recent message decides: an old first message with a recent reply is skipped', async () => {
  const r = await run(fake([{ id: 't', messages: [{ id: 'new', labelIds: ['INBOX'], internalDate: ago(1) }, { id: 'old', labelIds: ['INBOX'], internalDate: ago(200) }] }]).g, [])
  assert.deepEqual(r.out.slice(0, 3), ['candidates 1', 'eligible 0', 'skipped 1 (recent 1)'])
})

test('a missing internalDate fails closed at the re-check: skipped as changed, no write', async () => {
  const f = fake([{ id: 't', messages: [{ id: 'a', labelIds: ['INBOX'], internalDate: ago(90) }, { id: 'b', labelIds: ['INBOX'] }] }])
  const r = await run(f.g, ['--yes'])
  assert.equal(f.modifies.length, 0)
  assert.equal(r.out.at(-1), 'archived 0, skipped 1 (changed 1), failed 0')
})

test('--days sets the older_than and newer_than queries', async () => {
  const f = fake([read('a', 10), read('b', 5)])
  const r = await run(f.g, ['--days', '7'])
  assert.deepEqual(f.lists.slice(0, 2).map((l) => l.q), ['in:inbox older_than:7d', 'in:inbox newer_than:7d'])
  assert.deepEqual(r.out.slice(0, 2), ['candidates 1', 'eligible 1'])
})

test('--yes is sequential: one re-check get per thread and never two calls in flight', async () => {
  const f = fake(Array.from({ length: 6 }, (_, i) => read(`t${i}`)))
  const r = await run(f.g, ['--yes'])
  assert.equal(f.gets(), 6)
  assert.equal(f.modifies.length, 6)
  assert.equal(f.maxInFlight(), 1)
  assert.equal(r.out.at(-1), 'archived 6, skipped 0, failed 0')
})

// no window of 60 s may hold more than the per-minute budget plus the bucket's one-call burst
const assertWithinBudget = (events: { t: number, units: number }[], perMinute: number): void => {
  for (const e of events) {
    const spent = events.filter((x) => x.t > e.t - 60_000 && x.t <= e.t).reduce((n, x) => n + x.units, 0)
    assert.ok(spent <= perMinute + 50, `${spent} units in the minute ending at ${e.t}`)
  }
}

// the bucket starts with 50 units and refills at perMinute, so total spend can never outrun that line
const assertCumulative = (events: { t: number, units: number }[], perMinute: number): void => {
  let spent = 0
  for (const e of events) {
    spent += e.units
    assert.ok(spent <= 50 + (e.t - events[0].t) * perMinute / 60_000 + 1e-6, `${spent} units by ${e.t - events[0].t} ms`)
  }
}

test('100 threads with a fake clock stay within the units-per-minute budget', async () => {
  let t = 1_000_000
  const f = fake(Array.from({ length: 100 }, (_, i) => read(`t${i}`)), { clock: () => t })
  const r = await run(f.g, ['--yes'], { clock: () => t, sleep: async (ms) => { t += ms }, unitsPerMinute: 4500 })
  assert.equal(r.out.at(-1), 'archived 100, skipped 0, failed 0')
  assert.equal(f.events.reduce((n, e) => n + e.units, 0), 5000 + 4 * 10 + 10 * (f.created.length + 1))
  assert.ok(t - 1_000_000 >= 60_000)
  assertWithinBudget(f.events, 4500)
})

// a thread's get and modify are reserved together, so they share one instant
const assertPairs = (events: { t: number, units: number }[]): void => {
  const gets = events.flatMap((e, i) => (e.units === 40 ? [i] : []))
  assert.ok(gets.length > 0)
  for (const i of gets) {
    assert.deepEqual(events[i + 1], { t: events[i].t, units: 10 }, `get at ${events[i].t}`)
  }
}

test('with a depleted bucket the 50 units are reserved before the re-check and no sleep separates get from modify', async () => {
  let t = 1_000_000
  const log: string[] = []
  const f = fake(Array.from({ length: 5 }, (_, i) => read(`t${i}`)), { clock: () => t, onGet: () => { log.push('get') } })
  const r = await run(f.g, ['--yes'], { clock: () => t, sleep: async (ms) => { log.push('sleep'); t += ms }, unitsPerMinute: 60 })
  assert.equal(r.out.at(-1), 'archived 5, skipped 0, failed 0')
  assertPairs(f.events)
  assertCumulative(f.events, 60)
  const firstGet = log.indexOf('get')
  assert.equal(log[firstGet - 1], 'sleep')
})

test('every retry attempt is charged, the re-check and the modify alike', async () => {
  let t = 1_000_000
  const f = fake([read('a')], { clock: () => t, throttleFirst: 1 })
  const r = await run(f.g, ['--yes'], { clock: () => t, sleep: async (ms) => { t += ms }, unitsPerMinute: 60 })
  assert.equal(r.out.at(-1), 'archived 1, skipped 0, failed 0')
  assert.equal(f.events.filter((e) => e.units === 40).length, 2)
  assert.equal(f.events.filter((e) => e.units === 10).length, 4 + f.created.length + 1 + 2)
  assertWithinBudget(f.events, 60)
  assertCumulative(f.events, 60)
  assertPairs(f.events)
})

test('a throttled re-check get reserves 40 units per retry and the successful get is still followed by its modify at the same instant', async () => {
  let t = 1_000_000
  const f = fake([read('a')], { clock: () => t, throttleGets: 2 })
  const r = await run(f.g, ['--yes'], { clock: () => t, sleep: async (ms) => { t += ms }, unitsPerMinute: 60 })
  assert.equal(r.out.at(-1), 'archived 1, skipped 0, failed 0')
  const gets = f.events.flatMap((e, i) => (e.units === 40 ? [i] : []))
  assert.equal(gets.length, 3)
  assert.ok(f.events[gets[2]].t > f.events[gets[0]].t + 60_000)
  assert.deepEqual(f.events[gets[2] + 1], { t: f.events[gets[2]].t, units: 10 })
  assertCumulative(f.events, 60)
})

test('the preview estimates eligible x 50 units over the budget, rounded up to minutes', async () => {
  const specs = Array.from({ length: 200 }, (_, i) => read(`t${i}`))
  assert.equal((await run(fake(specs).g, [], { unitsPerMinute: 4500 })).out[2], 'skipped 0')
  assert.equal((await run(fake(specs).g, [], { unitsPerMinute: 4500 })).out[3], 'estimated time 3 min')
  assert.equal((await run(fake(specs).g, [], { unitsPerMinute: 100 })).out[3], 'estimated time 100 min')
})

test('GMAIL_TRIAGE_UNITS_PER_MINUTE must be a positive integer, checked before any Gmail call', async () => {
  const saved = process.env.GMAIL_TRIAGE_UNITS_PER_MINUTE
  try {
    for (const v of ['0', '49', '-5', '1.5', 'abc', '', '1e3']) {
      process.env.GMAIL_TRIAGE_UNITS_PER_MINUTE = v
      const f = fake([read('a')])
      const r = await run(f.g, [])
      assert.equal(r.code, 2, v)
      assert.equal(r.opened(), 0)
      assert.match(r.err.join('\n'), /GMAIL_TRIAGE_UNITS_PER_MINUTE/)
    }
    process.env.GMAIL_TRIAGE_UNITS_PER_MINUTE = '50'
    assert.equal((await run(fake([read('a')]).g, [])).out[3], 'estimated time 1 min')
  } finally {
    if (saved === undefined) {
      delete process.env.GMAIL_TRIAGE_UNITS_PER_MINUTE
    } else {
      process.env.GMAIL_TRIAGE_UNITS_PER_MINUTE = saved
    }
  }
})

test('a thread that vanished before its re-check is skipped as changed, other read errors count as failed', async () => {
  const r = await run(fake([read('a'), read('b')], { getErrors: { b: 404 } }).g, ['--yes'])
  assert.equal(r.out.at(-1), 'archived 1, skipped 1 (changed 1), failed 0')
  const bad = await run(fake([read('a')], { getErrors: { a: 500 } }).g, ['--yes'])
  assert.equal(bad.code, 1)
  assert.equal(bad.out.at(-1), 'archived 0, skipped 0, failed 1')
})

test('paging follows nextPageToken, one page at a time', async () => {
  const f = fake([read('a'), read('b'), read('c')], { pageSize: 2 })
  const r = await run(f.g, [])
  const older = f.lists.filter((l) => l.q?.includes('older_than'))
  assert.equal(older.length, 2)
  assert.equal(older[1].pageToken, '2')
  assert.equal(r.out[0], 'candidates 3')
})

test('more than 20,000 candidates aborts before any other query, get or write', async () => {
  const f = fake([], { override: { older: Array.from({ length: 20_001 }, (_, i) => `t${i}`) } })
  const r = await run(f.g, ['--yes'])
  assert.equal(r.code, 1)
  assert.match(r.err.join('\n'), /more than 20000 threads/)
  assert.equal(f.lists.length, 41)
  assert.equal(f.gets(), 0)
  assert.equal(f.modifies.length, 0)
  const ok = fake([], { override: { older: Array.from({ length: 20_000 }, (_, i) => `t${i}`) } })
  assert.equal((await run(ok.g, [])).err.length, 0)
})

test('unrelated exclusion ids never abort: 1 candidate plus 25,000 unrelated unread ids is still eligible', async () => {
  const f = fake([], { override: { older: ['ok'], newer: Array.from({ length: 25_000 }, (_, i) => `n${i}`), unread: Array.from({ length: 25_000 }, (_, i) => `u${i}`), starred: ['ok2'] } })
  const r = await run(f.g, [])
  assert.equal(r.code, 0)
  assert.deepEqual(r.out.slice(0, 3), ['candidates 1', 'eligible 1', 'skipped 0'])
})

test('an empty candidate set makes exactly one list call and no other query', async () => {
  const f = fake([read('a', 5)])
  const r = await run(f.g, ['--yes'])
  assert.equal(f.lists.length, 1)
  assert.equal(r.out.at(-1), 'archived 0, skipped 0, failed 0')
})

test('--yes sends the exact guarded body, logs before writing, creates the label and leaves state.processed alone', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: { ok: 'm-prior', other: 'm-other' } })
  const f = fake(MIX)
  const r = await run(f.g, ['--yes'])
  assert.equal(r.code, 0)
  assert.ok(f.created.includes('Triage/Archived-old'))
  assert.deepEqual(f.modifies, [{ userId: 'me', id: 'ok', requestBody: { addLabelIds: ['L-Triage/Archived-old'], removeLabelIds: ['INBOX'] } }])
  const log = await readRun('2026-11-16')
  assert.match(log[0].opId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.deepEqual(log.map(({ opId: _o, ...rest }) => rest), [{ kind: 'archiveOld', threadId: 'ok', messageId: 'm-ok', labelId: 'L-Triage/Archived-old' }])
  assert.deepEqual((await loadState()).processed, { ok: 'm-prior', other: 'm-other' })
  assert.equal(r.out.at(-1), 'archived 1, skipped 3 (recent 1, unread 1, starred 1), failed 0')
})

test('the output carries counts only, never ids, subjects or senders', async () => {
  const r = await run(fake(MIX).g, ['--yes'])
  const text = r.out.join('\n') + r.err.join('\n')
  assert.ok(!/m-ok|Label_1|\b(ok|unr|star|reply|out)\b/.test(text), text)
})

test('--yes with nothing eligible writes nothing and creates no label', async () => {
  const f = fake([{ id: 'a', messages: [{ id: 'o', labelIds: ['INBOX'], internalDate: ago(60) }, { id: 'n', labelIds: ['INBOX'], internalDate: ago(5) }] }])
  const r = await run(f.g, ['--yes'])
  assert.equal(r.code, 0)
  assert.equal(f.created.length, 0)
  assert.equal(r.out.at(-1), 'archived 0, skipped 1 (recent 1), failed 0')
})

test('a thread that changed between the preview scan and its re-check is skipped as changed, with no write', async () => {
  const specs = [read('a'), read('b'), read('c'), read('d')]
  const f = fake(specs, { onGet: (id, n) => {
    if (n !== 1) {
      return
    }
    const s = specs.find((x) => x.id === id)!
    if (id === 'a') {
      s.messages.push({ id: 'new', labelIds: ['INBOX'], internalDate: ago(1) })
    } else if (id === 'b') {
      s.messages[0].labelIds = ['INBOX', 'UNREAD']
    } else if (id === 'c') {
      s.messages[0].labelIds = ['Label_1']
    }
  } })
  const r = await run(f.g, ['--yes'])
  assert.deepEqual(f.modifies.map((m) => m.id), ['d'])
  assert.equal(r.out.at(-1), 'archived 1, skipped 3 (changed 3), failed 0')
  assert.deepEqual((await readRun('2026-11-16')).map((e) => e.threadId), ['d'])
  assert.equal(r.code, 0)
})

test('a thread starred before its re-check is skipped as changed', async () => {
  const specs = [read('a')]
  const f = fake(specs, { onGet: (_id, n) => { if (n === 1) { specs[0].messages[0].labelIds = ['INBOX', 'STARRED'] } } })
  const r = await run(f.g, ['--yes'])
  assert.equal(f.modifies.length, 0)
  assert.equal(r.out.at(-1), 'archived 0, skipped 1 (changed 1), failed 0')
})

test('a failed write counts as failed, keeps going and exits 1', async () => {
  const f = fake([read('a'), read('b')], { failModify: ['a'] })
  const r = await run(f.g, ['--yes'])
  assert.equal(r.code, 1)
  assert.deepEqual(f.modifies.map((m) => m.id), ['b'])
  assert.equal(r.out.at(-1), 'archived 1, skipped 0, failed 1')
})

test('an exhausted retry budget stops all further work, reports it and exits 1', async () => {
  const f = fake([read('a'), read('b'), read('c')], { throttleModify: true })
  const r = await run(f.g, ['--yes'], { retryBudgetMs: 5000 })
  assert.equal(r.code, 1)
  assert.equal(f.modifies.length, 0)
  assert.match(r.err.join('\n'), /quota exhausted.*2 not processed/)
  assert.equal(r.out.at(-1), 'archived 0, skipped 0, failed 1')
  assert.deepEqual((await readRun('2026-11-16')).map((e) => e.threadId), ['a'])
})

test('an exhausted budget during the scan aborts with exit 1 and no writes', async () => {
  const f = fake([read('a')])
  const g = { users: { ...f.g.users, threads: { ...f.g.users.threads, list: async () => { throw gaxios(429) } } } } as unknown as GmailLike
  const r = await run(g, ['--yes'], { retryBudgetMs: 5000 })
  assert.equal(r.code, 1)
  assert.match(r.err.join('\n'), /quota exhausted/)
  assert.equal(f.modifies.length, 0)
})

test('--days must be an integer from 1 to 3650 and unknown arguments are refused, before any Gmail call', async () => {
  for (const args of [['--days', '0'], ['--days', '3651'], ['--days', '1.5'], ['--days', 'abc'], ['--days', '-3'], ['--days'], ['--days', '7', '--days', '8'], ['--bogus'], ['30'], ['--days', '1e2']]) {
    const f = fake([read('a')])
    const r = await run(f.g, args)
    assert.equal(r.code, 2, args.join(' '))
    assert.equal(r.opened(), 0)
    assert.equal(f.lists.length, 0)
    assert.match(r.err.join('\n'), /usage/)
  }
  for (const args of [['--days', '1'], ['--days', '3650'], ['--yes', '--days', '30']]) {
    assert.equal((await run(fake([]).g, args)).code, 0, args.join(' '))
  }
})

test('while another run holds the lock it prints already running and reads nothing', async () => {
  const release = await acquireLock()
  assert.notEqual(release, null)
  try {
    const f = fake([read('a')])
    const r = await run(f.g, ['--yes'])
    assert.equal(r.code, 0)
    assert.deepEqual(r.out, ['already running'])
    assert.equal(r.opened(), 0)
    assert.equal(f.lists.length, 0)
    assert.equal(f.gets(), 0)
  } finally {
    await release!()
  }
  assert.notEqual(await acquireLock(), null)
})

test('the lock is released after a run, also when it throws', async () => {
  const f = fake([read('a')])
  const g = { users: { ...f.g.users, threads: { ...f.g.users.threads, list: async () => { throw gaxios(500) } } } } as unknown as GmailLike
  await assert.rejects(run(g, []))
  const release = await acquireLock()
  assert.notEqual(release, null)
  await release!()
})

test('a changed thread leaves no run-log line and no write', async () => {
  const specs = [read('a')]
  const f = fake(specs, { onGet: (_id, n) => { if (n === 1) { specs[0].messages.push({ id: 'new', labelIds: ['INBOX'], internalDate: ago(1) }) } } })
  await run(f.g, ['--yes'])
  assert.equal(f.modifies.length, 0)
  await assert.rejects(readRun('2026-11-16'), /no run log/)
})
