import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homeDir } from './paths.ts'
import type { ReportInput } from './report.ts'
import { acquireLock, loadState, saveState } from './state.ts'

// Same pattern as the SessionStart hook: nothing else may reach the model as a URL.
export const ARTIFACT_URL_RE = /^https:\/\/claude\.ai\/[A-Za-z0-9/_-]+$/

export const notify = (title: string, body: string, bin: string = process.env.OSASCRIPT_BIN ?? 'osascript'): Promise<void> => new Promise((done) => {
  // title and body travel as argv, so mail-derived text never becomes AppleScript source
  const args = ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body]
  execFile(bin, args, (err) => {
    if (err) {
      console.error('notification failed')
    }
    done()
  })
})

export const GEN_RE = /^[0-9a-f]{32}$/

const CLAIMED_RE = /^pending-publish\.claimed\.\d+$/

// The hook renames the marker to pending-publish.claimed.<epoch> when a session takes it.
const claimedFiles = async (): Promise<string[]> =>
  (await readdir(homeDir()).catch(() => [] as string[])).filter((n) => CLAIMED_RE.test(n)).map((n) => join(homeDir(), n))

// The marker write and the ack read-compare-delete must not interleave; a run holds the lock for minutes, so wait a while.
const withLockWait = async <T>(fn: () => Promise<T>): Promise<T | null> => {
  for (let i = 0; i < 50; i++) {
    const release = await acquireLock()
    if (release !== null) {
      try {
        return await fn()
      } finally {
        await release()
      }
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return null
}

// Headless claude has no Artifact tool, so the marker (path + generation id) hands the report to the next interactive session.
export const publishAndNotify = async (reportFile: string, summary: string): Promise<void> => {
  const file = resolve(reportFile)
  try {
    await mkdir(homeDir(), { recursive: true, mode: 0o700 })
    const wrote = await withLockWait(async () => {
      // a new report supersedes any claim of an older one
      for (const c of await claimedFiles()) {
        await rm(c, { force: true })
      }
      await writeFile(join(homeDir(), 'pending-publish'), `${file}\n${randomBytes(16).toString('hex')}\n`, { mode: 0o600 })
    })
    if (wrote === null) {
      throw new Error('could not take the run lock to write pending-publish')
    }
  } catch (e) {
    await notify('Inbox triage', `Inbox triage: report at ${file}`)
    throw e
  }
  await notify('Inbox triage ready', `${summary} — opens in your next Claude Code session`)
}

// Counts only: subjects and senders never reach a notification.
export const summaryOf = (input: ReportInput): string => {
  if (input.error !== null) {
    return input.error
  }
  const n = (f: (r: ReportInput['rows'][number]) => boolean): number => input.rows.filter(f).length
  const archived = n((r) => r.bucket !== 'urgent' && r.bucket !== 'attention')
  return `${archived} archived, ${n((r) => r.bucket === 'urgent')} urgent, ${n((r) => r.bucket === 'attention')} attention${input.mode === 'dry' ? ' (dry run)' : ''}`
}

export type Ack = 'cleared' | 'newer' | 'busy'

// The ack names the generation it published, so a newer pending report is never deleted by a stale ack.
export const markPublished = async (url: string, gen: string): Promise<Ack> => {
  const done = await withLockWait(async (): Promise<Ack> => {
    await saveState({ ...(await loadState()), artifactUrl: url })
    for (const c of await claimedFiles()) {
      if (await readFile(c, 'utf8').then((t) => t.split('\n')[1] === gen, () => false)) {
        await rm(c, { force: true })
      }
    }
    const file = join(homeDir(), 'pending-publish')
    const current = await readFile(file, 'utf8').then((t) => t.split('\n')[1], () => null)
    if (current !== null && current !== gen) {
      return 'newer'
    }
    await rm(file, { force: true })
    return 'cleared'
  })
  return done ?? 'busy'
}
