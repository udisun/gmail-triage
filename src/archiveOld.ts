import { randomUUID } from 'node:crypto'
import { applyArchiveOld, archiveOldBody, ensureLabels } from './gmailWrite.ts'
import type { Retry } from './gmailWrite.ts'
import { createRetryBudget, httpStatusOf, QuotaExhaustedError, realSleep, withRateLimitRetry } from './retry.ts'
import type { RetryBudget, Sleep } from './retry.ts'
import { localDate } from './run.ts'
import type { GmailLike } from './run.ts'
import { acquireLock, appendRunEntry } from './state.ts'

export type ArchiveOldDeps = { gmail: () => Promise<GmailLike>, now: () => Date, sleep?: Sleep, clock?: () => number, unitsPerMinute?: number, retryBudgetMs?: number }
export type Io = { out: (s: string) => void, err: (s: string) => void }

const DAY_MS = 86_400_000
const LIST_PAGE = 500
const MAX_CANDIDATES = 20_000
// Gmail quota units per call, and the share of the 6,000 units/min per-user limit we spend by default.
const LIST_UNITS = 10
const GET_UNITS = 40
const MODIFY_UNITS = 10
const THREAD_UNITS = GET_UNITS + MODIFY_UNITS
const DEFAULT_UNITS_PER_MINUTE = 4500
const UNITS_ENV = 'GMAIL_TRIAGE_UNITS_PER_MINUTE'
const USAGE = 'usage: archive-old [--days N] [--yes]  (N is an integer from 1 to 3650)'
const REASONS = ['recent', 'unread', 'starred', 'changed'] as const
type Reason = typeof REASONS[number]
type Skips = Record<Reason, number>
type Target = { threadId: string, messageId: string }
type Charge = (units: number) => Promise<void>
type Msg = { id?: string | null, labelIds?: string[] | null, internalDate?: string | null }

class ChangedThreadError extends Error {}
class TooManyError extends Error {}

const parseArgs = (args: string[]): { days: number, yes: boolean } | null => {
  let days = 30
  let yes = false
  let sawDays = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--yes' && !yes) {
      yes = true
    } else if (args[i] === '--days' && !sawDays && /^\d{1,4}$/.test(args[i + 1] ?? '')) {
      sawDays = true
      days = Number(args[++i])
    } else {
      return null
    }
  }
  return days >= 1 && days <= 3650 ? { days, yes } : null
}

// Gmail matches the query per message, so every thread-wide fact is read from the whole thread.
const inspect = (messages: Msg[]): { inbox: boolean, unread: boolean, starred: boolean, newest: { id: string, at: number } | null, dated: boolean } => {
  let newest: { id: string, at: number } | null = null
  let dated = messages.length > 0
  for (const m of messages) {
    const at = Number(m.internalDate)
    if (!m.id || !Number.isFinite(at) || at <= 0) {
      dated = false
    } else if (newest === null || at >= newest.at) {
      newest = { id: m.id, at }
    }
  }
  const has = (l: string): boolean => messages.some((m) => m.labelIds?.includes(l))
  return { inbox: has('INBOX'), unread: has('UNREAD'), starred: has('STARRED'), newest, dated }
}

// The first get is covered by the caller's reservation; every retried get reserves its own 40.
const readThread = async (g: GmailLike, id: string, budget: RetryBudget, charge: Charge): Promise<ReturnType<typeof inspect>> => {
  let attempts = 0
  const { data } = await withRateLimitRetry(async () => {
    if (attempts++ > 0) {
      await charge(GET_UNITS)
    }
    return await g.users.threads.get({ userId: 'me', id, format: 'minimal' })
  }, { budget })
  return inspect((data.messages ?? []) as Msg[])
}

