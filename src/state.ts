import { appendFile, link, mkdir, readFile, rename, rm, truncate, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { homeDir } from './paths.ts'
import { BUCKETS } from './buckets.ts'
import type { Bucket } from './types.ts'

export { homeDir }

export type State = { mode: 'dry' | 'live', artifactUrl: string | null, processed: Record<string, string> }
// opId is absent on logs and receipts written before operation ids existed.
export type Undone = { threadId: string, messageId: string, opId?: string }
export type TriageEntry = { kind?: 'triage', opId?: string, threadId: string, messageId: string, bucket: Bucket, labelId: string, starred: boolean, archived: boolean, removedLabelIds?: string[] }
// An older duplicate copy: marked read, labeled and archived; undo restores UNREAD and INBOX.
export type DedupeEntry = { kind: 'dedupe', opId?: string, threadId: string, messageId: string, labelId: string }
// A read thread archived by archive-old: never in state.processed, undo restores INBOX only while messageId is still the newest.
export type ArchiveOldEntry = { kind: 'archiveOld', opId?: string, threadId: string, messageId: string, labelId: string }
export type RunEntry = TriageEntry | DedupeEntry | ArchiveOldEntry

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const ensureHome = async (sub = ''): Promise<string> => {
  const dir = join(homeDir(), sub)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

const runFile = async (date: string, suffix: string): Promise<string> => {
  if (!DATE_RE.test(date)) {
    throw new Error(`invalid date: ${date}`)
  }
  return join(await ensureHome('runs'), `${date}${suffix}`)
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const parseState = (raw: string): State => {
  const fail = (why: string): never => {
    throw new Error(`state.json is corrupt (${why}); fix or remove it, refusing to reset to defaults`)
  }
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return fail('bad JSON')
  }
  if (!isRecord(v) || (v.mode !== 'dry' && v.mode !== 'live') || !(v.artifactUrl === null || typeof v.artifactUrl === 'string') || !isRecord(v.processed)) {
    return fail('wrong shape')
  }
  if (!Object.values(v.processed).every((x) => typeof x === 'string')) {
    return fail('processed values must be strings')
  }
  return { mode: v.mode, artifactUrl: v.artifactUrl, processed: v.processed as Record<string, string> }
}

export const loadState = async (): Promise<State> => {
  let raw: string
  try {
    raw = await readFile(join(homeDir(), 'state.json'), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { mode: 'dry', artifactUrl: null, processed: {} }
    }
    throw err
  }
  return parseState(raw)
}

export const saveState = async (s: State): Promise<void> => {
  const dir = await ensureHome()
  const tmp = join(dir, `state.json.${process.pid}.tmp`)
  await writeFile(tmp, JSON.stringify(s, null, 2), { mode: 0o600 })
  await rename(tmp, join(dir, 'state.json'))
}

// The legacy: prefix is reserved for the ids readRunOps derives for entries without one.
const validOpId = (v: unknown): boolean => v === undefined || (typeof v === 'string' && v !== '' && !v.startsWith('legacy:'))

const isEntry = (v: unknown): v is RunEntry =>
  isRecord(v) && typeof v.threadId === 'string' && typeof v.messageId === 'string' && typeof v.labelId === 'string' && validOpId(v.opId)
  && (v.kind === 'dedupe' || v.kind === 'archiveOld'
    ? v.labelId !== ''
    : (v.kind === undefined || v.kind === 'triage') && typeof v.starred === 'boolean' && typeof v.archived === 'boolean' && (BUCKETS as readonly unknown[]).includes(v.bucket)
      && (v.removedLabelIds === undefined || (Array.isArray(v.removedLabelIds) && v.removedLabelIds.every((id) => typeof id === 'string' && id !== '' && id !== v.labelId))))

const isUndone = (v: unknown): v is Undone => isRecord(v) && typeof v.threadId === 'string' && typeof v.messageId === 'string' && (v.opId === undefined || typeof v.opId === 'string')

const parses = (s: string): boolean => {
  try {
    JSON.parse(s)
    return true
  } catch {
    return false
  }
}

// A log line is written before its Gmail call, so a torn tail is a write that never happened: park it and drop it.
const appendLine = async (file: string, v: unknown): Promise<void> => {
  let buf = Buffer.alloc(0)
  try {
    buf = await readFile(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err
    }
  }
  if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) {
    const cut = buf.lastIndexOf(0x0a) + 1
    const tail = buf.subarray(cut)
    if (parses(tail.toString('utf8'))) {
      await appendFile(file, '\n')
    } else {
      await appendFile(`${file}.torn`, Buffer.concat([tail, Buffer.from('\n')]), { mode: 0o600 })
      await truncate(file, cut)
    }
  }
  await appendFile(file, `${JSON.stringify(v)}\n`, { mode: 0o600 })
}

const readLinesAt = async <T>(file: string, label: string, ok: (v: unknown) => v is T): Promise<{ v: T, line: number }[] | null> => {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw err
  }
  const lines = raw.split('\n')
  const out: { v: T, line: number }[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') {
      continue
    }
    let v: unknown
    try {
      v = JSON.parse(lines[i])
    } catch {
      if (i === lines.length - 1) {
        console.error(`${label}: ignoring torn final line ${i + 1}`)
        continue
      }
      throw new Error(`${label} line ${i + 1} is not JSON`)
    }
    if (!ok(v)) {
      throw new Error(`${label} line ${i + 1} is not a valid entry`)
    }
    out.push({ v, line: i + 1 })
  }
  return out
}

