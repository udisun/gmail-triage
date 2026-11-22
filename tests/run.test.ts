import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { exitCodeOf, goLive, runTriage, runUndo } from '../src/run.ts'
import type { Deps, GmailLike } from '../src/run.ts'
import { AuthError } from '../src/gmail.ts'
import { acquireLock, appendRunEntry, loadState, readRun, saveState } from '../src/state.ts'
import type { Bucket, ThreadInput } from '../src/types.ts'

beforeEach(() => {
  process.env.GMAIL_TRIAGE_HOME = mkdtempSync(join(tmpdir(), 'gt-run-'))
})

type Spec = { id: string, from?: string, to?: string, listUnsubscribe?: string, listUnsubscribePost?: string, direct?: boolean, autoSubmitted?: string, earlierHuman?: boolean, subject?: string, at?: string, listId?: string, readMsg?: boolean }

const gaxios = (status: number, reason: string): Error =>
  Object.assign(new Error('Quota exceeded SECRET'), { response: { status, data: { error: { errors: [{ reason }] } } } })

const fakeGmail = (specs: Spec[], opts: { failModify?: string[], newer?: string[], throttleMinimal?: string[], throttleModify?: string[], throttleModifyOnce?: string[], newerAfterModify?: string[], throttleCounts?: boolean, throttleProfile?: boolean, throttleListAfterWrites?: boolean, stallListAfterWrites?: boolean, open?: Record<string, string[]>, failLabels?: boolean, gone?: string[] } = {}) => {
  const modifies: { id: string, requestBody: { addLabelIds: string[], removeLabelIds: string[] } }[] = []
  const counts: string[] = []
  const created: string[] = []
  const reads = { minimal: 0 }
  const attempts: string[] = []
  const thread = (s: Spec) => ({
    id: s.id,
    messages: [...(s.readMsg ? [{ id: `r-${s.id}`, labelIds: ['INBOX'], internalDate: '50', snippet: 'read', payload: { headers: [] } }] : []),...(s.earlierHuman ? [{ id: `h-${s.id}`, labelIds: ['UNREAD', 'INBOX'], internalDate: '500', snippet: 'earlier', payload: { headers: [{ name: 'From', value: 'Jane <jane@y.com>' }, { name: 'To', value: 'me@x.com' }, { name: 'Subject', value: 'earlier' }] } }] : []), {
      id: `m-${s.id}`, labelIds: ['UNREAD', 'INBOX'], internalDate: s.at ?? '1000', snippet: 'snip',
      payload: { headers: [
        { name: 'From', value: s.from ?? `Sender <${s.id}@x.com>` }, { name: 'To', value: s.to ?? (s.direct ? 'me@x.com' : 'list@x.com') }, { name: 'Subject', value: s.subject ?? `subj ${s.id}` },
        { name: 'Date', value: 'Sun, 15 Nov 2026 10:00:00 +0200' }, ...(s.listUnsubscribe ? [{ name: 'List-Unsubscribe', value: s.listUnsubscribe }] : []), ...(s.listUnsubscribePost ? [{ name: 'List-Unsubscribe-Post', value: s.listUnsubscribePost }] : []), ...(s.autoSubmitted ? [{ name: 'Auto-Submitted', value: s.autoSubmitted }] : []), ...(s.listId ? [{ name: 'List-Id', value: s.listId }] : []),
      ] },
    }],
  })
  const g = {
    users: {
      getProfile: async () => {
        if (opts.throttleProfile) {
          throw gaxios(403, 'rateLimitExceeded')
        }
        return { data: { emailAddress: 'me@x.com' } }
      },
      threads: {
        list: async (p: { q?: string, labelIds?: string[] }, o?: { signal?: AbortSignal }) => {
          if (p.labelIds) {
            const name = p.labelIds.find((l) => l !== 'INBOX')!.replace(/^L-/, '')
            return { data: { threads: (opts.open?.[name] ?? []).map((id) => ({ id })) } }
          }
          if (p.q?.startsWith('from:')) {
            counts.push(p.q)
            if (opts.throttleCounts) {
              throw gaxios(403, 'rateLimitExceeded')
            }
            return { data: { resultSizeEstimate: 7 } }
          }
          if (opts.throttleListAfterWrites && modifies.length > 0) {
            throw gaxios(403, 'rateLimitExceeded')
          }
          if (opts.stallListAfterWrites && modifies.length > 0) {
            return await new Promise<never>((_, reject) => o?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
          }
          const archived = new Set(modifies.filter((m) => m.requestBody.removeLabelIds.includes('INBOX')).map((m) => m.id))
          return { data: { threads: specs.filter((s) => !archived.has(s.id)).map((s) => ({ id: s.id })), resultSizeEstimate: specs.length } }
        },
        get: async (p: { id: string, format?: string }) => {
          if (opts.gone?.includes(p.id)) {
            throw gaxios(404, 'notFound')
          }
          if (p.format === 'minimal') {
            reads.minimal++
            if (opts.throttleMinimal?.includes(p.id)) {
              throw gaxios(403, 'rateLimitExceeded')
            }
          }
          const t = thread(specs.find((s) => s.id === p.id)!)
          if (p.format === 'minimal' && (opts.newer?.includes(p.id) || (opts.newerAfterModify?.includes(p.id) && attempts.includes(p.id)))) {
            t.messages.push({ id: `new-${p.id}`, labelIds: ['UNREAD', 'INBOX'], internalDate: '2000', snippet: '', payload: { headers: [] } })
          }
          return { data: t }
        },
        modify: async (p: { id: string, requestBody: { addLabelIds: string[], removeLabelIds: string[] } }) => {
          attempts.push(p.id)
          if (opts.throttleModify?.includes(p.id) || (opts.throttleModifyOnce?.includes(p.id) && attempts.filter((a) => a === p.id).length === 1)) {
            throw gaxios(429, 'rateLimitExceeded')
          }
          if (opts.failModify?.includes(p.id)) {
            throw new Error('boom')
          }
          modifies.push({ id: p.id, requestBody: p.requestBody })
        },
      },
      labels: {
        list: async () => {
          if (opts.failLabels) {
            throw new Error('labels down')
          }
          return { data: { labels: Object.keys(opts.open ?? {}).map((name) => ({ id: `L-${name}`, name })) } }
        },
        create: async (p: { requestBody: { name: string } }) => {
          created.push(p.requestBody.name)
          return { data: { id: `L-${p.requestBody.name}` } }
        },
      },
    },
  } as unknown as GmailLike
  return { g, modifies, counts, created, reads, attempts }
}

const verdictsFor = (map: Record<string, Bucket>) => async (batch: ThreadInput[]): Promise<unknown> => ({
  verdicts: batch.map((t) => ({ id: t.threadId, bucket: map[t.threadId] ?? 'attention', reason: 'because' })),
})

const NOW = new Date(2026, 10, 15, 23, 59)
const mk = (g: GmailLike, classify: Deps['classify'], pins: Deps['pins'] = { neverArchive: [], alwaysUrgent: [] }, extra: Partial<Deps> = {}): Deps => ({ gmail: async () => g, classify, pins, now: () => NOW, repo: '/opt/gmail-triage', ...extra })
const L = (name: string) => `L-Triage/${name}`

test('happy path: three threads, three modify calls with the right bodies', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const { g, modifies } = fakeGmail([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
  const res = await runTriage(mk(g, verdictsFor({ a: 'notifications', b: 'urgent', c: 'attention' })), { dryRun: false })
  assert.ok(res)
  assert.deepEqual(res.failed, [])
  assert.deepEqual(modifies, [
    { id: 'a', requestBody: { addLabelIds: [L('Notifications')], removeLabelIds: ['INBOX'] } },
    { id: 'b', requestBody: { addLabelIds: [L('Urgent'), 'STARRED'], removeLabelIds: [] } },
    { id: 'c', requestBody: { addLabelIds: [L('Attention')], removeLabelIds: [] } },
  ])
  assert.equal(res.reportFile, join(process.env.GMAIL_TRIAGE_HOME!, 'reports', '2026-11-15.html'))
  assert.equal(statSync(res.reportFile).mode & 0o777, 0o600)
  assert.equal(res.input.mode, 'live')
  assert.equal(res.input.rows.length, 3)
  assert.deepEqual((await loadState()).processed, { a: 'm-a', b: 'm-b', c: 'm-c' })
  assert.equal((await readRun('2026-11-15')).length, 3)
})

test('dry state: zero modify calls, zero run-log entries, no processed changes, DRY RUN report', async () => {
  const { g, modifies, created } = fakeGmail([{ id: 'a' }, { id: 'b' }])
  const res = await runTriage(mk(g, verdictsFor({ a: 'receipts', b: 'urgent' })), { dryRun: false })
  assert.ok(res)
  assert.equal(modifies.length, 0)
  assert.equal(created.length, 0)
  assert.equal(existsSync(join(process.env.GMAIL_TRIAGE_HOME!, 'runs', '2026-11-15.jsonl')), false)
  assert.deepEqual((await loadState()).processed, {})
  assert.match(readFileSync(res.reportFile, 'utf8'), /DRY RUN/)
  assert.equal(res.input.rows.length, 2)
})

test('--dry-run flag forces dry even when state is live', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const { g, modifies } = fakeGmail([{ id: 'a' }])
  const res = await runTriage(mk(g, verdictsFor({ a: 'receipts' })), { dryRun: true })
  assert.ok(res)
  assert.equal(modifies.length, 0)
  assert.equal(res.input.mode, 'dry')
})

test('the classifier gets the run pins, so owner and work reach the prompt', async () => {
  const { g } = fakeGmail([{ id: 'a' }])
  const seen: Deps['pins'][] = []
  const pins = { neverArchive: [], alwaysUrgent: [], owner: 'Dana', work: 'Acme' }
  await runTriage(mk(g, async (b, p) => { seen.push(p); return verdictsFor({})(b) }, pins), { dryRun: true })
  assert.deepEqual(seen, [pins])
})

test('45 threads are classified in 3 batches of at most 20', async () => {
  const { g } = fakeGmail(Array.from({ length: 45 }, (_, i) => ({ id: `t${i}` })))
  const sizes: number[] = []
  const classify = async (b: ThreadInput[]): Promise<unknown> => {
    sizes.push(b.length)
    return verdictsFor({})(b)
  }
  await runTriage(mk(g, classify), { dryRun: true })
  assert.deepEqual(sizes, [20, 20, 5])
})

test('classify throwing on batch 2 of 2 makes zero writes and renders an error report without email content', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const specs = Array.from({ length: 60 }, (_, i) => ({ id: `t${i}` }))
  const { g, modifies, created } = fakeGmail(specs)
  let calls = 0
  const classify = async (b: ThreadInput[]): Promise<unknown> => {
    calls++
    if (calls === 2) {
      throw new Error('SECRET-EMAIL-BODY')
    }
    return verdictsFor({})(b)
  }
  const res = await runTriage(mk(g, classify), { dryRun: false })
  assert.ok(res)
  assert.equal(calls, 2)
  assert.equal(modifies.length, 0)
  assert.equal(created.length, 0)
  assert.ok(res.input.error)
  assert.doesNotMatch(res.input.error, /SECRET/)
  assert.deepEqual((await loadState()).processed, {})
  assert.ok(existsSync(res.reportFile))
})

