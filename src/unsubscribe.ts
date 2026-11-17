import { lookup as dnsLookup } from 'node:dns/promises'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { stripControl } from './gmail.ts'
import { homeDir } from './paths.ts'
import { fromMailbox } from './pins.ts'
import { unsubLinks } from './report.ts'
import { acquireLock } from './state.ts'
import type { ThreadInput } from './types.ts'

export type UnsubEntry = { sender: string, httpsUrl: string | null, mailto: string | null, oneClick: boolean, threadId: string }
export type Resolved = { address: string, family: number }
export type RequestFn = (options: RequestOptions, cb: (res: IncomingMessage) => void) => ClientRequest
export type UnsubDeps = {
  request?: RequestFn, lookup?: (host: string, opts: { all: true }) => Promise<Resolved[]>, now?: () => Date, out?: (line: string) => void, timeoutMs?: number, acquire?: typeof acquireLock,
}
export type UnsubOpts = { yes: boolean, retryUnknown?: boolean }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const BODY = 'List-Unsubscribe=One-Click'
const TIMEOUT_MS = 10_000

// One-click needs the exact RFC 8058 token and an https target.
export const isOneClick = (post: string | null, https: string | null): boolean => https !== null && post?.trim().toLowerCase() === 'list-unsubscribe=one-click'

// One row per sender mailbox, first thread wins; shared by the run and the backfill.
export const addCapture = (found: Map<string, UnsubEntry>, t: ThreadInput): void => {
  const sender = fromMailbox(t.from)
  if (!t.listUnsubscribe || sender === null || found.has(sender)) {
    return
  }
  const { https, mailto } = unsubLinks(t.listUnsubscribe)
  if (https !== null || mailto !== null) {
    found.set(sender, { sender, httpsUrl: https, mailto, oneClick: isOneClick(t.listUnsubscribePost, https), threadId: t.threadId })
  }
}

const v4Octets = (s: string): number[] | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  const o = m === null ? [] : m.slice(1).map(Number)
  return m !== null && o.every((n) => n <= 255) ? o : null
}

const blockedV4 = (o: number[]): boolean =>
  o[0] === 0 || o[0] === 10 || o[0] === 127 || (o[0] === 169 && o[1] === 254) || (o[0] === 172 && o[1] >= 16 && o[1] <= 31)
  || (o[0] === 192 && o[1] === 168) || (o[0] === 100 && o[1] >= 64 && o[1] <= 127) || o[0] >= 224

// Eight 16-bit groups, or null for anything malformed (which the caller blocks).
const v6Groups = (addr: string): number[] | null => {
  let s = addr.split('%')[0].toLowerCase()
  const dot = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (dot) {
    const o = v4Octets(dot[2])
    if (o === null) {
      return null
    }
    s = `${dot[1]}${(o[0] * 256 + o[1]).toString(16)}:${(o[2] * 256 + o[3]).toString(16)}`
  }
  const parts = s.split('::')
  if (parts.length > 2) {
    return null
  }
  const side = (x: string): string[] => (x === '' ? [] : x.split(':'))
  const head = side(parts[0])
  const tail = parts.length === 2 ? side(parts[1]) : []
  const fill = 8 - head.length - tail.length
  if (parts.length === 2 ? fill < 1 : fill !== 0) {
    return null
  }
  const nums = [...head, ...Array<string>(parts.length === 2 ? fill : 0).fill('0'), ...tail].map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN))
  return nums.some(Number.isNaN) ? null : nums
}

const octets = (hi: number, lo: number): number[] => [hi >> 8, hi & 255, lo >> 8, lo & 255]

