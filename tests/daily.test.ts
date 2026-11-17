import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { failureWhere, runDaily } from '../src/daily.ts'
import type { DailyDeps } from '../src/daily.ts'
import { KeychainError } from '../src/keychain.ts'
import { loadPins } from '../src/pins.ts'
import type { GmailLike } from '../src/run.ts'
import { acquireLock } from '../src/state.ts'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gt-daily-'))
  process.env.GMAIL_TRIAGE_HOME = join(tmp, 'home')
})

const netErr = (code: string): Error => Object.assign(new Error(`getaddrinfo ${code} SECRET-EMAIL-BODY`), { code })
const emptyGmail = (listFailures: Error[] = []): GmailLike => ({
  users: {
    getProfile: async () => ({ data: { emailAddress: 'me@x.com' } }),
    threads: {
      list: async () => {
        const e = listFailures.shift()
        if (e) {
          throw e
        }
        return { data: { threads: [], resultSizeEstimate: 0 } }
      },
      get: async () => ({ data: {} }),
      modify: async () => undefined,
    },
    labels: { list: async () => ({ data: { labels: [] } }), create: async () => ({ data: { id: 'x' } }) },
  },
} as unknown as GmailLike)

const harness = (over: Partial<DailyDeps> = {}) => {
  const published: { file: string, summary: string }[] = []
  const sleeps: number[] = []
  const deps: DailyDeps = {
    gmail: async () => emptyGmail(),
    classify: async () => ({ verdicts: [] }),
    loadPins: async () => ({ neverArchive: [], alwaysUrgent: [] }),
    publish: async (file, summary) => { published.push({ file, summary }) },
    now: () => new Date(2026, 10, 15, 7, 30),
    repo: '/opt/gmail-triage',
    sleep: async (ms) => { sleeps.push(ms) },
    ...over,
  }
  return { deps, published, sleeps }
}

test('ENOTFOUND twice then success: the run proceeds after two 60 s waits', async () => {
  let calls = 0
  const { deps, published, sleeps } = harness({ gmail: async () => { calls++; if (calls < 3) { throw netErr('ENOTFOUND') } return emptyGmail() } })
  assert.equal(await runDaily(deps, { dryRun: true }), 0)
  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [60000, 60000])
  assert.equal(published.length, 1)
  assert.doesNotMatch(readFileSync(published[0].file, 'utf8'), /Run failed/)
})

test('a network error on the first threads.list is retried too', async () => {
  const g = emptyGmail([netErr('ECONNRESET')])
  const { deps, published, sleeps } = harness({ gmail: async () => g })
  assert.equal(await runDaily(deps, { dryRun: true }), 0)
  assert.deepEqual(sleeps, [60000])
  assert.equal(published.length, 1)
})

test('persistent ENOTFOUND: three attempts, error report with the code only, notify called, exit 1', async () => {
  let calls = 0
  const { deps, published, sleeps } = harness({ gmail: async () => { calls++; throw netErr('ENOTFOUND') } })
  assert.equal(await runDaily(deps, { dryRun: false }), 1)
  assert.equal(calls, 3)
  assert.equal(sleeps.length, 2)
  assert.equal(published.length, 1)
  const html = readFileSync(published[0].file, 'utf8')
  assert.match(html, /Run failed: ENOTFOUND/)
  assert.doesNotMatch(html, /SECRET/)
  assert.equal(published[0].summary, 'Run failed: ENOTFOUND')
  assert.doesNotMatch(published[0].summary, /SECRET/)
})

test('a non-network error is not retried and reports its class only', async () => {
  let calls = 0
  const { deps, published, sleeps } = harness({ gmail: async () => { calls++; throw new KeychainError('keychain read failed for SECRET-EMAIL-BODY') } })
  assert.equal(await runDaily(deps, { dryRun: false }), 1)
  assert.equal(calls, 1)
  assert.deepEqual(sleeps, [])
  const html = readFileSync(published[0].file, 'utf8')
  assert.match(html, /Run failed: KeychainError/)
  assert.doesNotMatch(html, /SECRET/)
})

