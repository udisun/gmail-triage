import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { gmail_v1 } from 'googleapis'
import { actionFor, LABEL_NAME } from './buckets.ts'
import { groupDuplicates } from './dedupe.ts'
import { AuthError, fetchUnreadThreads, listOpenByLabel, listUnreadIds, HEADERS, senderCount30d, stripControl, toThreadInput } from './gmail.ts'
import type { OpenList } from './gmail.ts'
import { applyDedupe, applyTriage, dedupeBody, ensureLabels, triageBody } from './gmailWrite.ts'
import type { LabelsApi, Retry, ThreadsApi } from './gmailWrite.ts'
import { homeDir } from './paths.ts'
import { applyDirectMailFloor, applyPins, fromMailbox } from './pins.ts'
import { createRetryBudget, QuotaExhaustedError, realSleep, retryNetwork, withRateLimitRetry } from './retry.ts'
import type { RetryBudget, Sleep } from './retry.ts'
import { renderReport, reportKind } from './report.ts'
import type { DupeRow, FailedRow, InboxSplit, OpenInbox, ReportInput, ReportRow, UnsubRow } from './report.ts'
import { acquireLock, appendRunEntry, loadState, readRun, saveState } from './state.ts'
import type { RunEntry } from './state.ts'
import { undoRun } from './undo.ts'
import { addCapture, writeUnsubCapture } from './unsubscribe.ts'
import type { UnsubEntry } from './unsubscribe.ts'
import type { Bucket, Pins, ThreadInput } from './types.ts'
import { validateVerdicts } from './validate.ts'
import { applySweep, planSweep } from './sweep.ts'
import type { SweepPlan, SweepRow } from './sweep.ts'

// The structural subset of gmail_v1.Gmail that a run uses; the real client satisfies it.
export type GmailLike = {
  users: {
    getProfile: (p: { userId: 'me' }) => Promise<{ data: { emailAddress?: string | null } }>
    threads: ThreadsApi & { list: (p: any) => Promise<any>, get: (p: any) => Promise<any> }
    labels: LabelsApi
  }
}

export type Deps = { gmail: () => Promise<GmailLike>, classify: (b: ThreadInput[], pins: Pins) => Promise<unknown>, pins: Pins, now: () => Date, repo: string, sleep?: Sleep, retryBudgetMs?: number, countDeadlineMs?: number }
export type RunResult = { reportFile: string, input: ReportInput, failed: string[], quotaExhausted: boolean }

const CAP = 300
const BATCH = 20
const COUNT_BUDGET_MS = 60_000
const CLASSIFY_RETRY_MS = 15_000
const COUNT_DEADLINE_MS = 60_000
const AUTH_FAILED = 'Gmail authorization failed: run gmail-triage auth'
const QUOTA_EXHAUSTED = 'Gmail quota exhausted, no changes were made to Gmail. Run again later.'
const CLASSIFY_FAILED = 'Classification failed, no changes were made to Gmail. Check the claude CLI and run again.'

const pad = (n: number): string => String(n).padStart(2, '0')
export const localDate = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

export const writeReport = async (input: ReportInput): Promise<string> => {
  const dir = join(homeDir(), 'reports')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  let file = join(dir, `${input.date}.html`)
  if (input.error !== null) {
    // a failed rerun must not replace the morning's live report; a missing marker is unknown, so it is kept too
    const prev = await readFile(file, 'utf8').catch(() => null)
    if (prev !== null && !['dry', 'error'].includes(reportKind(prev) ?? '')) {
      file = join(dir, `${input.date}-error.html`)
    }
  }
  await writeFile(file, renderReport(input), { mode: 0o600 })
  return file
}

const retryWith = (budget: RetryBudget): Retry => (fn) => withRateLimitRetry(fn, { budget })

class ChangedThreadError extends Error {}

// Every attempt after the first re-checks for new mail, so a delayed archive cannot hide a reply that arrived meanwhile.
const retryTriage = (g: GmailLike, t: ThreadInput, budget: RetryBudget): Retry => {
  let attempts = 0
  return (fn) => withRateLimitRetry(async () => {
    if (attempts++ > 0 && (await newestUnreadId(g, t.threadId, budget)) !== t.messageId) {
      throw new ChangedThreadError('new mail arrived')
    }
    return await fn()
  }, { budget })
}

