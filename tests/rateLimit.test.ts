import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { gmail_v1 } from 'googleapis'
import { fetchUnreadThreads } from '../src/gmail.ts'
import { createRetryBudget, QuotaExhaustedError, withRateLimitRetry } from '../src/retry.ts'

const gaxios = (status: number, reason?: string): Error =>
  Object.assign(new Error('Quota exceeded SECRET'), { response: { status, data: { error: { errors: reason ? [{ reason }] : [] } } } })

const harness = () => {
  const sleeps: number[] = []
  return { sleeps, sleep: async (ms: number) => { sleeps.push(ms) } }
}

test('403 rateLimitExceeded twice then success: resolves after 2 growing sleeps', async () => {
  const { sleeps, sleep } = harness()
  let calls = 0
  const out = await withRateLimitRetry(async () => {
    if (++calls <= 2) {
      throw gaxios(403, 'rateLimitExceeded')
    }
    return 'ok'
  }, { sleep })
  assert.equal(out, 'ok')
  assert.equal(sleeps.length, 2)
  assert.ok(sleeps[1] > sleeps[0])
})

test('429 and err.status / err.errors shapes are retried', async () => {
  const { sleeps, sleep } = harness()
  let calls = 0
  const shapes = [gaxios(429), Object.assign(new Error('x'), { status: 403, errors: [{ reason: 'userRateLimitExceeded' }] })]
  assert.equal(await withRateLimitRetry(async () => {
    if (calls < shapes.length) {
      throw shapes[calls++]
    }
    return 1
  }, { sleep }), 1)
  assert.equal(sleeps.length, 2)
})

test('403 insufficientPermissions is not retried', async () => {
  const { sleeps, sleep } = harness()
  let calls = 0
  await assert.rejects(withRateLimitRetry(async () => { calls++; throw gaxios(403, 'insufficientPermissions') }, { sleep }))
  assert.equal(calls, 1)
  assert.deepEqual(sleeps, [])
})

test('persistent rate limit rejects after 6 tries and caps each wait at 64s', async () => {
  const { sleeps, sleep } = harness()
  let calls = 0
  await assert.rejects(withRateLimitRetry(async () => { calls++; throw gaxios(403, 'rateLimitExceeded') }, { sleep }))
  assert.equal(calls, 6)
  assert.equal(sleeps.length, 5)
  assert.ok(sleeps.every((s) => s <= 64_000))
})

test('fetchUnreadThreads survives a rate limit on the first threads.get', async () => {
  const { sleeps, sleep } = harness()
  let gets = 0
  const thread = (id: string) => ({ id, messages: [{ id: `m${id}`, internalDate: '1', labelIds: ['UNREAD'], snippet: 's', payload: { headers: [{ name: 'From', value: 'a@x.com' }] } }] })
  const g = {
    users: {
      getProfile: async () => ({ data: { emailAddress: 'me@x.com' } }),
      threads: {
        list: async () => ({ data: { threads: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], resultSizeEstimate: 3 } }),
        get: async ({ id }: { id: string }) => {
          if (gets++ === 0) {
            throw gaxios(403, 'rateLimitExceeded')
          }
          return { data: thread(id) }
        },
      },
    },
  } as unknown as gmail_v1.Gmail
  const r = await fetchUnreadThreads(g, 300, undefined, createRetryBudget({ sleep }))
  assert.equal(r.threads.length, 3)
  assert.equal(sleeps.length, 1)
})

test('a shared budget caps total sleep across calls, then throws QuotaExhaustedError without calling fn or sleeping', async () => {
  const { sleeps, sleep } = harness()
  const budget = createRetryBudget({ maxSleepMs: 200_000, sleep })
  let calls = 0
  const always = async () => { calls++; throw gaxios(403, 'rateLimitExceeded') }
  let exhaustedAt = -1
  for (let i = 0; i < 6; i++) {
    try {
      await withRateLimitRetry(always, { budget })
    } catch (e) {
      if (e instanceof QuotaExhaustedError && exhaustedAt < 0) {
        exhaustedAt = i
      }
    }
  }
  assert.ok(exhaustedAt >= 1)
  assert.ok(sleeps.reduce((a, b) => a + b, 0) <= 200_000)
  const before = { calls, slept: sleeps.length }
  await assert.rejects(withRateLimitRetry(always, { budget }), QuotaExhaustedError)
  assert.deepEqual({ calls, slept: sleeps.length }, before)
})

test('non-rate-limit errors do not touch the budget', async () => {
  const { sleeps, sleep } = harness()
  const budget = createRetryBudget({ maxSleepMs: 10, sleep })
  await assert.rejects(withRateLimitRetry(async () => { throw gaxios(403, 'insufficientPermissions') }, { budget }), /Quota exceeded/)
  assert.equal(sleeps.length, 0)
  assert.equal(budget.exhausted, false)
})

test('a sibling that wakes after exhaustion does not call fn again', async () => {
  const budget = createRetryBudget({ maxSleepMs: 3000, sleep: () => new Promise<void>((r) => { wake.push(r) }) })
  const wake: (() => void)[] = []
  let aCalls = 0
  const a = withRateLimitRetry(async () => { aCalls++; throw gaxios(403, 'rateLimitExceeded') }, { budget })
  await new Promise((r) => setImmediate(r))
  assert.equal(aCalls, 1)
  await assert.rejects(withRateLimitRetry(async () => { throw gaxios(403, 'rateLimitExceeded') }, { budget }), QuotaExhaustedError)
  assert.equal(budget.exhausted, true)
  wake[0]()
  await assert.rejects(a, QuotaExhaustedError)
  assert.equal(aCalls, 1)
})

test('fetchUnreadThreads waits for sibling gets and makes no get after the failed batch settles', async () => {
  const { sleep } = harness()
  const budget = createRetryBudget({ maxSleepMs: 3000, sleep })
  let gets = 0
  let settled = false
  const g = {
    users: {
      getProfile: async () => ({ data: { emailAddress: 'me@x.com' } }),
      threads: {
        list: async () => ({ data: { threads: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id })), resultSizeEstimate: 6 } }),
        get: async () => { gets++; throw gaxios(403, 'rateLimitExceeded') },
      },
    },
  } as unknown as gmail_v1.Gmail
  await assert.rejects(fetchUnreadThreads(g, 300, undefined, budget), QuotaExhaustedError)
  settled = true
  const at = gets
  await new Promise((r) => setImmediate(r))
  assert.equal(gets, at)
  assert.ok(settled)
})
