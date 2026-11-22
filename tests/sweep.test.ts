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
  const p = planSweep(open([row('a1', '[P2] Triggered: MySQL DELETE denied', 3), row('a2', '[P2] Re-Triggered: MySQL DELETE denied', 0), row('b1', '[P1] Warn: Redis evictions', 5)], [row('a3', '[P3] Triggered: MySQL DELETE denied', 9)]), NOW)
  // a3 is the same name at another priority: its own monitor, so it stays
  assert.deepEqual(ids(p.resolved), ['a1'])
  assert.ok(p.resolved.every((r) => r.why === 'newer alert for this monitor'))
  assert.deepEqual(p.stale, [])
})

test('a Recovered notice is archived itself but never resolves the newest alert for its monitor', () => {
  const p = planSweep(open([row('a1', '[P2] Triggered: Deposit trades', 4), row('a2', '[P2] Re-Triggered: Deposit trades', 2), row('rec', '[P2] Recovered: Deposit trades', 1)]), NOW)
  assert.deepEqual(p.resolved.map((r) => [r.threadId, r.why]).sort(), [['a1', 'newer alert for this monitor'], ['rec', 'recovery notice']])
})

test('only alert@dtdg.co counts as an alert; its Recovered notices are archived, other senders never', () => {
  const p = planSweep(open([row('r', '[P1] Recovered: X', 1), row('fake', '[P1] Triggered: Y', 9, 'Mallory <alert@dtdg.co.evil.com>'), row('y', '[P1] Triggered: Y', 0)]), NOW)
  assert.deepEqual(p.resolved.map((r) => [r.threadId, r.why]), [['r', 'recovery notice']])
})

test('pinned senders (neverArchive, alwaysUrgent) are never swept', () => {
  const rows = [row('a1', '[P2] Triggered: Z', 3), row('a2', '[P2] Triggered: Z', 1)]
  assert.deepEqual(planSweep(open(rows, [row('s', 'Old', 90, 'Pat <pat@x.com>')]), NOW, { neverArchive: ['pat@x.com'], alwaysUrgent: ['@dtdg.co'] }), { resolved: [], stale: [] })
})
