import { randomUUID } from 'node:crypto'
import type { gmail_v1 } from 'googleapis'
import { LABEL_NAME } from './buckets.ts'
import type { OpenList, OpenRow } from './gmail.ts'
import { applyArchiveOld, archiveOldBody } from './gmailWrite.ts'
import type { Retry, ThreadsApi } from './gmailWrite.ts'
import { fromMailbox, matchesPin } from './pins.ts'
import { QuotaExhaustedError, withRateLimitRetry } from './retry.ts'
import type { RetryBudget } from './retry.ts'
import { appendRunEntry } from './state.ts'
import type { Pins } from './types.ts'

// Measured 2026-11-22 over 30 days: every Datadog monitor mail comes from this address as "[Pn] <verb>: <monitor>".
export const ALERT_FROM = 'alert@dtdg.co'
export const STALE_DAYS = 30
const DAY_MS = 86_400_000

export type SweepRow = OpenRow & { why: string }
export type SweepPlan = { resolved: SweepRow[], stale: SweepRow[] }

// The monitor key keeps the priority, so two monitors sharing a name at different priorities never resolve each other.
const ALERT_RE = /^\[(P\d)\] (Triggered|Re-Triggered|Warn|Recovered): (.+)$/
const alertTitle = (r: { from: string, subject: string }): { verb: string, title: string } | null => {
  const m = fromMailbox(r.from) === ALERT_FROM ? ALERT_RE.exec(r.subject) : null
  return m ? { verb: m[2], title: `[${m[1]}] ${m[3]}` } : null
}

const pinned = (from: string, pins: Pick<Pins, 'neverArchive' | 'alwaysUrgent'>): boolean =>
  [...pins.neverArchive, ...pins.alwaysUrgent].some((e) => matchesPin(from, e))

// Gmail prepends its own Authentication-Results, so only the first one counts; a sender can add more below it but never above.
export const authenticatedDatadog = (authResults: string | undefined): boolean => {
  const a = (authResults ?? '').replace(/\s+/g, ' ')
  return a.startsWith('mx.google.com;') && /\bdkim=pass header\.i=@dtdg\.co(?=[\s;]|$)/.test(a) && /\bdmarc=pass \([^)]*\) header\.from=dtdg\.co(?=[\s;]|$)/.test(a)
}

// Pure: per monitor keep the newest open alert thread unless a recovery came after it; attention threads quiet for STALE_DAYS go stale. Pinned senders are never swept.
export const planSweep = (open: Map<string, OpenList>, recoveredAt: Map<string, number>, now: number, pins: Pick<Pins, 'neverArchive' | 'alwaysUrgent'> = { neverArchive: [], alwaysUrgent: [] }): SweepPlan => {
  const byTitle = new Map<string, OpenRow[]>()
  const stale: SweepRow[] = []
  const resolved: SweepRow[] = []
  for (const [name, list] of open) {
    for (const r of list.rows) {
      if (pinned(r.from, pins)) {
        continue
      }
      const a = alertTitle(r)
      if (a?.verb === 'Recovered') {
        resolved.push({ ...r, why: 'recovery notice' })
      } else if (a !== null) {
        byTitle.set(a.title, [...(byTitle.get(a.title) ?? []), r])
      } else if (name === LABEL_NAME.attention && now - r.lastAt > STALE_DAYS * DAY_MS) {
        stale.push({ ...r, why: `no mail for ${Math.floor((now - r.lastAt) / DAY_MS)} days` })
      }
    }
  }
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

// Latest authenticated Recovered mail per monitor over the last 30 days; read-only. A forged recovery (no Gmail-verified DKIM + DMARC for dtdg.co) is ignored.
export const listRecoveries = async (g: gmail_v1.Gmail, budget: RetryBudget, signal?: AbortSignal): Promise<Map<string, number>> => {
  const { data } = await withRateLimitRetry(() => g.users.messages.list({ userId: 'me', q: `from:${ALERT_FROM} subject:Recovered newer_than:30d`, maxResults: 200 }, { signal }), { budget })
  const out = new Map<string, number>()
  for (const m of data.messages ?? []) {
    if (!m.id) {
      continue
    }
    const id = m.id
    const { data: msg } = await withRateLimitRetry(() => g.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Authentication-Results'] }, { signal }), { budget })
    const headers = msg.payload?.headers ?? []
    const h = (n: string): string | undefined => headers.find((x) => String(x.name).toLowerCase() === n)?.value ?? undefined
    const a = alertTitle({ from: h('from') ?? '', subject: h('subject') ?? '' })
    if (a?.verb === 'Recovered' && authenticatedDatadog(h('authentication-results'))) {
      out.set(a.title, Math.max(out.get(a.title) ?? 0, Number(msg.internalDate ?? 0)))
    }
  }
  return out
}

type Msg = { id?: string | null, internalDate?: string | null, labelIds?: string[] | null }
type SweepApi = ThreadsApi & { get: (p: { userId: 'me', id: string, format: 'minimal' }) => Promise<{ data: { messages?: Msg[] } }> }
class ChangedError extends Error {}

// Logged as archiveOld entries (add audit label, remove INBOX), so `undo <date>` restores them. Before the first write and every retry the thread must
// still end at the planned message, still be in the Inbox without the audit label, and (stale only) have nothing unread; otherwise it is left alone.
// shortcut: a reply landing in the ms between the check and the modify is still archived (same race as triage); a reply after it returns the thread to the Inbox.
export const applySweep = async (api: SweepApi, plan: SweepPlan, labels: { resolved: string, stale: string }, date: string, budget: RetryBudget): Promise<{ done: SweepPlan, failed: SweepRow[] }> => {
  const done: SweepPlan = { resolved: [], stale: [] }
  const failed: SweepRow[] = []
  for (const kind of ['resolved', 'stale'] as const) {
    for (const r of plan[kind]) {
      const label = labels[kind]
      const eligible = async (): Promise<boolean> => {
        const { data } = await withRateLimitRetry(() => api.get({ userId: 'me', id: r.threadId, format: 'minimal' }), { budget })
        const msgs = data.messages ?? []
        const newest = msgs.reduce<Msg | null>((a, m) => a === null || Number(m.internalDate ?? 0) >= Number(a.internalDate ?? 0) ? m : a, null)
        const has = (l: string) => msgs.some((m) => m.labelIds?.includes(l))
        return newest?.id === r.messageId && has('INBOX') && !has(label) && (kind !== 'stale' || !has('UNREAD'))
      }
      let attempts = 0
      const guarded: Retry = (fn) => withRateLimitRetry(async () => {
        if (attempts++ > 0 && !(await eligible())) {
          throw new ChangedError()
        }
        return await fn()
      }, { budget })
      try {
        if (!(await eligible())) {
          continue
        }
        await appendRunEntry(date, { kind: 'archiveOld', opId: randomUUID(), threadId: r.threadId, messageId: r.messageId, labelId: label })
        await applyArchiveOld(api, r.threadId, archiveOldBody(label), label, guarded)
        done[kind].push(r)
      } catch (e) {
        if (e instanceof ChangedError) {
          continue
        }
        console.error(`sweep: ${r.threadId} not archived (${e instanceof Error ? e.constructor.name : 'error'})`)
        failed.push(r)
        if (e instanceof QuotaExhaustedError) {
          return { done, failed }
        }
      }
    }
  }
  return { done, failed }
}