// Fails closed: an address that does not parse is blocked.
export const isBlockedAddress = (addr: string): boolean => {
  const v4 = v4Octets(addr)
  if (v4 !== null) {
    return blockedV4(v4)
  }
  const g = v6Groups(addr)
  if (g === null) {
    return true
  }
  const zeros = (from: number, to: number): boolean => g.slice(from, to).every((x) => x === 0)
  // :: and ::1 land here too (embedded 0.0.0.x), as do IPv4-mapped and IPv4-compatible forms
  if (zeros(0, 5) && (g[5] === 0 || g[5] === 0xffff)) {
    return blockedV4(octets(g[6], g[7]))
  }
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) {
    return blockedV4(octets(g[6], g[7]))
  }
  if (g[0] === 0x2002) {
    return blockedV4(octets(g[1], g[2]))
  }
  return (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xfe00) === 0xfc00 || (g[0] >> 8) === 0xff
}

// Returns the parsed URL, or null when the target fails the static checks; the address checks happen in pinnedLookup.
const staticGuard = (raw: string): URL | null => {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  const bad = u.protocol !== 'https:' || u.username !== '' || u.password !== '' || (u.port !== '' && u.port !== '443') || isIP(u.hostname.replace(/^\[|\]$/g, '')) !== 0
  return bad ? null : u
}

type LookupCb = (err: Error | null, address?: string | Resolved[], family?: number) => void

// The connection is pinned to the validated address: this lookup is the only resolution the socket uses.
export const pinnedLookup = (resolve: NonNullable<UnsubDeps['lookup']>) => (host: string, options: { all?: boolean }, cb: LookupCb): void => {
  resolve(host, { all: true }).then((addrs) => {
    if (addrs.length === 0 || addrs.some((a) => isBlockedAddress(a.address))) {
      cb(Object.assign(new Error('blocked host'), { code: 'BLOCKED_HOST' }))
    } else if (options.all) {
      cb(null, addrs)
    } else {
      cb(null, addrs[0].address, addrs[0].family)
    }
  }, (e: unknown) => cb(e instanceof Error ? e : new Error('lookup failed')))
}

// Carries whether the request body was flushed ('finish') when the error hit: after that the server may have acted on it.
class PostError extends Error {
  readonly cause: unknown
  readonly sent: boolean
  constructor(cause: unknown, sent: boolean) {
    super('request failed')
    this.cause = cause
    this.sent = sent
  }
}

// Resolves with the status as soon as the headers arrive; body cleanup errors are ignored.
const post = (u: URL, deps: { request: RequestFn, lookup: NonNullable<UnsubDeps['lookup']>, timeoutMs: number }): Promise<number> => new Promise((resolve, reject) => {
  let settled = false
  let sent = false
  let timer: NodeJS.Timeout | undefined
  const timeout = (): Error => Object.assign(new Error('timeout'), { name: 'TimeoutError' })
  const finish = (fn: () => void): void => {
    if (!settled) {
      settled = true
      clearTimeout(timer)
      fn()
    }
  }
  const req = deps.request({
    method: 'POST', protocol: 'https:', hostname: u.hostname, port: 443, path: `${u.pathname}${u.search}`, agent: false, lookup: pinnedLookup(deps.lookup) as RequestOptions['lookup'],
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'gmail-triage/1' },
  }, (res) => {
    finish(() => resolve(res.statusCode ?? 0))
    res.on('error', () => {})
    try {
      res.destroy()
    } catch {
      // cleanup only
    }
  })
  req.on('finish', () => {
    sent = true
  })
  req.on('error', (e) => finish(() => reject(new PostError(e, sent))))
  req.setTimeout(deps.timeoutMs, () => req.destroy(timeout()))
  timer = setTimeout(() => req.destroy(timeout()), deps.timeoutMs)
  req.end(BODY)
})

const isEntry = (v: unknown): v is UnsubEntry => {
  const e = v as Record<string, unknown> | null
  return typeof e === 'object' && e !== null && typeof e.sender === 'string' && (e.httpsUrl === null || typeof e.httpsUrl === 'string')
    && (e.mailto === null || typeof e.mailto === 'string') && typeof e.oneClick === 'boolean' && typeof e.threadId === 'string'
}