test('a classify failure logs the sanitized first line of the error and keeps it out of the report', async (t) => {
  const log = t.mock.method(console, 'error', () => undefined)
  const { g } = fakeGmail([{ id: 'a' }])
  const res = await runTriage(mk(g, async () => { throw new Error('claude exited with code 1\u001b[31m: first\nSECOND-LINE') }), { dryRun: true })
  assert.ok(res)
  assert.deepEqual(log.mock.calls.map((c) => c.arguments), [['classify failed: claude exited with code 1[31m: first']])
  assert.doesNotMatch(readFileSync(res.reportFile, 'utf8'), /first|SECOND/)
})

test('an error report never overwrites a successful live report of the same day', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const first = fakeGmail([{ id: 'a' }])
  const ok = await runTriage(mk(first.g, verdictsFor({ a: 'receipts' })), { dryRun: false })
  assert.ok(ok)
  const before = readFileSync(ok.reportFile, 'utf8')
  const second = fakeGmail([{ id: 'b' }])
  const bad = await runTriage(mk(second.g, async () => { throw new Error('x') }), { dryRun: false })
  assert.ok(bad)
  assert.equal(bad.reportFile, join(process.env.GMAIL_TRIAGE_HOME!, 'reports', '2026-11-15-error.html'))
  assert.equal(readFileSync(ok.reportFile, 'utf8'), before)
  assert.match(readFileSync(bad.reportFile, 'utf8'), /Classification failed/)
})

test('a live report whose subject fakes the old markers is still not overwritten by an error report', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const first = fakeGmail([{ id: 'a', subject: 'DRY RUN <div class="err">x</div>' }])
  const ok = await runTriage(mk(first.g, verdictsFor({ a: 'receipts' })), { dryRun: false })
  assert.ok(ok)
  const before = readFileSync(ok.reportFile, 'utf8')
  const bad = await runTriage(mk(fakeGmail([{ id: 'b' }]).g, async () => { throw new Error('x') }), { dryRun: false })
  assert.ok(bad)
  assert.equal(bad.reportFile, join(process.env.GMAIL_TRIAGE_HOME!, 'reports', '2026-11-15-error.html'))
  assert.equal(readFileSync(ok.reportFile, 'utf8'), before)
})

test('an existing report with no kind marker is unknown, so an error report goes to the -error file', async () => {
  const file = join(process.env.GMAIL_TRIAGE_HOME!, 'reports', '2026-11-15.html')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '<html><head></head><body>old</body></html>')
  const bad = await runTriage(mk(fakeGmail([{ id: 'b' }]).g, async () => { throw new Error('x') }), { dryRun: false })
  assert.ok(bad)
  assert.equal(bad.reportFile, join(process.env.GMAIL_TRIAGE_HOME!, 'reports', '2026-11-15-error.html'))
  assert.equal(readFileSync(file, 'utf8'), '<html><head></head><body>old</body></html>')
})