const undoCtx = (repo: string): { repo: string, home: string | null } => ({ repo, home: process.env.GMAIL_TRIAGE_HOME ?? null })

export const errorInput = (date: string, mode: 'dry' | 'live', error: string, repo: string): ReportInput =>
  ({ date, mode, keptByFloor: 0, inbox: null, open: null, swept: null, ifLive: null, ...undoCtx(repo), rows: [], failed: [], dupes: [], dupArchived: 0, dupProtected: 0, unsub: [], error })

// Newest message still carrying UNREAD: our own sent replies must not block triage.
const newestUnreadId = async (g: GmailLike, id: string, budget: RetryBudget): Promise<string | null> => {
  const { data } = await withRateLimitRetry(() => g.users.threads.get({ userId: 'me', id, format: 'minimal' }), { budget })
  let best: { id: string, at: number } | null = null
  for (const m of (data.messages ?? []) as { id?: string, labelIds?: string[], internalDate?: string }[]) {
    const at = Number(m.internalDate ?? 0)
    if (m.id && m.labelIds?.includes('UNREAD') && (best === null || at >= best.at)) {
      best = { id: m.id, at }
    }
  }
  return best?.id ?? null
}

const buildUnsub = async (g: GmailLike, rows: ReportRow[], byId: Map<string, ThreadInput>, budget: RetryBudget): Promise<{ unsub: UnsubRow[], capture: UnsubEntry[] }> => {
  const found = new Map<string, UnsubEntry>()
  for (const r of rows) {
    const t = byId.get(r.threadId)
    if (r.bucket === 'unsubscribe' && t) {
      addCapture(found, t)
    }
  }
  const unsub: UnsubRow[] = []
  for (const [sender, e] of found) {
    // the count is context only, so a failed lookup is n/a, never 0, and must not lose the report
    const count30d = await senderCount30d(g as unknown as gmail_v1.Gmail, sender, budget).catch(() => null)
    unsub.push({ sender, count30d, link: e.httpsUrl !== null ? { kind: 'https', href: e.httpsUrl } : { kind: 'mailto', href: e.mailto! } })
  }
  return { unsub, capture: [...found.values()] }
}

