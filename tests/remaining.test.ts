import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { gmail_v1 } from 'googleapis'
import { fetchUnreadThreads, listUnreadIds } from '../src/gmail.ts'
import { createRetryBudget, QuotaExhaustedError } from '../src/retry.ts'

const gaxios = (status: number, reason: string): Error =>
  Object.assign(new Error('Quota exceeded'), { response: { status, data: { error: { errors: [{ reason }] } } } })

const thread = (id: string) => ({ id, messages: [{ id: `m${id}`, internalDate: '1', labelIds: ['UNREAD'], snippet: 's', payload: { headers: [{ name: 'From', value: 'a@x.com' }] } }] })

// Pages of ids; every page reports the same misleading estimate, like Gmail does.
const fake = (sizes: number[], opts: { estimate?: number, failListFromPage?: number } = {}) => {
  const pages = sizes.map((n, p) => Array.from({ length: n }, (_, i) => `p${p}-${i}`))
  const listCalls: { maxResults?: number }[] = []
  const g = {
    users: {
      getProfile: async () => ({ data: { emailAddress: 'me@x.com' } }),
      threads: {
        list: async (q: { pageToken?: string, maxResults?: number }) => {
          listCalls.push({ maxResults: q.maxResults })
          const p = q.pageToken ? Number(q.pageToken) : 0
          if (opts.failListFromPage !== undefined && p >= opts.failListFromPage) {
            throw gaxios(403, 'rateLimitExceeded')
          }
          return { data: { threads: pages[p].map((id) => ({ id })), nextPageToken: p + 1 < pages.length ? String(p + 1) : undefined, resultSizeEstimate: opts.estimate ?? 201 } }
        },
        get: async ({ id }: { id: string }) => ({ data: thread(id) }),
      },
    },
  } as unknown as gmail_v1.Gmail
  return { g, pages, listCalls }
}

test('the id listing is exact and ignores resultSizeEstimate', async () => {
  const { g, listCalls } = fake([500, 500, 122])
  const r = await listUnreadIds(g, createRetryBudget())
  assert.equal(r.ids.length, 1122)
  assert.equal(r.capped, false)
  assert.ok(listCalls.every((c) => c.maxResults === 500))
})

test('the listing stops at 5000 ids and flags the cap', async () => {
  const { g, listCalls } = fake(Array.from({ length: 14 }, () => 500))
  const r = await listUnreadIds(g, createRetryBudget())
  assert.equal(r.ids.length, 5000)
  assert.equal(r.capped, true)
  assert.ok(listCalls.length < 14)
})

test('a budget exhausted while listing throws, so the caller can report unknown', async () => {
  const { g } = fake([500, 500], { failListFromPage: 1 })
  await assert.rejects(listUnreadIds(g, createRetryBudget({ maxSleepMs: 1, sleep: async () => {} })), QuotaExhaustedError)
})

test('probe path: a 422-thread inbox lists 422 despite an estimate of 201', async () => {
  const { g } = fake([422], { estimate: 201 })
  assert.equal((await listUnreadIds(g, createRetryBudget())).ids.length, 422)
})

test('fetchUnreadThreads holds the cap and leaves the rest of the listing alone', async () => {
  const { g } = fake([500, 500, 122])
  const r = await fetchUnreadThreads(g, 300)
  assert.equal(r.threads.length, 300)
})