test('an error report still replaces a dry report or an earlier error report at the plain path', async () => {
  const { g } = fakeGmail([{ id: 'a' }])
  const dry = await runTriage(mk(g, verdictsFor({ a: 'receipts' })), { dryRun: true })
  const bad = await runTriage(mk(g, async () => { throw new Error('x') }), { dryRun: true })
  assert.ok(dry && bad)
  assert.equal(bad.reportFile, dry.reportFile)
  assert.match(readFileSync(bad.reportFile, 'utf8'), /Classification failed/)
})

test('the report carries an undo command for this repo and the home override', async () => {
  const { g } = fakeGmail([{ id: 'a' }])
  const res = await runTriage(mk(g, verdictsFor({ a: 'receipts' })), { dryRun: true })
  assert.ok(res)
  assert.equal(res.input.repo, '/opt/gmail-triage')
  assert.equal(res.input.home, process.env.GMAIL_TRIAGE_HOME)
})

test('authFailureWritesNothing: AuthError gives an error report mentioning gmail-triage auth', async () => {
  const { modifies } = fakeGmail([])
  const deps: Deps = { gmail: async () => { throw new AuthError('Gmail refresh token is expired or revoked: run gmail-triage auth') }, classify: verdictsFor({}), pins: { neverArchive: [], alwaysUrgent: [] }, now: () => NOW, repo: '/opt/gmail-triage' }
  const res = await runTriage(deps, { dryRun: false })
  assert.ok(res)
  assert.equal(modifies.length, 0)
  assert.match(res.input.error ?? '', /gmail-triage auth/)
  assert.match(readFileSync(res.reportFile, 'utf8'), /gmail-triage auth/)
})

test('an already-processed thread (same messageId) is not sent to classify', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: { a: 'm-a' } })
  const { g, modifies } = fakeGmail([{ id: 'a' }, { id: 'b' }])
  const seen: string[] = []
  const classify = async (b: ThreadInput[]): Promise<unknown> => {
    seen.push(...b.map((t) => t.threadId))
    return verdictsFor({})(b)
  }
  await runTriage(mk(g, classify), { dryRun: false })
  assert.deepEqual(seen, ['b'])
  assert.deepEqual(modifies.map((m) => m.id), ['b'])
})

test('pins.json neverArchive: a nonwork verdict becomes Attention with no INBOX removal', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const { g, modifies } = fakeGmail([{ id: 'a', from: 'Boss <boss@vip.com>' }])
  const res = await runTriage(mk(g, verdictsFor({ a: 'nonwork' }), { neverArchive: ['@vip.com'], alwaysUrgent: [] }), { dryRun: false })
  assert.ok(res)
  assert.deepEqual(modifies, [{ id: 'a', requestBody: { addLabelIds: [L('Attention')], removeLabelIds: [] } }])
})

test('a throwing modify on thread 2 of 3 is reported, threads 1 and 3 are recorded, thread 2 is not processed', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const { g, modifies } = fakeGmail([{ id: 'a' }, { id: 'b' }, { id: 'c' }], { failModify: ['b'] })
  const res = await runTriage(mk(g, verdictsFor({ a: 'receipts', b: 'receipts', c: 'receipts' })), { dryRun: false })
  assert.ok(res)
  assert.deepEqual(res.failed, ['b'])
  assert.deepEqual(modifies.map((m) => m.id), ['a', 'c'])
  assert.deepEqual((await loadState()).processed, { a: 'm-a', c: 'm-c' })
  assert.deepEqual(res.input.rows.map((r) => r.threadId), ['a', 'c'])
})

test('lock held: no report, no Gmail calls', async () => {
  const release = await acquireLock()
  assert.ok(release)
  let called = false
  const deps: Deps = { gmail: async () => { called = true; throw new Error('should not run') }, classify: verdictsFor({}), pins: { neverArchive: [], alwaysUrgent: [] }, now: () => NOW, repo: '/opt/gmail-triage' }
  const res = await runTriage(deps, { dryRun: false })
  assert.equal(res, null)
  assert.equal(called, false)
  assert.equal(existsSync(join(process.env.GMAIL_TRIAGE_HOME!, 'reports')), false)
  await release()
})

test('the lock is released after a run', async () => {
  const { g } = fakeGmail([])
  await runTriage(mk(g, verdictsFor({})), { dryRun: false })
  const again = await acquireLock()
  assert.ok(again)
  await again()
})

test('unsubscribe rows group by lowercased sender: one row, one senderCount30d call', async () => {
  const { g, counts } = fakeGmail([
    { id: 'a', from: 'News <News@Shop.com>', listUnsubscribe: '<https://shop.com/u1>' },
    { id: 'b', from: 'news@shop.com', listUnsubscribe: '<https://shop.com/u2>' },
    { id: 'c', from: 'Other <o@other.com>', listUnsubscribe: '<ftp://nope>' },
  ])
  const res = await runTriage(mk(g, verdictsFor({ a: 'unsubscribe', b: 'unsubscribe', c: 'unsubscribe' })), { dryRun: true })
  assert.ok(res)
  assert.equal(res.input.unsub.length, 1)
  assert.deepEqual(res.input.unsub[0], { sender: 'news@shop.com', count30d: 7, link: { kind: 'https', href: 'https://shop.com/u1' } })
  assert.equal(counts.length, 1)
})

const readUnsub = (date = '2026-11-15'): { sender: string, httpsUrl: string | null, mailto: string | null, oneClick: boolean, threadId: string }[] =>
  JSON.parse(readFileSync(join(process.env.GMAIL_TRIAGE_HOME!, 'unsub', `${date}.json`), 'utf8'))

test('dry run writes the unsub capture (0600 in a 0700 dir) with oneClick per header variant and no snippet', async () => {
  const { g } = fakeGmail([
    { id: 'a', from: 'A <a@one.com>', listUnsubscribe: '<https://one.com/u?t=1>, <mailto:u@one.com>', listUnsubscribePost: 'List-Unsubscribe=One-Click' },
    { id: 'b', from: 'b@two.com', listUnsubscribe: '<https://two.com/u>', listUnsubscribePost: '  list-unsubscribe=one-click \t' },
    { id: 'c', from: 'c@three.com', listUnsubscribe: '<https://three.com/u>', listUnsubscribePost: 'something-else' },
    { id: 'd', from: 'd@four.com', listUnsubscribe: '<https://four.com/u>' },
    { id: 'e', from: 'e@five.com', listUnsubscribe: '<mailto:u@five.com>', listUnsubscribePost: 'List-Unsubscribe=One-Click' },
  ])
  await runTriage(mk(g, verdictsFor({ a: 'unsubscribe', b: 'unsubscribe', c: 'unsubscribe', d: 'unsubscribe', e: 'unsubscribe' })), { dryRun: true })
  const file = join(process.env.GMAIL_TRIAGE_HOME!, 'unsub', '2026-11-15.json')
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(statSync(dirname(file)).mode & 0o777, 0o700)
  const rows = readUnsub()
  assert.deepEqual(rows.map((r) => [r.sender, r.oneClick, r.httpsUrl, r.threadId]), [
    ['a@one.com', true, 'https://one.com/u?t=1', 'a'], ['b@two.com', true, 'https://two.com/u', 'b'], ['c@three.com', false, 'https://three.com/u', 'c'], ['d@four.com', false, 'https://four.com/u', 'd'], ['e@five.com', false, null, 'e'],
  ])
  assert.ok(rows[0].mailto?.includes('u%40one.com') || rows[0].mailto?.includes('u@one.com'))
  assert.equal(rows[4].mailto !== null, true)
  assert.doesNotMatch(readFileSync(file, 'utf8'), /snip/)
})