// Any failure or the deadline gives null, never a guess; the signal cancels in-flight calls.
const withDeadline = async <T>(deadlineMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T | null> => {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), deadlineMs)
  const deadline = new Promise<never>((_, reject) => ac.signal.addEventListener('abort', () => reject(new Error('deadline')), { once: true }))
  try {
    return await Promise.race([fn(ac.signal), deadline])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// Lists every unread inbox id once and files it into exactly one bucket.
const countInbox = (g: gmail_v1.Gmail, budget: RetryBudget, deadlineMs: number, bucketOf: (id: string) => 'today' | 'earlier' | 'triage'): Promise<InboxSplit | null> =>
  withDeadline(deadlineMs, async (signal) => {
    const { ids, capped } = await listUnreadIds(g, budget, signal)
    const split: InboxSplit = { total: 0, keptToday: 0, keptEarlier: 0, toTriage: 0, capped }
    for (const id of ids) {
      const b = bucketOf(id)
      split.total++
      split[b === 'today' ? 'keptToday' : b === 'earlier' ? 'keptEarlier' : 'toTriage']++
    }
    return split
  })

const OPEN_NAMES = [LABEL_NAME.urgent, LABEL_NAME.attention]

// Report shape: aged against now, minus threads the sweep archived.
const agedOpen = (byName: Map<string, OpenList>, now: Date, gone: Set<string> = new Set()): OpenInbox => {
  const aged = (l: OpenList | undefined) => ({ rest: (l?.rest ?? []).filter((id) => !gone.has(id)), rows: (l?.rows ?? []).filter((r) => !gone.has(r.threadId)).map(({ lastAt, messageId: _m, ...r }) => ({ ...r, ageDays: Math.max(0, Math.floor((now.getTime() - lastAt) / 86_400_000)) })) })
  return { urgent: aged(byName.get(LABEL_NAME.urgent)), attention: aged(byName.get(LABEL_NAME.attention)) }
}

// Urgent and attention threads still in the inbox from any run, aged against now.
const openInbox = async (g: gmail_v1.Gmail, budget: RetryBudget, deadlineMs: number, now: Date): Promise<OpenInbox | null> => {
  const byName = await withDeadline(deadlineMs, (signal) => listOpenByLabel(g, OPEN_NAMES, budget, signal))
  return byName === null ? null : agedOpen(byName, now)
}

// Plans the sweep from the open list on the run's own budget (skipped once it is spent); a dry run or an empty plan writes nothing,
const sweepOpen = async (g: GmailLike, byName: Map<string, OpenList>, dry: boolean, date: string, deps: Deps, budget: RetryBudget): Promise<{ swept: SweepPlan, failed: SweepRow[] }> => {
  const none = { swept: { resolved: [], stale: [] }, failed: [] }
  if (budget.exhausted) {
    return none
  }
  const plan = planSweep(byName, deps.now().getTime(), deps.pins)
  if (dry || plan.resolved.length + plan.stale.length === 0) {
    return { swept: plan, failed: [] }
  }
  try {
    const labels = await ensureLabels(g.users.labels, retryWith(budget))
    const me = (await withRateLimitRetry(() => g.users.getProfile({ userId: 'me' }), { budget })).data.emailAddress ?? ''
    const directHumanUnread = (t: gmail_v1.Schema$Thread): boolean => toThreadInput(t, me, deps.pins.myAddresses, deps.pins.automatedDomains)?.humanDirectUnread ?? false
    const { done, failed } = await applySweep(g.users.threads, plan, labels, date, budget, directHumanUnread)
    return { swept: done, failed }
  } catch {
    console.error('sweep: could not resolve its labels, nothing archived')
    return none
  }
}

// The thrown message can carry email content, so only its first line, stripped, reaches the local log.
const classifyWithRetry = async (deps: Deps, batch: ThreadInput[], n: number): Promise<unknown> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await deps.classify(batch, deps.pins)
    } catch (e) {
      console.error(`classify failed (batch ${n}, attempt ${attempt}): ${stripControl((e instanceof Error ? e.message : 'unknown error').split('\n')[0])}`)
      if (attempt >= 2) {
        throw e
      }
      // a dropped connection gets a moment to come back before the retry
      await (deps.sleep ?? realSleep)(CLASSIFY_RETRY_MS)
    }
  }
}