// Ids only, one page at a time; `keep` filters while streaming so memory stays bounded by what the caller cares about.
const listThreadIds = async (g: GmailLike, q: string, budget: RetryBudget, charge: Charge, limit: number, keep: (id: string) => boolean = () => true): Promise<string[]> => {
  const ids: string[] = []
  let pageToken: string | undefined
  do {
    const token = pageToken
    const { data } = await withRateLimitRetry(async () => {
      await charge(LIST_UNITS)
      return await g.users.threads.list({ userId: 'me', q, maxResults: LIST_PAGE, pageToken: token })
    }, { budget })
    pageToken = data.nextPageToken ?? undefined
    ids.push(...((data.threads ?? []) as { id?: string | null }[]).map((t) => t.id).filter((id): id is string => !!id && keep(id)))
    if (ids.length > limit) {
      throw new TooManyError(`more than ${limit} threads match the candidate query; nothing was changed. Use a larger --days and run again.`)
    }
  } while (pageToken)
  return ids
}

// A thread matches when ANY message does, so older minus (recent, unread, starred) is exact with no per-thread get.
const scan = async (g: GmailLike, days: number, budget: RetryBudget, charge: Charge, skips: Skips): Promise<{ candidates: number, eligible: string[] }> => {
  const older = await listThreadIds(g, `in:inbox older_than:${days}d`, budget, charge, MAX_CANDIDATES)
  if (older.length === 0) {
    return { candidates: 0, eligible: [] }
  }
  const candidate = new Set(older)
  // unrelated unread or starred mail must not abort the run, so exclusions keep only candidate ids and have no cap
  const exclude: [Reason, string][] = [['recent', `newer_than:${days}d`], ['unread', 'is:unread'], ['starred', 'is:starred']]
  const sets: [Reason, Set<string>][] = []
  for (const [reason, q] of exclude) {
    sets.push([reason, new Set(await listThreadIds(g, `in:inbox ${q}`, budget, charge, Infinity, (id) => candidate.has(id)))])
  }
  const eligible: string[] = []
  for (const id of older) {
    const hit = sets.find(([, set]) => set.has(id))
    if (hit) {
      skips[hit[0]]++
    } else {
      eligible.push(id)
    }
  }
  return { candidates: older.length, eligible }
}

// Token bucket in quota units: refills at unitsPerMinute, holds at most one call's worth, goes into debt rather than spinning when sleep is a no-op.
const createMeter = (clock: () => number, sleep: Sleep, unitsPerMinute: number): Charge => {
  const rate = unitsPerMinute / 60_000
  const cap = THREAD_UNITS
  let tokens = cap
  let at = clock()
  return async (units) => {
    const refill = (): void => {
      const now = clock()
      tokens = Math.min(cap, tokens + (now - at) * rate)
      at = now
    }
    refill()
    if (tokens < units) {
      await sleep((units - tokens) / rate)
      refill()
    }
    tokens -= units
  }
}

const unitsFromEnv = (): number | null => {
  const v = process.env[UNITS_ENV]
  if (v === undefined) {
    return DEFAULT_UNITS_PER_MINUTE
  }
  return /^[1-9]\d{0,8}$/.test(v) && Number(v) >= THREAD_UNITS ? Number(v) : null
}

const skipText = (skips: Skips): string => {
  const total = REASONS.reduce((n, r) => n + skips[r], 0)
  return `${total}${total > 0 ? ` (${REASONS.filter((r) => skips[r] > 0).map((r) => `${r} ${skips[r]}`).join(', ')})` : ''}`
}

// The newest message id when the thread is still archivable, else null: in the inbox, nothing unread or starred, newest message older than the cutoff.
const archivableId = async (g: GmailLike, threadId: string, cutoff: number, budget: RetryBudget, charge: Charge): Promise<string | null> => {
  const v = await readThread(g, threadId, budget, charge)
  return v.dated && v.inbox && !v.unread && !v.starred && v.newest !== null && v.newest.at < cutoff ? v.newest.id : null
}

// Every attempt after the first re-checks, so a throttled archive cannot hide mail that arrived meanwhile.
const retryArchive = (g: GmailLike, t: Target, cutoff: number, budget: RetryBudget, charge: Charge): Retry => {
  let attempts = 0
  return (fn) => withRateLimitRetry(async () => {
    if (attempts++ > 0) {
      await charge(THREAD_UNITS)
      if ((await archivableId(g, t.threadId, cutoff, budget, charge)) !== t.messageId) {
        throw new ChangedThreadError('thread changed')
      }
    }
    return await fn()
  }, { budget })
}