test('a second run the same day keeps the senders captured earlier', async () => {
  const first = fakeGmail([{ id: 'a', from: 'a@one.com', listUnsubscribe: '<https://one.com/u>' }])
  await runTriage(mk(first.g, verdictsFor({ a: 'unsubscribe' })), { dryRun: true })
  const second = fakeGmail([{ id: 'b', from: 'b@two.com', listUnsubscribe: '<https://two.com/u>' }])
  await runTriage(mk(second.g, verdictsFor({ b: 'unsubscribe' })), { dryRun: true })
  assert.deepEqual(readUnsub().map((r) => r.sender).sort(), ['a@one.com', 'b@two.com'])
})

test('a second run the same day overwrites the report and appends to the same run log', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const first = fakeGmail([{ id: 'a' }])
  await runTriage(mk(first.g, verdictsFor({ a: 'receipts' })), { dryRun: false })
  const second = fakeGmail([{ id: 'b' }])
  const res = await runTriage(mk(second.g, verdictsFor({ b: 'receipts' })), { dryRun: false })
  assert.ok(res)
  assert.deepEqual((await readRun('2026-11-15')).map((e) => e.threadId), ['a', 'b'])
  assert.match(readFileSync(res.reportFile, 'utf8'), /subj b/)
  assert.doesNotMatch(readFileSync(res.reportFile, 'utf8'), /subj a/)
})

test('new mail arriving after classification: no modify, no log entry, no processed change, listed as failed', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const { g, modifies } = fakeGmail([{ id: 'a' }, { id: 'b' }], { newer: ['a'] })
  const res = await runTriage(mk(g, verdictsFor({ a: 'receipts', b: 'receipts' })), { dryRun: false })
  assert.ok(res)
  assert.deepEqual(modifies.map((m) => m.id), ['b'])
  assert.deepEqual((await readRun('2026-11-15')).map((e) => e.threadId), ['b'])
  assert.deepEqual((await loadState()).processed, { b: 'm-b' })
  assert.deepEqual(res.input.failed.map((r) => [r.threadId, r.reason]), [['a', 'new mail arrived']])
  assert.equal(exitCodeOf(res), 0)
  assert.match(readFileSync(res.reportFile, 'utf8'), /Failed — still in inbox/)
})

test('a partial failure lists the thread in the HTML and exits 1', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const { g } = fakeGmail([{ id: 'a' }, { id: 'b' }], { failModify: ['b'] })
  const res = await runTriage(mk(g, verdictsFor({ a: 'receipts', b: 'receipts' })), { dryRun: false })
  assert.ok(res)
  const html = readFileSync(res.reportFile, 'utf8')
  assert.match(html, /subj b/)
  assert.match(html, /gmail write failed/)
  assert.equal(exitCodeOf(res), 1)
})

test('total failure (error report) exits 1; success and lock-held exit 0', async () => {
  const deps: Deps = { gmail: async () => { throw new AuthError('x: run gmail-triage auth') }, classify: verdictsFor({}), pins: { neverArchive: [], alwaysUrgent: [] }, now: () => NOW, repo: '/opt/gmail-triage' }
  assert.equal(exitCodeOf(await runTriage(deps, { dryRun: false })), 1)
  const { g } = fakeGmail([{ id: 'a' }])
  assert.equal(exitCodeOf(await runTriage(mk(g, verdictsFor({})), { dryRun: true })), 0)
  assert.equal(exitCodeOf(null), 0)
})

test('300 processed threads ahead of 5 unprocessed: the 5 are classified', async () => {
  const processed: Record<string, string> = {}
  const specs: Spec[] = []
  for (let i = 0; i < 305; i++) {
    specs.push({ id: `t${i}` })
    if (i < 300) {
      processed[`t${i}`] = `m-t${i}`
    }
  }
  await saveState({ mode: 'dry', artifactUrl: null, processed })
  const { g } = fakeGmail(specs)
  const seen: string[] = []
  const classify = async (b: ThreadInput[]): Promise<unknown> => {
    seen.push(...b.map((t) => t.threadId))
    return verdictsFor({})(b)
  }
  const res = await runTriage(mk(g, classify), { dryRun: true })
  assert.ok(res)
  assert.deepEqual(seen, ['t300', 't301', 't302', 't303', 't304'])
  assert.deepEqual(res.input.inbox, { total: 305, keptToday: 0, keptEarlier: 300, toTriage: 5, capped: false })
})

const archiveAll = async (b: ThreadInput[]): Promise<unknown> => ({ verdicts: b.map((t) => ({ id: t.threadId, bucket: 'receipts', reason: 'r' })) })

test('a throttled inbox count after the writes leaves every write applied, the split unknown and the exit code 0', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const specs: Spec[] = Array.from({ length: 302 }, (_, i) => ({ id: `t${i}` }))
  const { g, modifies } = fakeGmail(specs, { throttleListAfterWrites: true })
  const res = await runTriage(mk(g, verdictsFor({}), undefined, { sleep: async () => {} }), { dryRun: false })
  assert.ok(res)
  assert.equal(modifies.length, 300)
  assert.equal(res.input.inbox, null)
  assert.equal(res.quotaExhausted, false)
  assert.equal(exitCodeOf(res), 0)
  assert.match(readFileSync(res.reportFile, 'utf8'), /unknown unread in inbox now — counts unavailable; run again to finish/)
})

test('a stalled inbox count is cut off at the deadline: unknown split, report written, lock released', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const { g, modifies } = fakeGmail([{ id: 'a' }, { id: 'b' }], { stallListAfterWrites: true })
  const t0 = Date.now()
  const res = await runTriage(mk(g, archiveAll, undefined, { countDeadlineMs: 50 }), { dryRun: false })
  assert.ok(res)
  assert.ok(Date.now() - t0 < 5000)
  assert.equal(modifies.length, 2)
  assert.equal(res.input.inbox, null)
  assert.equal(exitCodeOf(res), 0)
  const release = await acquireLock()
  assert.ok(release)
  await release()
})