export const runTriage = async (deps: Deps, opts: { dryRun: boolean }): Promise<RunResult | null> => {
  const release = await acquireLock()
  if (release === null) {
    console.log('already running')
    return null
  }
  try {
    const state = await loadState()
    const dry = opts.dryRun || state.mode === 'dry'
    const mode = dry ? 'dry' : 'live'
    const date = localDate(deps.now())
    const budget = createRetryBudget({ maxSleepMs: deps.retryBudgetMs, sleep: deps.sleep ?? realSleep })
    const finish = async (input: ReportInput, failed: string[] = []): Promise<RunResult> => ({ reportFile: await writeReport(input), input, failed, quotaExhausted: budget.exhausted })

    let g: GmailLike
    try {
      g = await retryNetwork(() => deps.gmail(), deps.sleep ?? realSleep)
    } catch (e) {
      if (e instanceof AuthError) {
        return await finish(errorInput(date, mode, e.message.includes('gmail-triage auth') ? e.message : AUTH_FAILED, deps.repo))
      }
      throw e
    }

    // read-only, so a restart from the profile call is safe
    let fetched: Awaited<ReturnType<typeof fetchUnreadThreads>>
    try {
      fetched = await retryNetwork(() => fetchUnreadThreads(g as unknown as gmail_v1.Gmail, CAP, (id, messageId) => state.processed[id] === messageId, budget, deps.pins.myAddresses, deps.pins.automatedDomains), deps.sleep ?? realSleep)
    } catch (e) {
      if (e instanceof QuotaExhaustedError) {
        return await finish(errorInput(date, mode, QUOTA_EXHAUSTED, deps.repo))
      }
      throw e
    }
    const { dupes, protectedOlder } = groupDuplicates(fetched.threads, deps.pins)
    // collapsed and protected older copies skip the classifier; protected ones are never written to at all
    const olderIds = new Set([...dupes.flatMap((d) => d.older), ...protectedOlder].map((t) => t.threadId))
    const threads = fetched.threads.filter((t) => !olderIds.has(t.threadId))

    const buckets = new Map<string, { bucket: Bucket, reason: string }>()
    const keptIds = new Set<string>()
    const unclassified: ThreadInput[] = []
    // one retry per batch; a batch that still fails stays in the inbox as failed rows and the other batches still apply
    for (let i = 0; i < threads.length; i += BATCH) {
      const batch = threads.slice(i, i + BATCH)
      let raw: unknown
      try {
        raw = await classifyWithRetry(deps, batch, i / BATCH + 1)
      } catch {
        unclassified.push(...batch)
        continue
      }
      const verdicts = validateVerdicts(batch, raw)
      for (const t of batch) {
        const v = verdicts.get(t.threadId)!
        const pinned = applyPins(t.from, v.bucket, deps.pins)
        const bucket = applyDirectMailFloor(t, pinned)
        if (bucket !== pinned) {
          keptIds.add(t.threadId)
        }
        buckets.set(t.threadId, { bucket, reason: bucket === pinned ? v.reason : `${v.reason} (kept: direct mail)` })
      }
    }
    if (threads.length > 0 && unclassified.length === threads.length) {
      // nothing classified: the error report still shows what is open in the inbox
      return await finish({ ...errorInput(date, mode, CLASSIFY_FAILED, deps.repo), open: await openInbox(g as unknown as gmail_v1.Gmail, createRetryBudget({ maxSleepMs: COUNT_BUDGET_MS, sleep: deps.sleep ?? realSleep }), deps.countDeadlineMs ?? COUNT_DEADLINE_MS, deps.now()) })
    }
    const classified = threads.filter((t) => buckets.has(t.threadId))

    const failed: string[] = unclassified.map((t) => t.threadId)
    const failedRows: FailedRow[] = unclassified.map((t) => ({ threadId: t.threadId, from: t.from, subject: t.subject, reason: 'classify failed' }))
    const dupDone = new Map<string, number>()
    const done: ThreadInput[] = []
    if (dry) {
      done.push(...classified)
      for (const d of dupes) {
        dupDone.set(d.newest.threadId, d.older.length)
      }
    } else if (classified.length > 0) {
      const retry = retryWith(budget)
      let exhausted = false
      let labelIds = {} as Awaited<ReturnType<typeof ensureLabels>>
      try {
        labelIds = await ensureLabels(g.users.labels, retry)
      } catch (e) {
        if (!(e instanceof QuotaExhaustedError)) {
          throw e
        }
        exhausted = true
      }
      const { duplicate: _dup, archivedOld: _old, resolved: _res, stale: _stale, ...bucketIds } = labelIds
      const triageIds = new Set(Object.values(bucketIds))
      // one per-thread flow for triage and dedupe: recheck for new mail, log, guarded write, then the processed marker
      const processOne = async (t: ThreadInput, bucket: Bucket | undefined, entry: RunEntry, apply: (retry: Retry) => Promise<void>): Promise<boolean> => {
        const failRow = (why: string): FailedRow => ({ threadId: t.threadId, from: t.from, subject: t.subject, reason: why, bucket })
        // a thread-wide archive must not hide mail that arrived after classification
        // shortcut: ms race between this check and modify remains; acceptable for a daily job
        if (exhausted) {
          failed.push(t.threadId)
          failedRows.push(failRow('gmail quota exhausted'))
          return false
        }
        let changed: boolean
        try {
          changed = (await newestUnreadId(g, t.threadId, budget)) !== t.messageId
        } catch (e) {
          exhausted = e instanceof QuotaExhaustedError
          failed.push(t.threadId)
          failedRows.push(failRow(exhausted ? 'gmail quota exhausted' : 'gmail read failed'))
          return false
        }
        if (changed) {
          failedRows.push(failRow('new mail arrived'))
          return false
        }
        await appendRunEntry(date, entry)
        try {
          await apply(retryTriage(g, t, budget))
        } catch (e) {
          if (e instanceof ChangedThreadError) {
            failedRows.push(failRow('new mail arrived'))
            return false
          }
          exhausted = e instanceof QuotaExhaustedError
          failed.push(t.threadId)
          failedRows.push(failRow(exhausted ? 'gmail quota exhausted' : 'gmail write failed'))
          return false
        }
        state.processed[t.threadId] = t.messageId
        await saveState(state)
        return true
      }
      for (const t of classified) {
        const { bucket } = buckets.get(t.threadId)!
        const action = actionFor(bucket)
        const labelId = labelIds[bucket]
        // a re-triaged thread loses its previous bucket label; the entry logs it so undo can put it back
        const stale = t.labelIds.filter((id) => triageIds.has(id) && id !== labelId)
        const entry: RunEntry = { opId: randomUUID(), threadId: t.threadId, messageId: t.messageId, bucket, labelId, starred: action.star, archived: action.archive, ...(stale.length > 0 ? { removedLabelIds: stale } : {}) }
        if (await processOne(t, bucket, entry, (retry) => applyTriage(g.users.threads, t.threadId, triageBody(labelId, action, stale), triageIds, retry))) {
          done.push(t)
        }
      }
      const dupLabel = labelIds.duplicate
      for (const d of dupes) {
        for (const t of d.older) {
          const entry: RunEntry = { kind: 'dedupe', opId: randomUUID(), threadId: t.threadId, messageId: t.messageId, labelId: dupLabel }
          if (await processOne(t, undefined, entry, (retry) => applyDedupe(g.users.threads, t.threadId, dedupeBody(dupLabel), dupLabel, retry))) {
            dupDone.set(d.newest.threadId, (dupDone.get(d.newest.threadId) ?? 0) + 1)
          }
        }
      }
    }

    const rows: ReportRow[] = done.map((t) => ({ threadId: t.threadId, from: t.from, subject: t.subject, reason: buckets.get(t.threadId)!.reason, bucket: buckets.get(t.threadId)!.bucket }))
    const dupRows: DupeRow[] = dupes.filter((d) => (dupDone.get(d.newest.threadId) ?? 0) > 0).map((d) => ({ threadId: d.newest.threadId, from: d.newest.from, subject: d.newest.subject, older: dupDone.get(d.newest.threadId)! }))
    const dupArchived = dupRows.reduce((n, d) => n + d.older, 0)
    const { unsub, capture } = await buildUnsub(g, rows, new Map(done.map((t) => [t.threadId, t])), budget)
    await writeUnsubCapture(date, capture)
    // Counted after every write, on its own retry budget and a wall-clock deadline: a slow count must never block the report or the lock release.
    const retained = done.filter((t) => !actionFor(buckets.get(t.threadId)!.bucket).archive)
    // a dry run writes nothing, so it retained nothing: the split counts the real inbox
    const keptToday = new Set(dry ? [] : [...retained.map((t) => t.threadId), ...protectedOlder.map((t) => t.threadId)])
    const touched = new Set(fetched.threads.map((t) => t.threadId))
    const countBudget = () => createRetryBudget({ maxSleepMs: COUNT_BUDGET_MS, sleep: deps.sleep ?? realSleep })
    const rawOpen = await withDeadline(deps.countDeadlineMs ?? COUNT_DEADLINE_MS, (signal) => listOpenByLabel(g as unknown as gmail_v1.Gmail, OPEN_NAMES, countBudget(), signal))
    // the sweep archives before the count, so the split and the open list match the inbox it leaves
    const sweep = rawOpen === null ? null : await sweepOpen(g, rawOpen, dry, date, deps, budget)
    const swept = sweep?.swept ?? null
    for (const r of sweep?.failed ?? []) {
      failed.push(r.threadId)
      failedRows.push({ threadId: r.threadId, from: r.from, subject: r.subject, reason: 'sweep archive failed' })
    }
    const open = rawOpen === null ? null : agedOpen(rawOpen, deps.now(), dry || swept === null ? new Set() : new Set([...swept.resolved, ...swept.stale].map((r) => r.threadId)))
    const inbox = await countInbox(g as unknown as gmail_v1.Gmail, countBudget(), deps.countDeadlineMs ?? COUNT_DEADLINE_MS, (id) => keptToday.has(id) ? 'today' : state.processed[id] !== undefined && !touched.has(id) ? 'earlier' : 'triage')
    // the dry run's own decisions, never derived from the listing
    const ifLive = dry ? { archive: done.length - retained.length + dupArchived, duplicates: dupArchived, keep: retained.length + protectedOlder.length } : null
    return await finish({ date, mode, keptByFloor: done.filter((t) => keptIds.has(t.threadId)).length, inbox, open, swept, ifLive, ...undoCtx(deps.repo), rows, failed: failedRows, dupes: dupRows, dupArchived, dupProtected: protectedOlder.length, unsub, error: null }, failed)
  } finally {
    await release()
  }
}