export const runArchiveOld = async (deps: ArchiveOldDeps, args: string[], io: Io = { out: console.log, err: console.error }): Promise<number> => {
  const opts = parseArgs(args)
  if (opts === null) {
    io.err(USAGE)
    return 2
  }
  const unitsPerMinute = deps.unitsPerMinute ?? unitsFromEnv()
  if (unitsPerMinute === null) {
    io.err(`${UNITS_ENV} must be an integer of at least ${THREAD_UNITS}`)
    return 2
  }
  const release = await acquireLock()
  if (release === null) {
    io.out('already running')
    return 0
  }
  try {
    const budget = createRetryBudget({ maxSleepMs: deps.retryBudgetMs, sleep: deps.sleep ?? realSleep })
    const skips = Object.fromEntries(REASONS.map((r) => [r, 0])) as Skips
    const now = deps.now()
    const g = await deps.gmail()
    const charge = createMeter(deps.clock ?? Date.now, deps.sleep ?? realSleep, unitsPerMinute)
    const cutoff = now.getTime() - opts.days * DAY_MS
    let found: { candidates: number, eligible: string[] }
    try {
      found = await scan(g, opts.days, budget, charge, skips)
    } catch (e) {
      if (e instanceof TooManyError || e instanceof QuotaExhaustedError) {
        io.err(e instanceof TooManyError ? e.message : 'Gmail quota exhausted during the scan; nothing was changed. Run again later.')
        return 1
      }
      throw e
    }
    const eligible = found.eligible
    if (!opts.yes) {
      io.out(`candidates ${found.candidates}`)
      io.out(`eligible ${eligible.length}`)
      io.out(`skipped ${skipText(skips)}`)
      io.out(`estimated time ${Math.ceil(eligible.length * THREAD_UNITS / unitsPerMinute)} min`)
      io.out(`re-run with --yes to archive ${eligible.length} threads`)
      return 0
    }
    io.out(`candidates ${found.candidates}, eligible ${eligible.length}`)
    let archived = 0
    let failed = 0
    let notProcessed = 0
    if (eligible.length > 0) {
      const date = localDate(now)
      let labelId: string | null = null
      try {
        labelId = (await ensureLabels(g.users.labels, (fn) => withRateLimitRetry(async () => {
          await charge(LIST_UNITS)
          return await fn()
        }, { budget }))).archivedOld
      } catch (e) {
        if (!(e instanceof QuotaExhaustedError)) {
          throw e
        }
        notProcessed = eligible.length
      }
      for (let i = 0; labelId !== null && i < eligible.length; i++) {
        const threadId = eligible[i]
        try {
          // get + modify are reserved up front so no pacing wait can sit between the re-check and the write
          await charge(THREAD_UNITS)
          const messageId = await archivableId(g, threadId, cutoff, budget, charge)
          if (messageId === null) {
            skips.changed++
            continue
          }
          const t: Target = { threadId, messageId }
          // logged after the re-check (a skipped thread leaves no line) but before the write: an unlogged archive could never be undone
          await appendRunEntry(date, { kind: 'archiveOld', opId: randomUUID(), threadId: t.threadId, messageId: t.messageId, labelId })
          await applyArchiveOld(g.users.threads, t.threadId, archiveOldBody(labelId), labelId, retryArchive(g, t, cutoff, budget, charge))
          archived++
        } catch (e) {
          if (e instanceof ChangedThreadError || httpStatusOf(e) === 404) {
            skips.changed++
          } else {
            failed++
            if (e instanceof QuotaExhaustedError) {
              notProcessed = eligible.length - i - 1
              break
            }
          }
        }
      }
    }
    io.out(`archived ${archived}, skipped ${skipText(skips)}, failed ${failed}`)
    if (notProcessed > 0) {
      io.err(`Gmail quota exhausted: ${notProcessed} not processed. Run again later.`)
    }
    return failed > 0 || notProcessed > 0 ? 1 : 0
  } finally {
    await release()
  }
}