const unsubDir = (): string => join(homeDir(), 'unsub')

const readEntries = async (date: string): Promise<UnsubEntry[]> => {
  const v: unknown = JSON.parse(await readFile(join(unsubDir(), `${date}.json`), 'utf8'))
  if (!Array.isArray(v) || !v.every(isEntry)) {
    throw new Error('bad capture file')
  }
  return v
}

// Merged by sender so a second run the same day (which skips processed threads) cannot drop earlier senders.
export const writeUnsubCapture = async (date: string, entries: UnsubEntry[]): Promise<void> => {
  if (entries.length === 0) {
    return
  }
  const prev = await readEntries(date).catch(() => [] as UnsubEntry[])
  const merged = new Map([...prev, ...entries].map((e) => [e.sender, e]))
  await mkdir(unsubDir(), { recursive: true, mode: 0o700 })
  await writeFile(join(unsubDir(), `${date}.json`), JSON.stringify([...merged.values()], null, 2), { mode: 0o600 })
}

const hostOf = (url: string | null): string => {
  try {
    return url === null ? '-' : stripControl(new URL(url).hostname)
  } catch {
    return '-'
  }
}

type Outcome = 'done' | 'failed' | 'unknown'

// Old result lines carry no `sent` flag: only these were provably before the write (TLS codes stay unknown).
const LEGACY_DEFINITE_ERR = /^(blocked host|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)$/

// Any error after the body was flushed is unknown, whatever its code.
const isUnknownError = (r: { error: string, sent?: unknown }): boolean => (typeof r.sent === 'boolean' ? r.sent : !LEGACY_DEFINITE_ERR.test(r.error))

// The last line per sender wins: an attempt with no result after it is unknown.
const outcomesOf = async (file: string): Promise<Map<string, Outcome>> => {
  const out = new Map<string, Outcome>()
  for (const line of (await readFile(file, 'utf8').catch(() => '')).split('\n')) {
    try {
      const r = JSON.parse(line) as { sender?: unknown, phase?: unknown, status?: unknown, error?: unknown, sent?: unknown }
      if (typeof r.sender !== 'string') {
        continue
      }
      if (r.phase === 'attempt') {
        out.set(r.sender, 'unknown')
      } else if (typeof r.status === 'number') {
        out.set(r.sender, r.status >= 200 && r.status < 400 ? 'done' : 'failed')
      } else if (typeof r.error === 'string') {
        out.set(r.sender, isUnknownError({ error: r.error, sent: r.sent }) ? 'unknown' : 'failed')
      }
    } catch {
      // a torn or blank line records nothing
    }
  }
  return out
}

// fsync'd so an attempt line survives a crash right after it.
const appendDurable = async (file: string, v: object): Promise<void> => {
  const fh = await open(file, 'a', 0o600)
  try {
    await fh.write(`${JSON.stringify(v)}\n`)
    await fh.sync()
  } finally {
    await fh.close()
  }
}

// Codes and names only: a raw message can carry the URL, which holds a token.
const errCode = (e: unknown): string => {
  const name = (e as { name?: unknown } | null)?.name
  if (name === 'TimeoutError' || name === 'AbortError') {
    return 'timeout'
  }
  if ((e as { code?: unknown } | null)?.code === 'BLOCKED_HOST') {
    return 'blocked host'
  }
  const c = (e as { code?: unknown } | null)?.code ?? (e as { cause?: { code?: unknown } } | null)?.cause?.code
  return typeof c === 'string' && /^[A-Z][A-Z0-9_]{2,40}$/.test(c) ? c : 'request failed'
}