export const exitCodeOf = (res: RunResult | null): number => (res !== null && (res.input.error !== null || res.failed.length > 0 || res.quotaExhausted) ? 1 : 0)

// undo and go-live share the run lock so they cannot interleave with a run that is writing state.
const withLock = async <T>(fn: () => Promise<T>): Promise<T | null> => {
  const release = await acquireLock()
  if (release === null) {
    console.log('already running')
    return null
  }
  try {
    return await fn()
  } finally {
    await release()
  }
}

export const runUndo = (gmail: () => Promise<GmailLike>, date: string, sleep: Sleep = realSleep) =>
  withLock(async () => {
    const r = await undoRun((await gmail()).users.threads, date, retryWith(createRetryBudget({ sleep })))
    return { restored: r.restored, skipped: r.skipped, superseded: r.superseded.length }
  })

export const goLive = (): Promise<true | null> =>
  withLock(async () => {
    await saveState({ ...(await loadState()), mode: 'live' })
    return true as const
  })

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Rebuilds a day's unsubscribe capture from its run log; reads Gmail only, never writes.
export const runUnsubCapture = async (gmail: () => Promise<GmailLike>, date: string, io: { out: (s: string) => void, err: (s: string) => void } = { out: console.log, err: console.error }, sleep: Sleep = realSleep): Promise<number> => {
  if (!DATE_RE.test(date)) {
    io.err('usage: unsubscribe-capture <YYYY-MM-DD>')
    return 2
  }
  const release = await acquireLock()
  if (release === null) {
    io.out('already running')
    return 0
  }
  try {
    let log: RunEntry[]
    try {
      log = await readRun(date)
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('no run log')) {
        io.err(e.message)
        return 2
      }
      throw e
    }
    // every distinct logged message is replayed: a thread can hold several classified messages
    const ids = new Map<string, Set<string>>()
    for (const e of log) {
      if ((e.kind === undefined || e.kind === 'triage') && e.bucket === 'unsubscribe') {
        ids.set(e.threadId, (ids.get(e.threadId) ?? new Set()).add(e.messageId))
      }
    }
    const g = await gmail()
    const budget = createRetryBudget({ sleep })
    const found = new Map<string, UnsubEntry>()
    let unreadable = 0
    for (const [threadId, messageIds] of ids) {
      let data: { messages?: { id?: string, labelIds?: string[] }[] }
      try {
        data = (await withRateLimitRetry(() => g.users.threads.get({ userId: 'me', id: threadId, format: 'metadata', metadataHeaders: HEADERS }), { budget })).data
      } catch {
        unreadable += messageIds.size
        continue
      }
      for (const messageId of messageIds) {
        // only the logged message counts as unread, so a thread read since the run still parses the headers the run saw
        const messages = (data.messages ?? []).map((m) => ({ ...m, labelIds: [...(m.labelIds ?? []).filter((l) => l !== 'UNREAD'), ...(m.id === messageId ? ['UNREAD'] : [])] }))
        const t = toThreadInput({ ...data, id: threadId, messages }, '')
        if (t === null) {
          unreadable++
        } else {
          addCapture(found, t)
        }
      }
    }
    await writeUnsubCapture(date, [...found.values()])
    io.out(`captured ${found.size} senders, ${[...found.values()].filter((e) => e.oneClick).length} one-click`)
    if (unreadable > 0) {
      io.err(`${unreadable} logged message(s) could not be read`)
      return 1
    }
    return 0
  } finally {
    await release()
  }
}
