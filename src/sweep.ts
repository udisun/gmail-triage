import { randomUUID } from 'node:crypto'
import type { gmail_v1 } from 'googleapis'
import { LABEL_NAME } from './buckets.ts'
import type { OpenList, OpenRow } from './gmail.ts'
import { applyArchiveOld, archiveOldBody } from './gmailWrite.ts'
import type { Retry, ThreadsApi } from './gmailWrite.ts'
import { fromMailbox } from './pins.ts'
import { QuotaExhaustedError, withRateLimitRetry } from './retry.ts'
import type { RetryBudget } from './retry.ts'
import { appendRunEntry } from './state.ts'

// Measured 2026-11-22 over 30 days: every Datadog monitor mail comes from this address as "[Pn] <verb>: <monitor>".
export const ALERT_FROM = 'alert@dtdg.co'
const ALERT_RE = /^\[P\d\] (Triggered|Re-Triggered|Warn|Recovered): (.+)$/
export const STALE_DAYS = 30
const DAY_MS = 86_400_000

export type SweepRow = OpenRow & { why: string }
export type SweepPlan = { resolved: SweepRow[], stale: SweepRow[] }

const alertTitle = (r: { from: string, subject: string }): { verb: string, title: string } | null => {
  const m = fromMailbox(r.from) === ALERT_FROM ? ALERT_RE.exec(r.subject) : null
  return m ? { verb: m[1], title: m[2] } : null
}

// Pure: per monitor keep the newest open alert thread unless a recovery came after it; attention threads quiet for STALE_DAYS go stale.
export const planSweep = (open: Map<string, OpenList>, recoveredAt: Map<string, number>, now: number): SweepPlan => {
  const byTitle = new Map<string, OpenRow[]>()
  const stale: SweepRow[] = []
  for (const [name, list] of open) {
    for (const r of list.rows) {
      const a = alertTitle(r)
      if (a !== null && a.verb !== 'Recovered') {
        byTitle.set(a.title, [...(byTitle.get(a.title) ?? []), r])
      } else if (a === null && name === LABEL_NAME.attention && now - r.lastAt > STALE_DAYS * DAY_MS) {
        stale.push({ ...r, why: `no mail for ${Math.floor((now - r.lastAt) / DAY_MS)} days` })
      }
    }
  }
  const resolved: SweepRow[] = []
  for (const [title, rows] of byTitle) {
    const sorted = [...rows].sort((x, y) => y.lastAt - x.lastAt)
    const recovered = recoveredAt.get(title) ?? 0
    sorted.forEach((r, i) => {
      if (recovered > r.lastAt) {
        resolved.push({ ...r, why: 'monitor recovered' })
      } else if (i > 0) {
        resolved.push({ ...r, why: 'newer alert for this monitor' })
      }
    })
  }
  return { resolved, stale }
}

// Latest Recovered mail per monitor title over the last 30 days; read-only.
export const listRecoveries = async (g: gmail_v1.Gmail, budget: RetryBudget, signal?: AbortSignal): Promise<Map<string, number>> => {
  const { data } = await withRateLimitRetry(() => g.users.messages.list({ userId: 'me', q: `from:${ALERT_FROM} subject:Recovered newer_than:30d`, maxResults: 200 }, { signal }), { budget })
  const out = new Map<string, number>()
  for (const m of data.messages ?? []) {
    if (!m.id) {
      continue
    }
    const id = m.id
    const { data: msg } = await withRateLimitRetry(() => g.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject'] }, { signal }), { budget })
    const h = new Map((msg.payload?.headers ?? []).map((x) => [String(x.name).toLowerCase(), String(x.value ?? '')]))
    const a = alertTitle({ from: h.get('from') ?? '', subject: h.get('subject') ?? '' })
    if (a?.verb === 'Recovered') {
      out.set(a.title, Math.max(out.get(a.title) ?? 0, Number(msg.internalDate ?? 0)))
    }
  }
  return out
}

type SweepApi = ThreadsApi & { get: (p: { userId: 'me', id: string, format: 'minimal' }) => Promise<{ data: { messages?: { id?: string | null, internalDate?: string | null }[] } }> }

// Logged as archiveOld entries (add audit label, remove INBOX), so `undo <date>` restores them; a thread with mail newer than planned is left alone.
export const applySweep = async (api: SweepApi, plan: SweepPlan, labels: { resolved: string, stale: string }, date: string, budget: RetryBudget): Promise<{ done: SweepPlan, failed: number }> => {
  const done: SweepPlan = { resolved: [], stale: [] }
  let failed = 0
  const retry: Retry = (fn) => withRateLimitRetry(fn, { budget })
  for (const kind of ['resolved', 'stale'] as const) {
    for (const r of plan[kind]) {
      try {
        const { data } = await retry(() => api.get({ userId: 'me', id: r.threadId, format: 'minimal' }))
        const newest = (data.messages ?? []).reduce<{ id?: string | null, internalDate?: string | null } | null>((a, m) => a === null || Number(m.internalDate ?? 0) >= Number(a.internalDate ?? 0) ? m : a, null)
        if (newest?.id !== r.messageId) {
          continue
        }
        await appendRunEntry(date, { kind: 'archiveOld', opId: randomUUID(), threadId: r.threadId, messageId: r.messageId, labelId: labels[kind] })
        await applyArchiveOld(api, r.threadId, archiveOldBody(labels[kind]), labels[kind], retry)
        done[kind].push(r)
      } catch (e) {
        failed++
        if (e instanceof QuotaExhaustedError) {
          return { done, failed }
        }
      }
    }
  }
  return { done, failed }
}