// Returns the process exit code.
export const runUnsubscribe = async (date: string, opts: UnsubOpts, deps: UnsubDeps = {}): Promise<number> => {
  const out = deps.out ?? console.log
  const request = deps.request ?? (httpsRequest as RequestFn)
  const lookup = deps.lookup ?? (dnsLookup as NonNullable<UnsubDeps['lookup']>)
  const now = deps.now ?? (() => new Date())
  if (!DATE_RE.test(date)) {
    console.error('usage: unsubscribe <YYYY-MM-DD> [--yes] [--retry-unknown]')
    return 2
  }
  const resultsFile = join(unsubDir(), `${date}.results.jsonl`)
  // everything the send list depends on is read after the lock, so a run that finished meanwhile is seen
  const plan = async (): Promise<{ entries: UnsubEntry[], outcomes: Map<string, Outcome>, pending: UnsubEntry[] } | null> => {
    let entries: UnsubEntry[]
    try {
      entries = await readEntries(date)
    } catch {
      console.error(`no usable unsubscribe capture for ${date}`)
      return null
    }
    const outcomes = await outcomesOf(resultsFile)
    const pending = entries.filter((e) => e.oneClick && e.httpsUrl !== null && outcomes.get(e.sender) !== 'done' && (outcomes.get(e.sender) !== 'unknown' || opts.retryUnknown === true))
    return { entries, outcomes, pending }
  }
  if (!opts.yes) {
    const p = await plan()
    if (p === null) {
      return 1
    }
    const mark = (e: UnsubEntry): string => {
      const o = p.outcomes.get(e.sender)
      return o === 'done' ? ' (already sent)' : o === 'unknown' ? ' (unknown outcome)' : ''
    }
    p.entries.forEach((e, i) => out(`${i + 1}. ${stripControl(e.sender)}  one-click: ${e.oneClick ? 'yes' : 'no'}${mark(e)}  host: ${hostOf(e.httpsUrl)}`))
    out(`re-run with --yes to send ${p.pending.length} one-click requests`)
    return 0
  }
  const release = await (deps.acquire ?? acquireLock)()
  if (release === null) {
    out('already running')
    return 0
  }
  try {
    const p = await plan()
    if (p === null) {
      return 1
    }
    let failed = 0
    const unknown: string[] = p.entries.filter((e) => e.oneClick && p.outcomes.get(e.sender) === 'unknown' && !p.pending.includes(e)).map((e) => e.sender)
    for (const e of p.pending) {
      const host = hostOf(e.httpsUrl)
      const log = (r: object): Promise<void> => appendDurable(resultsFile, { sender: e.sender, host, ...r, at: now().toISOString() })
      let result: { status: number } | { error: string, sent: boolean }
      const u = staticGuard(e.httpsUrl!)
      if (u === null) {
        result = { error: 'blocked host', sent: false }
      } else {
        await log({ phase: 'attempt' })
        try {
          result = { status: await post(u, { request, lookup, timeoutMs: deps.timeoutMs ?? TIMEOUT_MS }) }
        } catch (err) {
          result = err instanceof PostError ? { error: errCode(err.cause), sent: err.sent } : { error: errCode(err), sent: true }
        }
      }
      await log({ phase: 'result', ...result })
      // a blocked host is skipped on purpose, so only sent-and-failed or errored requests fail the run
      if ('error' in result ? result.error !== 'blocked host' : result.status >= 400 || result.status < 200) {
        failed++
      }
      if ('error' in result && isUnknownError(result)) {
        unknown.push(e.sender)
      }
      out(`${stripControl(e.sender)}  ${host}  ${'error' in result ? result.error : `${result.status}${result.status >= 300 && result.status < 400 ? ' (redirect not followed)' : ''}`}`)
    }
    if (unknown.length > 0) {
      out('unknown outcome (not retried; --retry-unknown with --yes sends again):')
      unknown.forEach((s) => out(`- ${stripControl(s)}`))
    }
    const manual = p.entries.filter((e) => !e.oneClick)
    if (manual.length > 0) {
      out('manual: open from the report')
      manual.forEach((e) => out(`- ${stripControl(e.sender)}`))
    }
    return failed > 0 ? 1 : 0
  } finally {
    await release()
  }
}
