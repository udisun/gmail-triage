import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planSweep, STALE_DAYS } from '../src/sweep.ts'
import type { OpenList, OpenRow } from '../src/gmail.ts'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 22)
const row = (threadId: string, subject: string, daysAgo: number, from = 'Datadog Alerting <alert@dtdg.co>'): OpenRow => ({ threadId, messageId: `m-${threadId}`, from, subject, lastAt: NOW - daysAgo * DAY })
const open = (urgent: OpenRow[], attention: OpenRow[] = []): Map<string, OpenList> => new Map([['Triage/Urgent', { rows: urgent, rest: [] }], ['Triage/Attention', { rows: attention, rest: [] }]])
const ids = (rs: { threadId: string }[]) => rs.map((r) => r.threadId).sort()

test('per monitor, only the newest alert thread stays; older Triggered/Re-Triggered/Warn ones resolve', () => {
  const p = planSweep(open([row('a1', '[P2] Triggered: MySQL DELETE denied', 3), row('a2', '[P2] Re-Triggered: MySQL DELETE denied', 0), row('b1', '[P1] Warn: Redis evictions', 5)], [row('a3', '[P3] Triggered: MySQL DELETE denied', 9)]), new Map(), NOW)
  assert.deepEqual(ids(p.resolved), ['a1', 'a3'])
  assert.ok(p.resolved.every((r) => r.why === 'newer alert for this monitor'))
  assert.deepEqual(p.stale, [])
})

test('a recovery after the newest alert resolves the whole monitor; one before it keeps the newest', () => {
  const rows = [row('a1', '[P2] Triggered: Deposit trades', 4), row('a2', '[P2] Re-Triggered: Deposit trades', 2)]
  assert.deepEqual(ids(planSweep(open(rows), new Map([['Deposit trades', NOW - 1 * DAY]]), NOW).resolved), ['a1', 'a2'])
  const kept = planSweep(open(rows), new Map([['Deposit trades', NOW - 3 * DAY]]), NOW).resolved
  assert.deepEqual(kept.map((r) => [r.threadId, r.why]), [['a1', 'monitor recovered']])
})

test('only alert@dtdg.co counts as an alert; Recovered threads and other senders are never resolved', () => {
  const p = planSweep(open([row('r', '[P1] Recovered: X', 1), row('r2', '[P1] Recovered: X', 9), row('fake', '[P1] Triggered: Y', 9, 'Mallory <alert@dtdg.co.evil.com>'), row('y', '[P1] Triggered: Y', 0)]), new Map(), NOW)
  assert.deepEqual(p.resolved, [])
})

test('stale: attention only, non-alert, strictly older than the threshold; urgent never goes stale', () => {
  const p = planSweep(open([row('u', 'Overdue invoice', 90, 'Bank <b@bank.com>')], [row('s', 'Renewal', STALE_DAYS + 1, 'Rep <r@cf.com>'), row('edge', 'Edge', STALE_DAYS, 'P <p@x.com>'), row('fresh', 'New', 2, 'P <p@x.com>')]), new Map(), NOW)
  assert.deepEqual(ids(p.stale), ['s'])
  assert.equal(p.stale[0].why, `no mail for ${STALE_DAYS + 1} days`)
})
