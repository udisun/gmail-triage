import { randomUUID } from 'node:crypto'
import type { gmail_v1 } from 'googleapis'
import { LABEL_NAME } from './buckets.ts'
import { HEADERS } from './gmail.ts'
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

// Pure: per monitor keep only the newest open alert thread, and archive Recovered notices; attention threads quiet for STALE_DAYS go stale. Pinned senders are never swept.
// No "recovered, so resolve the newest" rule: headers carry no org id, so another Datadog account's signed Recovered could bury a live alert.
export const planSweep = (open: Map<string, OpenList>, now: number, pins: Pick<Pins, 'neverArchive' | 'alwaysUrgent'> = { neverArchive: [], alwaysUrgent: [] }): SweepPlan => {
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
  for (const rows of byTitle.values()) {
    const sorted = [...rows].sort((x, y) => y.lastAt - x.lastAt)
    for (const r of sorted.slice(1)) {
      resolved.push({ ...r, why: 'newer alert for this monitor' })
    }
  }
  return { resolved, stale }
}

type Msg = { id?: string | null, internalDate?: string | null, labelIds?: string[] | null }
type SweepApi = ThreadsApi & { get: (p: { userId: 'me', id: string, format: 'metadata', metadataHeaders: string[] }) => Promise<{ data: gmail_v1.Schema$Thread }> }
class ChangedError extends Error {}

// Logged as archiveOld entries (add audit label, remove INBOX), so `undo <date>` restores them. Before the first write and every retry the thread must
// still end at the planned message, still be in the Inbox without the audit label, and (stale only) hold no unread direct human mail, the same floor
// triage applies; otherwise it is left alone.
// shortcut: a reply landing in the ms between the check and the modify is still archived (same race as triage); a reply after it returns the thread to the Inbox.
export const applySweep = async (api: SweepApi, plan: SweepPlan, labels: { resolved: string, stale: string }, date: string, budget: RetryBudget, directHumanUnread: (t: gmail_v1.Schema$Thread) => boolean): Promise<{ done: SweepPlan, failed: SweepRow[] }> => {
  const done: SweepPlan = { resolved: [], stale: [] }
  const failed: SweepRow[] = []
  for (const kind of ['resolved', 'stale'] as const) {
    for (const r of plan[kind]) {
      const label = labels[kind]
      const eligible = async (): Promise<boolean> => {
        const { data } = await withRateLimitRetry(() => api.get({ userId: 'me', id: r.threadId, format: 'metadata', metadataHeaders: HEADERS }), { budget })
        const msgs = data.messages ?? []
        const newest = msgs.reduce<Msg | null>((a, m) => a === null || Number(m.internalDate ?? 0) >= Number(a.internalDate ?? 0) ? m : a, null)
        const has = (l: string) => msgs.some((m) => m.labelIds?.includes(l))
        return newest?.id === r.messageId && has('INBOX') && !has(label) && (kind !== 'stale' || !directHumanUnread(data))
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