test('a capped inbox listing renders every figure as a floor', async () => {
  const specs: Spec[] = Array.from({ length: 5400 }, (_, i) => ({ id: `t${i}` }))
  const { g } = fakeGmail(specs)
  const res = await runTriage(mk(g, archiveAll), { dryRun: true })
  assert.ok(res)
  assert.deepEqual(res.input.inbox, { total: 5000, keptToday: 0, keptEarlier: 0, toTriage: 5000, capped: true })
  assert.match(readFileSync(res.reportFile, 'utf8'), /5000\+ unread in inbox now: 0\+ kept today · 0\+ kept earlier · 5000\+ still to triage \(dry run: nothing changed\) — run again/)
})

test('a dry run counts the real inbox and keeps the projection on its own line', async () => {
  const specs: Spec[] = Array.from({ length: 300 }, (_, i) => ({ id: `t${i}` }))
  const { g, modifies } = fakeGmail(specs)
  const res = await runTriage(mk(g, archiveAll), { dryRun: true })
  assert.ok(res)
  assert.equal(modifies.length, 0)
  assert.deepEqual(res.input.inbox, { total: 300, keptToday: 0, keptEarlier: 0, toTriage: 300, capped: false })
  assert.deepEqual(res.input.ifLive, { archive: 300, duplicates: 0, keep: 0 })
  const html = readFileSync(res.reportFile, 'utf8')
  assert.match(html, /300 unread in inbox now: 0 kept today · 0 kept earlier · 300 still to triage \(dry run: nothing changed\)/)
  assert.match(html, /If live: would archive 300 \(incl\. 0 older duplicates\), keep 0/)
})

test('a live run has no projection line', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const { g } = fakeGmail([{ id: 'a' }])
  const res = await runTriage(mk(g, archiveAll), { dryRun: false })
  assert.ok(res)
  assert.equal(res.input.ifLive, null)
  assert.doesNotMatch(readFileSync(res.reportFile, 'utf8'), /If live/)
})

test('a reply on a historical thread beyond the cap lands in kept earlier, never hidden as zero', async () => {
  const specs: Spec[] = Array.from({ length: 300 }, (_, i) => ({ id: `t${i}` }))
  specs.push({ id: 'h1' })
  await saveState({ mode: 'dry', artifactUrl: null, processed: { h1: 'm-old' } })
  const { g } = fakeGmail(specs)
  const res = await runTriage(mk(g, archiveAll), { dryRun: true })
  assert.ok(res)
  assert.deepEqual(res.input.inbox, { total: 301, keptToday: 0, keptEarlier: 1, toTriage: 300, capped: false })
  assert.match(readFileSync(res.reportFile, 'utf8'), /301 unread in inbox now: 0 kept today · 1 kept earlier · 300 still to triage \(dry run: nothing changed\)/)
})

test('a failed write lands in still-to-triage and a reply caught by the recheck is not hidden', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const { g } = fakeGmail([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'u', direct: true }], { failModify: ['b'], newer: ['c'] })
  const res = await runTriage(mk(g, async (b) => ({ verdicts: b.map((t) => ({ id: t.threadId, bucket: t.threadId === 'u' ? 'urgent' : 'receipts', reason: 'r' })) })), { dryRun: false })
  assert.ok(res)
  assert.deepEqual(res.input.inbox, { total: 3, keptToday: 1, keptEarlier: 0, toTriage: 2, capped: false })
  assert.match(readFileSync(res.reportFile, 'utf8'), /3 unread in inbox now: 1 kept today · 0 kept earlier · 2 still to triage — run again or wait for tomorrow's run/)
})

test('undo and go-live take the run lock: held lock means no work, free lock means work and release', async () => {
  const release = await acquireLock()
  assert.ok(release)
  let called = false
  const gm = async (): Promise<GmailLike> => { called = true; throw new Error('should not run') }
  assert.equal(await runUndo(gm, '2026-11-15'), null)
  assert.equal(await goLive(), null)
  assert.equal(called, false)
  assert.equal((await loadState()).mode, 'dry')
  await release()

  await appendRunEntry('2026-11-15', { threadId: 'a', messageId: 'm-a', bucket: 'receipts', labelId: 'L1', starred: false, archived: true })
  const { g, modifies } = fakeGmail([])
  assert.deepEqual(await runUndo(async () => g, '2026-11-15'), { restored: 1, skipped: 0, superseded: 0 })
  assert.equal(modifies.length, 1)
  assert.equal(await goLive(), true)
  assert.equal((await loadState()).mode, 'live')
  const again = await acquireLock()
  assert.ok(again)
  await again()
})

const sleepLog = () => {
  const sleeps: number[] = []
  return { sleeps, sleep: async (ms: number) => { sleeps.push(ms) }, total: () => sleeps.reduce((a, b) => a + b, 0) }
}
const ids = (n: number, prefix = 't'): Spec[] => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }))

test('sustained throttling on every pre-write check across 5 threads stays under the sleep budget and still reports', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const specs = ids(5)
  const { g, modifies } = fakeGmail(specs, { throttleMinimal: specs.map((s) => s.id) })
  const { sleep, total } = sleepLog()
  const res = await runTriage(mk(g, verdictsFor({}), undefined, { sleep }), { dryRun: false })
  assert.ok(res)
  assert.ok(total() <= 600_000)
  assert.equal(modifies.length, 0)
  assert.equal(res.input.failed.length, 5)
  assert.equal(exitCodeOf(res), 1)
  assert.ok(existsSync(res.reportFile))
})

test('quota exhaustion mid-run stops all further reads, fails the rest as "gmail quota exhausted", and exits 1', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const specs = ids(12)
  const { g, modifies, reads } = fakeGmail(specs, { throttleMinimal: specs.map((s) => s.id) })
  const { sleep, total } = sleepLog()
  const res = await runTriage(mk(g, verdictsFor({}), undefined, { sleep }), { dryRun: false })
  assert.ok(res)
  assert.ok(total() <= 600_000)
  assert.equal(modifies.length, 0)
  assert.equal(res.input.failed.length, 12)
  assert.equal(res.failed.length, 12)
  const quota = res.input.failed.filter((r) => r.reason === 'gmail quota exhausted')
  assert.ok(quota.length >= 1)
  assert.deepEqual(res.input.failed.slice(-quota.length), quota)
  assert.ok(reads.minimal < 12 * 6)
  assert.equal(exitCodeOf(res), 1)
  assert.match(readFileSync(res.reportFile, 'utf8'), /gmail quota exhausted/)
})

test('threads processed before exhaustion stay processed, and sender counts are skipped without sleeping', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const specs: Spec[] = [{ id: 'u0', from: 'News <n@shop.com>', listUnsubscribe: '<https://shop.com/u>' }, ...ids(12)]
  const { g, modifies, counts } = fakeGmail(specs, { throttleMinimal: specs.slice(1).map((s) => s.id) })
  const { sleep } = sleepLog()
  const res = await runTriage(mk(g, verdictsFor({ u0: 'unsubscribe' }), undefined, { sleep }), { dryRun: false })
  assert.ok(res)
  assert.deepEqual(modifies.map((m) => m.id), ['u0'])
  assert.deepEqual((await loadState()).processed, { u0: 'm-u0' })
  assert.equal(counts.length, 0)
  assert.equal(res.input.unsub[0].count30d, null)
  assert.equal(res.input.failed.length, 12)
})

