import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isBlockedAddress, runUnsubscribe } from '../src/unsubscribe.ts'
import type { RequestFn, UnsubDeps, UnsubEntry } from '../src/unsubscribe.ts'
import { acquireLock } from '../src/state.ts'

const DATE = '2026-11-15'
const BODY = 'List-Unsubscribe=One-Click'

beforeEach(() => {
  process.env.GMAIL_TRIAGE_HOME = mkdtempSync(join(tmpdir(), 'gt-unsub-'))
})

const entry = (sender: string, httpsUrl: string | null, over: Partial<UnsubEntry> = {}): UnsubEntry =>
  ({ sender, httpsUrl, mailto: null, oneClick: httpsUrl !== null, threadId: `t-${sender}`, ...over })

const seed = (entries: UnsubEntry[]): void => {
  const dir = join(process.env.GMAIL_TRIAGE_HOME!, 'unsub')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${DATE}.json`), JSON.stringify(entries))
}

const resultsFile = (): string => join(process.env.GMAIL_TRIAGE_HOME!, 'unsub', `${DATE}.results.jsonl`)
const lines = (): Record<string, unknown>[] => readFileSync(resultsFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const results = (): Record<string, unknown>[] => lines().filter((r) => r.phase === 'result')

type Sent = { host: string, path: string, body: string, addrs: unknown, options: Record<string, any> }
type Over = {
  status?: number, statusFor?: (host: string) => number, addrs?: Record<string, string[]>, hang?: string[], failWith?: (host: string) => Error | null, failBeforeSend?: (host: string) => Error | null,
  cleanupError?: boolean, timeoutMs?: number, nowThrowsOn?: number,
}
// A fake https.request: the socket write happens only after the connection lookup succeeds, as in node.
const harness = (over: Over = {}) => {
  const sent: Sent[] = []
  const built: Record<string, any>[] = []
  const lookups: string[] = []
  const out: string[] = []
  let nowCalls = 0
  const request = ((options: Record<string, any>, cb: (res: unknown) => void) => {
    built.push(options)
    const req = new EventEmitter() as EventEmitter & Record<string, unknown>
    req.setTimeout = () => req
    req.destroy = (err?: Error) => {
      if (err) {
        queueMicrotask(() => req.emit('error', err))
      }
      return req
    }
    req.end = (body: string) => {
      options.lookup(options.hostname, { all: true }, (err: Error | null, addrs: unknown) => {
        if (err) {
          req.emit('error', err)
          return
        }
        const early = over.failBeforeSend?.(options.hostname)
        if (early) {
          req.emit('error', early)
          return
        }
        sent.push({ host: options.hostname, path: options.path, body, addrs, options })
        req.emit('finish')
        const fail = over.failWith?.(options.hostname)
        if (fail) {
          req.emit('error', fail)
          return
        }
        if (over.hang?.includes(options.hostname)) {
          return
        }
        const res = new EventEmitter() as EventEmitter & Record<string, unknown>
        res.statusCode = over.statusFor?.(options.hostname) ?? over.status ?? 200
        res.destroy = () => {
          if (over.cleanupError) {
            queueMicrotask(() => res.emit('error', new Error('cleanup')))
            throw new Error('cleanup')
          }
        }
        cb(res)
      })
    }
    return req
  }) as unknown as RequestFn
  const deps: UnsubDeps = {
    request,
    lookup: async (host: string) => {
      lookups.push(host)
      return (over.addrs?.[host] ?? ['93.184.216.34']).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
    },
    now: () => {
      if (over.nowThrowsOn !== undefined && ++nowCalls === over.nowThrowsOn) {
        throw new Error('crash')
      }
      return new Date('2026-11-16T08:00:00Z')
    },
    out: (s: string) => out.push(s),
    timeoutMs: over.timeoutMs,
  }
  return { deps, sent, built, lookups, out }
}

test('without --yes: lists hosts and one-click flags, never a URL path or query, and sends nothing', async () => {
  seed([entry('a@one.com', 'https://one.com/unsub/path?token=SECRET123'), entry('b@two.com', null, { mailto: 'https://mail.google.com/mail/?view=cm&to=u%40two.com' })])
  const h = harness()
  const code = await runUnsubscribe(DATE, { yes: false }, h.deps)
  assert.equal(code, 0)
  assert.equal(h.built.length, 0)
  const text = h.out.join('\n')
  assert.match(text, /1\. a@one\.com .*yes.* one\.com/)
  assert.match(text, /2\. b@two\.com .*no/)
  assert.doesNotMatch(text, /unsub\/path|SECRET123|token=|https:\/\//)
  assert.match(text, /re-run with --yes to send 1 one-click requests?/)
})

test('--yes sends one pinned POST per one-click entry with the exact body, headers and no agent reuse', async () => {
  seed([entry('a@one.com', 'https://one.com/u?t=1'), entry('b@two.com', null)])
  const h = harness()
  const code = await runUnsubscribe(DATE, { yes: true }, h.deps)
  assert.equal(code, 0)
  assert.equal(h.sent.length, 1)
  const { host, path, body, options } = h.sent[0]
  assert.deepEqual([host, path, body], ['one.com', '/u?t=1', 'List-Unsubscribe=One-Click'])
  assert.equal(options.method, 'POST')
  assert.equal(options.agent, false)
  assert.equal(options.hostname, 'one.com')
  assert.equal(options.servername, undefined)
  assert.equal(options.host, undefined)
  assert.equal(options.protocol, 'https:')
  assert.equal(options.port, 443)
  assert.deepEqual(options.headers, { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'gmail-triage/1' })
  assert.match(h.out.join('\n'), /manual: open from the report/)
  assert.match(h.out.join('\n'), /b@two\.com/)
  assert.deepEqual(lines().map((r) => r.phase), ['attempt', 'result'])
  const r = results()[0]
  assert.deepEqual(Object.keys(r).sort(), ['at', 'host', 'phase', 'sender', 'status'])
  assert.deepEqual([r.sender, r.host, r.status, r.at], ['a@one.com', 'one.com', 200, '2026-11-16T08:00:00.000Z'])
  assert.equal(statSync(resultsFile()).mode & 0o777, 0o600)
})

test('the connection lookup is the validating one: a public answer connects, a private answer fails before any write', async () => {
  seed([entry('a@one.com', 'https://one.com/u')])
  const ok = harness({ addrs: { 'one.com': ['93.184.216.34'] } })
  await runUnsubscribe(DATE, { yes: true }, ok.deps)
  assert.equal(typeof ok.built[0].lookup, 'function')
  assert.deepEqual(ok.sent[0].addrs, [{ address: '93.184.216.34', family: 4 }])
  const single = await new Promise<unknown[]>((res) => ok.built[0].lookup('one.com', {}, (...a: unknown[]) => res(a)))
  assert.deepEqual(single, [null, '93.184.216.34', 4])
  process.env.GMAIL_TRIAGE_HOME = mkdtempSync(join(tmpdir(), 'gt-unsub-'))
  seed([entry('a@one.com', 'https://one.com/u')])
  const bad = harness({ addrs: { 'one.com': ['10.0.0.1'] } })
  await runUnsubscribe(DATE, { yes: true }, bad.deps)
  assert.equal(bad.built.length, 1)
  assert.equal(bad.sent.length, 0)
  assert.equal(results().at(-1)?.error, 'blocked host')
})

test('a 302 is logged as done and the Location is not followed', async () => {
  seed([entry('a@one.com', 'https://one.com/u')])
  const h = harness({ status: 302 })
  assert.equal(await runUnsubscribe(DATE, { yes: true }, h.deps), 0)
  assert.equal(h.sent.length, 1)
  assert.equal(results()[0].status, 302)
})

test('a timeout is a failure and an unknown outcome: exit 1, other entries still sent, never auto-retried', async () => {
  seed([entry('a@one.com', 'https://one.com/u'), entry('b@two.com', 'https://two.com/u')])
  const h = harness({ hang: ['one.com'], timeoutMs: 20 })
  assert.equal(await runUnsubscribe(DATE, { yes: true }, h.deps), 1)
  assert.equal(h.sent.length, 2)
  assert.deepEqual(results().map((r) => [r.sender, r.status ?? r.error]), [['a@one.com', 'timeout'], ['b@two.com', 200]])
  assert.match(h.out.join('\n'), /unknown outcome[^\n]*\n- a@one\.com/)
  const again = harness()
  assert.equal(await runUnsubscribe(DATE, { yes: true }, again.deps), 0)
  assert.equal(again.sent.length, 0)
  assert.match(again.out.join('\n'), /unknown outcome[^\n]*\n- a@one\.com/)
  const retry = harness()
  assert.equal(await runUnsubscribe(DATE, { yes: true, retryUnknown: true }, retry.deps), 0)
  assert.deepEqual(retry.sent.map((x) => x.host), ['one.com'])
})

test('a crash after the attempt line (before the result write): re-run sends 0 and lists unknown; --retry-unknown sends it', async () => {
  seed([entry('a@one.com', 'https://one.com/u')])
  const crash = harness({ nowThrowsOn: 2 })
  await assert.rejects(runUnsubscribe(DATE, { yes: true }, crash.deps), /crash/)
  assert.equal(crash.sent.length, 1)
  assert.deepEqual(lines().map((r) => r.phase), ['attempt'])
  const free = await acquireLock()
  assert.ok(free, 'lock released after the crash')
  await free()
  const again = harness()
  assert.equal(await runUnsubscribe(DATE, { yes: true }, again.deps), 0)
  assert.equal(again.sent.length, 0)
  assert.match(again.out.join('\n'), /unknown outcome[^\n]*\n- a@one\.com/)
  const preview = harness()
  await runUnsubscribe(DATE, { yes: false }, preview.deps)
  assert.match(preview.out.join('\n'), /\(unknown outcome\)/)
  assert.match(preview.out.join('\n'), /send 0 one-click/)
  const retry = harness()
  assert.equal(await runUnsubscribe(DATE, { yes: true, retryUnknown: true }, retry.deps), 0)
  assert.equal(retry.sent.length, 1)
})

test('a body cleanup error after the headers does not change the recorded 200', async () => {
  seed([entry('a@one.com', 'https://one.com/u')])
  const h = harness({ cleanupError: true })
  assert.equal(await runUnsubscribe(DATE, { yes: true }, h.deps), 0)
  assert.equal(results()[0].status, 200)
})

test('definite failures retry on a normal re-run; a 500 and a refused connection are definite, a reset is unknown', async () => {
  seed([entry('a@one.com', 'https://one.com/u'), entry('b@two.com', 'https://two.com/u'), entry('c@three.com', 'https://three.com/u'), entry('d@four.com', 'https://four.com/u')])
  const refused = Object.assign(new Error('x'), { code: 'ECONNREFUSED' })
  const reset = Object.assign(new Error('x'), { code: 'ECONNRESET' })
  const first = harness({ statusFor: (h) => (h === 'one.com' ? 500 : h === 'two.com' ? 302 : 200), failBeforeSend: (h) => (h === 'three.com' ? refused : null), failWith: (h) => (h === 'four.com' ? reset : null) })
  assert.equal(await runUnsubscribe(DATE, { yes: true }, first.deps), 1)
  const second = harness()
  assert.equal(await runUnsubscribe(DATE, { yes: true }, second.deps), 0)
  assert.deepEqual(second.sent.map((x) => x.host), ['one.com', 'three.com'])
})

test('a TLS error after the request was sent is unknown: a normal --yes sends 0, --retry-unknown sends again', async () => {
  seed([entry('a@one.com', 'https://one.com/u')])
  const tls = Object.assign(new Error('x'), { code: 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR' })
  const first = harness({ failWith: () => tls })
  assert.equal(await runUnsubscribe(DATE, { yes: true }, first.deps), 1)
  assert.equal(results()[0].sent, true)
  const again = harness()
  assert.equal(await runUnsubscribe(DATE, { yes: true }, again.deps), 0)
  assert.equal(again.sent.length, 0)
  assert.match(again.out.join('\n'), /unknown outcome[^\n]*\n- a@one\.com/)
  const retry = harness()
  await runUnsubscribe(DATE, { yes: true, retryUnknown: true }, retry.deps)
  assert.equal(retry.sent.length, 1)
})

test('a connection reset after the request was sent is unknown', async () => {
  seed([entry('a@one.com', 'https://one.com/u')])
  const first = harness({ failWith: () => Object.assign(new Error('x'), { code: 'ECONNRESET' }) })
  assert.equal(await runUnsubscribe(DATE, { yes: true }, first.deps), 1)
  const again = harness()
  await runUnsubscribe(DATE, { yes: true }, again.deps)
  assert.equal(again.sent.length, 0)
})

test('a cert-verification error before anything was sent is definite: a normal --yes retries it', async () => {
  seed([entry('a@one.com', 'https://one.com/u')])
  const cert = Object.assign(new Error('x'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })
  const first = harness({ failBeforeSend: () => cert })
  assert.equal(await runUnsubscribe(DATE, { yes: true }, first.deps), 1)
  assert.deepEqual([results()[0].error, results()[0].sent], ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', false])
  const again = harness()
  assert.equal(await runUnsubscribe(DATE, { yes: true }, again.deps), 0)
  assert.equal(again.sent.length, 1)
})

test('legacy result lines without a sent flag: TLS codes are unknown, a refused connection is definite', async () => {
  seed([entry('a@one.com', 'https://one.com/u'), entry('b@two.com', 'https://two.com/u')])
  const line = (sender: string, error: string): string => `${JSON.stringify({ sender, host: 'h', phase: 'result', error, at: 'x' })}\n`
  writeFileSync(resultsFile(), line('a@one.com', 'ERR_TLS_CERT_ALTNAME_INVALID') + line('b@two.com', 'ECONNREFUSED'))
  const h = harness()
  assert.equal(await runUnsubscribe(DATE, { yes: true }, h.deps), 0)
  assert.deepEqual(h.sent.map((x) => x.host), ['two.com'])
})

test('--yes takes the run lock first: with the lock held nothing is read or sent', async () => {
  const release = await acquireLock()
  assert.ok(release)
  const h = harness()
  assert.equal(await runUnsubscribe(DATE, { yes: true }, h.deps), 0, 'exits 0 even though no capture file exists')
  assert.match(h.out.join('\n'), /already running/)
  assert.equal(h.built.length, 0)
  await release()
})

test('another invocation finishing between a would-be early read and the lock leaves nothing to send', async () => {
  seed([entry('a@one.com', 'https://one.com/u')])
  const h = harness()
  h.deps.acquire = async () => {
    // the competing run completes here, after any early read would have happened
    writeFileSync(resultsFile(), `${JSON.stringify({ sender: 'a@one.com', host: 'one.com', phase: 'result', status: 200, at: 'x' })}\n`)
    return await acquireLock()
  }
  assert.equal(await runUnsubscribe(DATE, { yes: true }, h.deps), 0)
  assert.equal(h.built.length, 0)
})

test('a run that finishes before the next takes the lock leaves the next with nothing to send', async () => {
  seed([entry('a@one.com', 'https://one.com/u')])
  const h = harness()
  const [a, b] = await Promise.all([runUnsubscribe(DATE, { yes: true }, h.deps), runUnsubscribe(DATE, { yes: true }, h.deps)])
  assert.deepEqual([a, b], [0, 0])
  assert.equal(h.sent.length, 1)
  assert.equal(await runUnsubscribe(DATE, { yes: true }, h.deps), 0)
  assert.equal(h.sent.length, 1)
  assert.ok(await acquireLock(), 'lock released after the run')
})

test('a missing capture file or a bad date fails without sending', async () => {
  const h = harness()
  assert.equal(await runUnsubscribe(DATE, { yes: true }, h.deps), 1)
  assert.equal(await runUnsubscribe('../x', { yes: true }, h.deps), 2)
  assert.equal(h.built.length, 0)
})

const BLOCKED_URLS = [
  'http://one.com/u', 'https://user:pw@one.com/u', 'https://user@one.com/u', 'https://one.com:8443/u',
  'https://93.184.216.34/u', 'https://[::1]/u', 'https://127.1/u', 'https://2130706433/u', 'not a url',
]
for (const url of BLOCKED_URLS) {
  test(`ssrf: ${url} is blocked with 0 requests`, async () => {
    seed([entry('a@one.com', url)])
    const h = harness()
    assert.equal(await runUnsubscribe(DATE, { yes: true }, h.deps), 0)
    assert.equal(h.built.length, 0)
    assert.equal(results()[0].error, 'blocked host')
    assert.equal(h.lookups.length, 0)
  })
}

const BAD_ADDRS = ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1', '::ffff:127.0.0.1', '100.64.0.1', '172.16.5.5', '192.168.1.1', '0.0.0.0', 'fe80::1', 'fd00::1', '224.0.0.1', '::ffff:7f00:1', '::', '::ffff:10.0.0.1']
for (const addr of BAD_ADDRS) {
  test(`ssrf: a host resolving to ${addr} is blocked with 0 socket writes`, async () => {
    seed([entry('a@one.com', 'https://one.com/u')])
    const h = harness({ addrs: { 'one.com': [addr] } })
    assert.equal(await runUnsubscribe(DATE, { yes: true }, h.deps), 0)
    assert.equal(h.sent.length, 0)
    assert.equal(results()[0].error, 'blocked host')
  })
}

test('ssrf: one public and one private A record blocks the host', async () => {
  seed([entry('a@one.com', 'https://one.com/u')])
  const h = harness({ addrs: { 'one.com': ['93.184.216.34', '10.0.0.5'] } })
  assert.equal(await runUnsubscribe(DATE, { yes: true }, h.deps), 0)
  assert.equal(h.sent.length, 0)
  assert.equal(results()[0].error, 'blocked host')
})

test('ssrf: an empty resolution and a lookup failure never write to a socket', async () => {
  seed([entry('a@one.com', 'https://one.com/u'), entry('b@two.com', 'https://two.com/u')])
  const h = harness()
  h.deps.lookup = async (host: string) => {
    if (host === 'one.com') {
      return []
    }
    throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' })
  }
  assert.equal(await runUnsubscribe(DATE, { yes: true }, h.deps), 1)
  assert.equal(h.sent.length, 0)
  assert.deepEqual(results().map((r) => r.error), ['blocked host', 'ENOTFOUND'])
})

test('public addresses pass the guard (positive control)', () => {
  for (const a of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isBlockedAddress(a), false, a)
  }
  for (const a of ['100.127.255.255', '172.31.255.255', '255.255.255.255', 'garbage', '0.1.2.3']) {
    assert.equal(isBlockedAddress(a), true, a)
  }
})