test('a Gaxios HTTP error reports status and reason only', async () => {
  class GaxiosError extends Error {}
  const e = Object.assign(new GaxiosError('Quota exceeded SECRET-EMAIL-BODY'), { response: { status: 403, data: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } } })
  const { deps, published } = harness({ gmail: async () => { throw e } })
  assert.equal(await runDaily(deps, { dryRun: false }), 1)
  const html = readFileSync(published[0].file, 'utf8')
  assert.match(html, /Run failed: GaxiosError 403 rateLimitExceeded/)
  assert.doesNotMatch(html, /SECRET/)
})

test('a pins.json parse error writes an error report and notifies', async () => {
  const bad = join(tmp, 'pins.json')
  writeFileSync(bad, '{ SECRET-EMAIL-BODY')
  const { deps, published } = harness({ loadPins: () => loadPins(bad) })
  assert.equal(await runDaily(deps, { dryRun: false }), 1)
  assert.equal(published.length, 1)
  const html = readFileSync(published[0].file, 'utf8')
  assert.match(html, /Run failed: pins\.json invalid/)
  assert.doesNotMatch(html, /SECRET/)
})

test('an unknown thrown value still yields an error report', async () => {
  const { deps, published } = harness({ gmail: async () => { throw 'SECRET-EMAIL-BODY' } })
  assert.equal(await runDaily(deps, { dryRun: false }), 1)
  assert.match(readFileSync(published[0].file, 'utf8'), /Run failed: Error/)
  assert.doesNotMatch(readFileSync(published[0].file, 'utf8'), /SECRET/)
})

test('lock held: no report, no notification, exit 0', async () => {
  const release = await acquireLock()
  assert.ok(release)
  const { deps, published } = harness()
  assert.equal(await runDaily(deps, { dryRun: false }), 0)
  assert.equal(published.length, 0)
  await release()
})

class GaxiosError extends Error {}
const gaxios = (status: number, reason: string): Error => Object.assign(new GaxiosError('Invalid Credentials SECRET-EMAIL-BODY'), {
  response: { status, data: { error: { errors: [{ reason }] } } },
  config: { method: 'POST', url: 'https://gmail.googleapis.com/gmail/v1/users/me/threads/18c0ffee0000abcd/modify?alt=json' },
})

test('a 401 that escapes runTriage (list, fetch, labels) retries the whole run once after 2 min, with a fresh client', async () => {
  let calls = 0
  const { deps, published, sleeps } = harness({ gmail: async () => { calls++; return calls === 1 ? emptyGmail([gaxios(401, 'authError')]) : emptyGmail() } })
  assert.equal(await runDaily(deps, { dryRun: true }), 0)
  assert.equal(calls, 2)
  assert.deepEqual(sleeps, [120000])
  assert.equal(published.length, 1)
  assert.doesNotMatch(readFileSync(published[0].file, 'utf8'), /Run failed/)
})

test('a 401 on the retry too: one error report, exit 1', async () => {
  const { deps, published, sleeps } = harness({ gmail: async () => emptyGmail([gaxios(401, 'authError')]) })
  assert.equal(await runDaily(deps, { dryRun: false }), 1)
  assert.deepEqual(sleeps, [120000])
  assert.equal(published.length, 1)
  assert.match(readFileSync(published[0].file, 'utf8'), /Run failed: GaxiosError 401 authError/)
})

test('a 403 is not a transient run error: no whole-run retry', async () => {
  const { deps, sleeps } = harness({ gmail: async () => emptyGmail([gaxios(403, 'forbidden')]) })
  assert.equal(await runDaily(deps, { dryRun: false }), 1)
  assert.deepEqual(sleeps, [])
})

test('failureWhere names method and path with ids masked, and nothing for a non-HTTP error', () => {
  assert.equal(failureWhere(gaxios(401, 'authError')), ' (POST /gmail/v1/users/me/threads/:id/modify)')
  assert.equal(failureWhere(new Error('x')), '')
  assert.equal(failureWhere(null), '')
})