test('a dry run whose sender counts exhaust the budget reports n/a, skips the rest, and exits 1', async () => {
  const specs: Spec[] = Array.from({ length: 14 }, (_, i) => ({ id: `s${i}`, from: `n${i}@shop${i}.com`, listUnsubscribe: `<https://shop${i}.com/u>` }))
  const { g, counts } = fakeGmail(specs, { throttleCounts: true })
  const { sleep, total } = sleepLog()
  const res = await runTriage(mk(g, verdictsFor(Object.fromEntries(specs.map((s) => [s.id, 'unsubscribe']))), undefined, { sleep }), { dryRun: true })
  assert.ok(res)
  assert.ok(total() <= 600_000)
  assert.ok(counts.length < 14 * 6)
  assert.equal(res.input.unsub.length, 14)
  assert.ok(res.input.unsub.every((u) => u.count30d === null))
  assert.equal(res.input.error, null)
  assert.equal(res.quotaExhausted, true)
  assert.equal(exitCodeOf(res), 1)
  assert.ok(existsSync(res.reportFile))
})

test('quota exhausted before any mail was read: error report, zero writes', async () => {
  const { g, modifies } = fakeGmail([{ id: 'a' }], { throttleProfile: true })
  const { sleep } = sleepLog()
  const res = await runTriage(mk(g, verdictsFor({}), undefined, { sleep, retryBudgetMs: 0 }), { dryRun: true })
  assert.ok(res)
  assert.equal(modifies.length, 0)
  assert.match(res.input.error ?? '', /quota exhausted/)
  assert.equal(exitCodeOf(res), 1)
  assert.ok(existsSync(res.reportFile))
})

test('a rate-limited threads.modify is retried once with the same body and the thread is processed', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const { g, modifies, attempts } = fakeGmail([{ id: 'a' }], { throttleModifyOnce: ['a'] })
  const { sleep, sleeps } = sleepLog()
  const res = await runTriage(mk(g, verdictsFor({ a: 'receipts' }), undefined, { sleep }), { dryRun: false })
  assert.ok(res)
  assert.deepEqual(attempts, ['a', 'a'])
  assert.equal(sleeps.length, 1)
  assert.deepEqual(modifies, [{ id: 'a', requestBody: { addLabelIds: [L('Receipts')], removeLabelIds: ['INBOX'] } }])
  assert.deepEqual((await loadState()).processed, { a: 'm-a' })
  assert.deepEqual(res.failed, [])
})

test('sustained write throttling exhausts the budget: later threads get no modify call and fail as quota exhausted', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const specs = ids(12)
  const { g, modifies, attempts } = fakeGmail(specs, { throttleModify: specs.map((s) => s.id) })
  const { sleep, total } = sleepLog()
  const res = await runTriage(mk(g, verdictsFor(Object.fromEntries(specs.map((s) => [s.id, 'receipts']))), undefined, { sleep }), { dryRun: false })
  assert.ok(res)
  assert.ok(total() <= 600_000)
  assert.equal(modifies.length, 0)
  assert.ok(attempts.length < 12 * 6)
  assert.equal(res.input.failed.length, 12)
  assert.equal(res.input.failed.at(-1)?.reason, 'gmail quota exhausted')
  assert.equal(exitCodeOf(res), 1)
  assert.ok(existsSync(res.reportFile))
})

test('runUndo retries a rate-limited modify with its own budget', async () => {
  await appendRunEntry('2026-11-15', { threadId: 'a', messageId: 'm-a', bucket: 'receipts', labelId: 'L1', starred: false, archived: true })
  const { g, modifies, attempts } = fakeGmail([], { throttleModifyOnce: ['a'] })
  const { sleep, sleeps } = sleepLog()
  assert.deepEqual(await runUndo(async () => g, '2026-11-15', sleep), { restored: 1, skipped: 0, superseded: 0 })
  assert.deepEqual(attempts, ['a', 'a'])
  assert.equal(sleeps.length, 1)
  assert.equal(modifies.length, 1)
})

test('the model says nonwork for a direct human mail: no INBOX removal, Attention label, reason notes the floor', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const { g, modifies } = fakeGmail([{ id: 'a', direct: true }, { id: 'b' }])
  const res = await runTriage(mk(g, verdictsFor({ a: 'nonwork', b: 'nonwork' })), { dryRun: false })
  assert.ok(res)
  assert.deepEqual(modifies, [
    { id: 'a', requestBody: { addLabelIds: [L('Attention')], removeLabelIds: [] } },
    { id: 'b', requestBody: { addLabelIds: [L('Nonwork')], removeLabelIds: ['INBOX'] } },
  ])
  assert.equal(res.input.keptByFloor, 1)
  assert.deepEqual(res.input.inbox, { total: 1, keptToday: 1, keptEarlier: 0, toTriage: 0, capped: false })
  assert.deepEqual(res.input.rows.map((r) => [r.bucket, r.reason]), [['attention', 'because (kept: direct mail)'], ['nonwork', 'because']])
  assert.match(readFileSync(res.reportFile, 'utf8'), /1 kept in inbox by direct-mail rule/)
})

test('an automated direct mail is archived while a human direct mail is kept', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const { g, modifies } = fakeGmail([{ id: 'a', direct: true }, { id: 'b', direct: true, autoSubmitted: 'auto-generated' }])
  const res = await runTriage(mk(g, verdictsFor({ a: 'nonwork', b: 'nonwork' })), { dryRun: false })
  assert.ok(res)
  assert.deepEqual(modifies, [
    { id: 'a', requestBody: { addLabelIds: [L('Attention')], removeLabelIds: [] } },
    { id: 'b', requestBody: { addLabelIds: [L('Nonwork')], removeLabelIds: ['INBOX'] } },
  ])
  assert.equal(res.input.keptByFloor, 1)
})

test('an unread human direct mail followed by an automated reply keeps the whole thread', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const { g, modifies } = fakeGmail([{ id: 'a', direct: true, earlierHuman: true, autoSubmitted: 'auto-generated' }])
  const res = await runTriage(mk(g, verdictsFor({ a: 'nonwork' })), { dryRun: false })
  assert.ok(res)
  assert.deepEqual(modifies, [{ id: 'a', requestBody: { addLabelIds: [L('Attention')], removeLabelIds: [] } }])
})

test('the floor also applies in a dry run, so the report shows the real outcome', async () => {
  const { g } = fakeGmail([{ id: 'a', direct: true }, { id: 'b', direct: true, listUnsubscribe: '<https://x.com/u>' }])
  const res = await runTriage(mk(g, verdictsFor({ a: 'receipts', b: 'receipts' })), { dryRun: true })
  assert.ok(res)
  assert.deepEqual(res.input.rows.map((r) => r.bucket), ['attention', 'receipts'])
  assert.equal(res.input.keptByFloor, 1)
})

