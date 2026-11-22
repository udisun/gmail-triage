import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authenticatedDatadog, planSweep, STALE_DAYS } from '../src/sweep.ts'
import type { OpenList, OpenRow } from '../src/gmail.ts'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 22)
const row = (threadId: string, subject: string, daysAgo: number, from = 'Datadog Alerting <alert@dtdg.co>'): OpenRow => ({ threadId, messageId: `m-${threadId}`, from, subject, lastAt: NOW - daysAgo * DAY })
const open = (urgent: OpenRow[], attention: OpenRow[] = []): Map<string, OpenList> => new Map([['Triage/Urgent', { rows: urgent, rest: [] }], ['Triage/Attention', { rows: attention, rest: [] }]])
const ids = (rs: { threadId: string }[]) => rs.map((r) => r.threadId).sort()

test('per monitor, only the newest alert thread stays; older Triggered/Re-Triggered/Warn ones resolve', () => {
  const p = planSweep(open([row('a1', '[P2] Triggered: MySQL DELETE denied', 3), row('a2', '[P2] Re-Triggered: MySQL DELETE denied', 0), row('b1', '[P1] Warn: Redis evictions', 5)], [row('a3', '[P3] Triggered: MySQL DELETE denied', 9)]), new Map(), NOW)
  // a3 is the same name at another priority: its own monitor, so it stays
  assert.deepEqual(ids(p.resolved), ['a1'])
  assert.ok(p.resolved.every((r) => r.why === 'newer alert for this monitor'))
  assert.deepEqual(p.stale, [])
})

test('a recovery after the newest alert resolves the whole monitor; one before it keeps the newest', () => {
  const rows = [row('a1', '[P2] Triggered: Deposit trades', 4), row('a2', '[P2] Re-Triggered: Deposit trades', 2)]
  assert.deepEqual(ids(planSweep(open(rows), new Map([['[P2] Deposit trades', NOW - 1 * DAY]]), NOW).resolved), ['a1', 'a2'])
  const kept = planSweep(open(rows), new Map([['[P2] Deposit trades', NOW - 3 * DAY]]), NOW).resolved
  assert.deepEqual(kept.map((r) => [r.threadId, r.why]), [['a1', 'monitor recovered']])
})

test('only alert@dtdg.co counts as an alert; its Recovered notices are archived, other senders never', () => {
  const p = planSweep(open([row('r', '[P1] Recovered: X', 1), row('fake', '[P1] Triggered: Y', 9, 'Mallory <alert@dtdg.co.evil.com>'), row('y', '[P1] Triggered: Y', 0)]), new Map(), NOW)
  assert.deepEqual(p.resolved.map((r) => [r.threadId, r.why]), [['r', 'recovery notice']])
})

test('pinned senders (neverArchive, alwaysUrgent) are never swept', () => {
  const rows = [row('a1', '[P2] Triggered: Z', 3), row('a2', '[P2] Triggered: Z', 1)]
  assert.deepEqual(planSweep(open(rows, [row('s', 'Old', 90, 'Pat <pat@x.com>')]), new Map(), NOW, { neverArchive: ['pat@x.com'], alwaysUrgent: ['@dtdg.co'] }), { resolved: [], stale: [] })
})

test('a recovery counts only with Gmail\'s own first Authentication-Results showing DKIM and DMARC pass for dtdg.co', () => {
  const real = 'mx.google.com; dkim=pass header.i=@dtdg.co header.s=s1 header.b=x; spf=pass (google.com: ...) smtp.mailfrom="b@sendgrid.net"; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=dtdg.co'
  assert.equal(authenticatedDatadog(real), true)
  for (const bad of [undefined, '', real.replace('dkim=pass', 'dkim=fail'), real.replace('dmarc=pass', 'dmarc=fail'), real.replace('@dtdg.co', '@dtdg.co.evil.com'), real.replace('header.from=dtdg.co', 'header.from=evil.com'), `evil.example; ${real.slice('mx.google.com; '.length)}`]) {
    assert.equal(authenticatedDatadog(bad), false, String(bad))
  }
})

test('stale: attention only, non-alert, strictly older than the threshold; urgent never goes stale', () => {
  const p = planSweep(open([row('u', 'Overdue invoice', 90, 'Bank <b@bank.com>')], [row('s', 'Renewal', STALE_DAYS + 1, 'Rep <r@cf.com>'), row('edge', 'Edge', STALE_DAYS, 'P <p@x.com>'), row('fresh', 'New', 2, 'P <p@x.com>')]), new Map(), NOW)
  assert.deepEqual(ids(p.stale), ['s'])
  assert.equal(p.stale[0].why, `no mail for ${STALE_DAYS + 1} days`)
})