const readLines = async <T>(file: string, label: string, ok: (v: unknown) => v is T): Promise<T[] | null> => (await readLinesAt(file, label, ok))?.map((x) => x.v) ?? null

export const appendRunEntry = async (date: string, e: RunEntry): Promise<void> => {
  await appendLine(await runFile(date, '.jsonl'), e)
}

const readRunAt = async (date: string): Promise<{ v: RunEntry, line: number }[]> => {
  const entries = await readLinesAt(await runFile(date, '.jsonl'), `run log ${date}`, isEntry)
  if (entries === null) {
    throw new Error(`no run log for ${date}`)
  }
  return entries
}

export const readRun = async (date: string): Promise<RunEntry[]> => (await readRunAt(date)).map((x) => x.v)

// Every entry with its operation id; an entry written before ids existed gets a stable one from its position in the file.
export const readRunOps = async (date: string): Promise<{ entry: RunEntry, opId: string, legacy: boolean }[]> =>
  (await readRunAt(date)).map(({ v, line }) => v.opId !== undefined
    ? { entry: v, opId: v.opId, legacy: false }
    : { entry: v, opId: `legacy:${v.kind ?? 'triage'}:${v.threadId}:${v.messageId}:${line}`, legacy: true })

export const appendUndone = async (date: string, u: Undone): Promise<void> => {
  await appendLine(await runFile(date, '.undone.jsonl'), u)
}

export const readUndone = async (date: string): Promise<Undone[]> => (await readLines(await runFile(date, '.undone.jsonl'), `undo log ${date}`, isUndone)) ?? []

// Write the pid to a private temp file, then link it into place: the lock never exists empty, and link fails with EEXIST if held.
const publishLock = async (path: string, beforeLink?: () => Promise<void>): Promise<boolean> => {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, String(process.pid), { mode: 0o600, flag: 'wx' })
    await beforeLink?.()
    await link(tmp, path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return false
    }
    throw err
  } finally {
    await rm(tmp, { force: true })
  }
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

export type LockOpts = { alive?: (pid: number) => boolean, afterGuard?: () => Promise<void>, beforeLink?: () => Promise<void> }

// alive, afterGuard and beforeLink are test seams; afterGuard runs once the takeover guard is held, before the lock is judged.
export const acquireLock = async (opts: LockOpts = {}): Promise<(() => Promise<void>) | null> => {
  const alive = opts.alive ?? pidAlive
  const lock = join(await ensureHome(), 'run.lock')
  const guard = `${lock}.takeover`
  const judge = async (): Promise<'missing' | 'alive' | 'stale'> => {
    let raw: string
    try {
      raw = await readFile(lock, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return 'missing'
      }
      throw err
    }
    const pid = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : 0
    return pid > 0 && pid <= 2147483647 && alive(pid) ? 'alive' : 'stale'
  }
  const owned = async (): Promise<boolean> => {
    if (await publishLock(lock, opts.beforeLink)) {
      return true
    }
    const first = await judge()
    if (first === 'alive') {
      return false
    }
    if (first === 'missing') {
      return publishLock(lock, opts.beforeLink)
    }
    if (!(await publishLock(guard))) {
      console.error(`stale takeover guard at ${guard}; remove it if no run is active`)
      return false
    }
    try {
      await opts.afterGuard?.()
      // Only a guard holder may remove the lock, and the verdict is read right before the rm.
      const verdict = await judge()
      if (verdict === 'alive') {
        return false
      }
      if (verdict === 'stale') {
        await rm(lock, { force: true })
      }
    } finally {
      await rm(guard, { force: true })
    }
    return publishLock(lock, opts.beforeLink)
  }
  if (!(await owned())) {
    return null
  }
  return async () => {
    try {
      if ((await readFile(lock, 'utf8')) === String(process.pid)) {
        await rm(lock, { force: true })
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err
      }
    }
  }
}