test('the floor runs after pins: an alwaysUrgent pin still wins', async () => {
  const { g } = fakeGmail([{ id: 'a', direct: true, from: 'Boss <boss@vip.com>' }])
  const res = await runTriage(mk(g, verdictsFor({ a: 'nonwork' }), { neverArchive: [], alwaysUrgent: ['@vip.com'] }), { dryRun: true })
  assert.ok(res)
  assert.deepEqual([res.input.rows[0].bucket, res.input.keptByFloor], ['urgent', 0])
})

test('a rate-limited modify followed by a newer message: one modify attempt, thread unprocessed, "new mail arrived"', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const { g, modifies, attempts } = fakeGmail([{ id: 'a' }, { id: 'b' }], { throttleModifyOnce: ['a'], newerAfterModify: ['a'] })
  const { sleep } = sleepLog()
  const res = await runTriage(mk(g, verdictsFor({ a: 'receipts', b: 'receipts' }), undefined, { sleep }), { dryRun: false })
  assert.ok(res)
  assert.deepEqual(attempts.filter((x) => x === 'a'), ['a'])
  assert.deepEqual(modifies.map((m) => m.id), ['b'])
  assert.deepEqual((await loadState()).processed, { b: 'm-b' })
  assert.deepEqual(res.input.failed.map((r) => [r.threadId, r.reason]), [['a', 'new mail arrived']])
})

test('end to end from raw headers: a plus-address alias in a quoted-comma To list keeps the mail in the inbox', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const { g, modifies } = fakeGmail([
    { id: 'a', to: '"Doe, Jane" <jane@x.com>, Me <ME+partner@x.com>' },
    { id: 'b', to: 'work@corp.com' },
    { id: 'c', to: 'Other <other@x.com>' },
  ])
  const res = await runTriage(mk(g, verdictsFor({ a: 'nonwork', b: 'nonwork', c: 'nonwork' }), { neverArchive: [], alwaysUrgent: [], myAddresses: ['Work@Corp.com'] }), { dryRun: false })
  assert.ok(res)
  assert.deepEqual(modifies.map((m) => [m.id, m.requestBody.removeLabelIds]), [['a', []], ['b', []], ['c', ['INBOX']]])
  assert.equal(res.input.keptByFloor, 2)
})

const DIGEST = { from: 'Datadog <digest@dtdg.co>', subject: 'Weekly digest', autoSubmitted: 'auto-generated' }
const DUP = 'L-Triage/Duplicate'
const classifyIds = (seen: string[][]) => async (b: ThreadInput[]): Promise<unknown> => {
  seen.push(b.map((t) => t.threadId))
  return verdictsFor({ n: 'notifications' })(b)
}

test('3 copies: one classify input, the newest triaged, two older copies deduped with the exact bodies', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const { g, modifies } = fakeGmail([{ id: 'a', at: '100', ...DIGEST }, { id: 'n', at: '900', ...DIGEST }, { id: 'c', at: '500', ...DIGEST }])
  const seen: string[][] = []
  const res = await runTriage(mk(g, classifyIds(seen)), { dryRun: false })
  assert.ok(res)
  assert.deepEqual(seen, [['n']])
  assert.deepEqual(modifies, [
    { id: 'n', requestBody: { addLabelIds: [L('Notifications')], removeLabelIds: ['INBOX'] } },
    { id: 'c', requestBody: { addLabelIds: [DUP], removeLabelIds: ['UNREAD', 'INBOX'] } },
    { id: 'a', requestBody: { addLabelIds: [DUP], removeLabelIds: ['UNREAD', 'INBOX'] } },
  ])
  assert.deepEqual(res.failed, [])
  const log = await readRun('2026-11-15')
  assert.equal(new Set(log.map((x) => x.opId)).size, 3)
  assert.ok(log.every((x) => /^[0-9a-f-]{36}$/.test(x.opId ?? '')))
  assert.deepEqual(log.map(({ opId: _o, ...rest }) => rest), [
    { threadId: 'n', messageId: 'm-n', bucket: 'notifications', labelId: L('Notifications'), starred: false, archived: true },
    { kind: 'dedupe', threadId: 'c', messageId: 'm-c', labelId: DUP },
    { kind: 'dedupe', threadId: 'a', messageId: 'm-a', labelId: DUP },
  ])
  assert.deepEqual((await loadState()).processed, { n: 'm-n', c: 'm-c', a: 'm-a' })
  assert.deepEqual(res.input.dupes, [{ threadId: 'n', from: DIGEST.from, subject: DIGEST.subject, older: 2 }])
  assert.equal(res.input.dupArchived, 2)
  assert.equal(res.input.dupProtected, 0)
  assert.equal(res.input.inbox?.total, 0)
  assert.equal(res.input.rows.length, 1)
  const html = readFileSync(res.reportFile, 'utf8')
  assert.ok(html.includes('Duplicates collapsed') && html.includes('2 older duplicates archived'))
})

test('dry run: older copies are grouped and reported, with zero writes and zero log entries', async () => {
  const { g, modifies, created } = fakeGmail([{ id: 'a', at: '100', ...DIGEST }, { id: 'n', at: '900', ...DIGEST }, { id: 'c', at: '500', ...DIGEST }])
  const seen: string[][] = []
  const res = await runTriage(mk(g, classifyIds(seen)), { dryRun: true })
  assert.ok(res)
  assert.deepEqual(seen, [['n']])
  assert.equal(modifies.length, 0)
  assert.equal(created.length, 0)
  assert.equal(existsSync(join(process.env.GMAIL_TRIAGE_HOME!, 'runs', '2026-11-15.jsonl')), false)
  assert.deepEqual(res.input.dupes, [{ threadId: 'n', from: DIGEST.from, subject: DIGEST.subject, older: 2 }])
  assert.match(readFileSync(res.reportFile, 'utf8'), /would archive 2 older duplicates/)
})

test('an older copy that got new mail after fetch is skipped: no modify, no log entry, listed as new mail arrived', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const { g, modifies } = fakeGmail([{ id: 'a', at: '100', ...DIGEST }, { id: 'n', at: '900', ...DIGEST }, { id: 'c', at: '500', ...DIGEST }], { newer: ['a'] })
  const res = await runTriage(mk(g, classifyIds([])), { dryRun: false })
  assert.ok(res)
  assert.deepEqual(modifies.map((m) => m.id), ['n', 'c'])
  assert.deepEqual(res.input.failed.map((r) => [r.threadId, r.reason]), [['a', 'new mail arrived']])
  assert.deepEqual((await readRun('2026-11-15')).map((e) => e.threadId), ['n', 'c'])
  assert.equal((await loadState()).processed.a, undefined)
  assert.equal(res.input.dupArchived, 1)
  assert.deepEqual(res.input.dupes.map((d) => d.older), [1])
})

test('an older copy with unread direct human mail is left untouched: not classified, no write, no log, no marker, counted in the report', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const { g, modifies } = fakeGmail([{ id: 'a', at: '700', earlierHuman: true, ...DIGEST }, { id: 'n', at: '900', ...DIGEST }])
  const seen: string[][] = []
  const res = await runTriage(mk(g, classifyIds(seen)), { dryRun: false })
  assert.ok(res)
  assert.deepEqual(seen, [['n']])
  assert.deepEqual(modifies.map((m) => m.id), ['n'])
  assert.deepEqual((await readRun('2026-11-15')).map((e) => e.threadId), ['n'])
  assert.deepEqual((await loadState()).processed, { n: 'm-n' })
  assert.deepEqual(res.input.dupes, [])
  assert.equal(res.input.dupProtected, 1)
  assert.deepEqual(res.input.inbox, { total: 1, keptToday: 1, keptEarlier: 0, toTriage: 0, capped: false })
  assert.match(readFileSync(res.reportFile, 'utf8'), /1 older copy left in inbox \(direct mail\)/)
})

test('pinned senders are never collapsed: all copies are classified, pins apply, none is deduped', async () => {
  for (const pins of [{ neverArchive: ['digest@dtdg.co'], alwaysUrgent: [] }, { neverArchive: [], alwaysUrgent: ['@dtdg.co'] }]) {
    process.env.GMAIL_TRIAGE_HOME = mkdtempSync(join(tmpdir(), 'gt-run-'))
    await saveState({ mode: 'live', artifactUrl: null, processed: {} })
    const { g, modifies } = fakeGmail([{ id: 'a', at: '100', ...DIGEST }, { id: 'n', at: '900', ...DIGEST }, { id: 'c', at: '500', ...DIGEST }])
    const seen: string[][] = []
    const res = await runTriage(mk(g, classifyIds(seen), pins), { dryRun: false })
    assert.ok(res)
    assert.deepEqual(seen, [['a', 'n', 'c']])
    assert.equal(modifies.length, 3)
    assert.ok(modifies.every((m) => !m.requestBody.addLabelIds.includes(DUP) && !m.requestBody.removeLabelIds.includes('UNREAD')))
    assert.deepEqual(res.input.dupes, [])
  }
})

test('an older thread with an already-read message is classified normally, never collapsed', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const { g, modifies } = fakeGmail([{ id: 'a', at: '100', readMsg: true, ...DIGEST }, { id: 'n', at: '900', ...DIGEST }])
  const seen: string[][] = []
  const res = await runTriage(mk(g, classifyIds(seen)), { dryRun: false })
  assert.ok(res)
  assert.deepEqual(seen, [['a', 'n']])
  assert.ok(modifies.every((m) => !m.requestBody.removeLabelIds.includes('UNREAD')))
  assert.deepEqual(res.input.dupes, [])
})

test('human-looking mail with the same sender and subject is never collapsed; list mail is', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const human = fakeGmail([{ id: 'a', at: '100', from: 'Jane <jane@y.com>', subject: 'Hi' }, { id: 'b', at: '200', from: 'Jane <jane@y.com>', subject: 'Hi' }])
  const seen: string[][] = []
  const res = await runTriage(mk(human.g, classifyIds(seen)), { dryRun: false })
  assert.ok(res)
  assert.deepEqual(seen, [['a', 'b']])
  assert.ok(human.modifies.every((m) => !m.requestBody.removeLabelIds.includes('UNREAD')))
  process.env.GMAIL_TRIAGE_HOME = mkdtempSync(join(tmpdir(), 'gt-run-'))
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const list = fakeGmail([{ id: 'a', at: '100', from: 'Jane <jane@y.com>', subject: 'Hi', listId: '<l.y.com>' }, { id: 'b', at: '200', from: 'Jane <jane@y.com>', subject: 'Hi', listId: '<l.y.com>' }])
  const seen2: string[][] = []
  await runTriage(mk(list.g, classifyIds(seen2)), { dryRun: false })
  assert.deepEqual(seen2, [['b']])
})

test('a failed dedupe write is reported as failed and the run goes on', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const { g, modifies } = fakeGmail([{ id: 'a', at: '100', ...DIGEST }, { id: 'n', at: '900', ...DIGEST }, { id: 'c', at: '500', ...DIGEST }], { failModify: ['c'] })
  const res = await runTriage(mk(g, classifyIds([])), { dryRun: false })
  assert.ok(res)
  assert.deepEqual(res.failed, ['c'])
  assert.deepEqual(modifies.map((m) => m.id), ['n', 'a'])
  assert.deepEqual(res.input.failed.map((r) => [r.threadId, r.reason]), [['c', 'gmail write failed']])
  assert.equal(res.input.dupArchived, 1)
})

test('report lists urgent and attention threads kept by earlier runs and still in the inbox, aged from their last mail', async () => {
  const day = 86_400_000
  await saveState({ mode: 'live', artifactUrl: null, processed: { old: 'm-old', older: 'm-older' } })
  const { g } = fakeGmail([{ id: 'a' }, { id: 'old', at: String(NOW.getTime() - 3 * day) }, { id: 'older', at: String(NOW.getTime() - 9 * day) }], { open: { 'Triage/Urgent': ['old'], 'Triage/Attention': ['older'] } })
  const res = await runTriage(mk(g, verdictsFor({ a: 'urgent' })), { dryRun: false })
  assert.ok(res)
  assert.deepEqual(res.input.open, {
    urgent: { total: 1, rows: [{ threadId: 'old', from: 'Sender <old@x.com>', subject: 'subj old', ageDays: 3 }] },
    attention: { total: 1, rows: [{ threadId: 'older', from: 'Sender <older@x.com>', subject: 'subj older', ageDays: 9 }] },
  })
  const html = readFileSync(res.reportFile, 'utf8')
  assert.ok(html.includes('subj a') && html.includes('subj old') && html.includes('3d ago') && html.includes('9d ago'))
})

test('a failed open-thread lookup leaves open null and still writes the report', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const { g } = fakeGmail([{ id: 'a' }], { failLabels: true })
  // dry run: no ensureLabels, so only the open-thread lookup meets the labels outage
  const res = await runTriage(mk(g, verdictsFor({ a: 'urgent' })), { dryRun: true })
  assert.ok(res)
  assert.equal(res.input.error, null)
  assert.equal(res.input.rows.length, 1)
  assert.equal(res.input.open, null)
  assert.ok(readFileSync(res.reportFile, 'utf8').includes('unavailable this run'))
})

test('open lookup: a thread on both labels counts once, under urgent; a thread deleted mid-lookup is skipped, not fatal', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: { u: 'm-u', both: 'm-both', x: 'm-x' } })
  const { g } = fakeGmail([{ id: 'u' }, { id: 'both' }, { id: 'x' }], { open: { 'Triage/Urgent': ['both', 'gone1', 'u'], 'Triage/Attention': ['both', 'x'] }, gone: ['gone1'] })
  const res = await runTriage(mk(g, verdictsFor({})), { dryRun: false })
  assert.ok(res?.input.open)
  assert.deepEqual(res.input.open.urgent.rows.map((r) => r.threadId), ['both', 'u'])
  assert.equal(res.input.open.urgent.total, 3)
  assert.deepEqual(res.input.open.attention.rows.map((r) => r.threadId), ['x'])
  assert.equal(res.input.open.attention.total, 1)
})
