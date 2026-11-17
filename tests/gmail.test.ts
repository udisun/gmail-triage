import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { gmail_v1 } from 'googleapis'
import { addressTokens, stripControl, toThreadInput } from '../src/gmail.ts'
import { keychainRead, keychainWrite } from '../src/keychain.ts'
import { applyDirectMailFloor } from '../src/pins.ts'
import { authorize, makeCallbackHandler, parseClientJson } from '../src/auth.ts'

const msg = (id: string, internalDate: string, labelIds: string[], headers: [string, string][], snippet = 'hi'): gmail_v1.Schema$Message => ({
  id,
  internalDate,
  labelIds,
  snippet,
  payload: { headers: headers.map(([name, value]) => ({ name, value })) },
})

const base: [string, string][] = [['From', 'a@x.com'], ['To', 'Me@Example.com'], ['Subject', 's'], ['Date', 'Mon, 1 Jan 2026 00:00:00 +0000']]

test('toThreadInput picks the newest unread message', () => {
  const t: gmail_v1.Schema$Thread = {
    id: 't1',
    messages: [
      msg('old', '1000', ['UNREAD', 'INBOX'], [...base, ['Subject', 'old subject']]),
      msg('new', '3000', ['UNREAD', 'INBOX'], [['From', 'b@x.com'], ['Subject', 'new subject']]),
      msg('read', '4000', ['INBOX'], [['Subject', 'read subject']]),
    ],
  }
  const r = toThreadInput(t, 'me@example.com')
  assert.equal(r?.messageId, 'new')
  assert.equal(r?.threadId, 't1')
  assert.equal(r?.subject, 'new subject')
  assert.equal(r?.from, 'b@x.com')
  assert.equal(r?.toOrCcMe, false)
})

test('toThreadInput returns null when nothing is unread', () => {
  const t: gmail_v1.Schema$Thread = { id: 't2', messages: [msg('m', '1', ['INBOX'], base)] }
  assert.equal(toThreadInput(t, 'me@example.com'), null)
})

test('toThreadInput matches headers case-insensitively and detects me in To/Cc', () => {
  const t: gmail_v1.Schema$Thread = {
    id: 't3',
    messages: [msg('m', '1', ['UNREAD'], [['from', 'a@x.com'], ['CC', 'Me@Example.com'], ['list-unsubscribe', '<https://x/u>'], ['LIST-ID', 'news.x.com']])],
  }
  const r = toThreadInput(t, 'me@example.com')
  assert.equal(r?.listUnsubscribe, '<https://x/u>')
  assert.equal(r?.listId, 'news.x.com')
  assert.equal(r?.toOrCcMe, true)
})

test('toThreadInput captures List-Unsubscribe-Post, null when absent', () => {
  const t = (h: [string, string][]): gmail_v1.Schema$Thread => ({ id: 'tp', messages: [msg('m', '1', ['UNREAD'], [['from', 'a@x.com'], ...h])] })
  assert.equal(toThreadInput(t([['list-unsubscribe-post', 'List-Unsubscribe=One-Click']]), 'me@example.com')?.listUnsubscribePost, 'List-Unsubscribe=One-Click')
  assert.equal(toThreadInput(t([]), 'me@example.com')?.listUnsubscribePost, null)
})

test('toOrCcMe is false when the profile email is empty', () => {
  const t: gmail_v1.Schema$Thread = { id: 't5', messages: [msg('m', '1', ['UNREAD'], [['from', 'a@x.com'], ['to', 'me@example.com']])] }
  assert.equal(toThreadInput(t, '')?.toOrCcMe, false)
})

test('toThreadInput caps the snippet at 200 characters', () => {
  const t: gmail_v1.Schema$Thread = { id: 't4', messages: [msg('m', '1', ['UNREAD'], base, 'x'.repeat(500))] }
  assert.equal(toThreadInput(t, 'me@example.com')?.snippet.length, 200)
})

const fakeSecurity = (body: string): { bin: string, dir: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'gt-sec-'))
  const bin = join(dir, 'security')
  writeFileSync(bin, `#!/bin/sh\n${body}\n`)
  chmodSync(bin, 0o755)
  return { bin, dir }
}

// Fake `security`: logs argv of the -i call, stores the decoded -X hex on stdin, serves it back on find-generic-password.
const storingSecurity = (mode: 'store' | 'noop' | 'stale'): { bin: string, dir: string } => fakeSecurity(`d="$(dirname "$0")"
if [ "$1" = "-i" ]; then
  printf "%s\\n" "$@" > "$d/argv"
  line="$(cat)"
  printf "%s\\n" "$line" > "$d/stdin"
  case "${mode}" in
    store) printf "%s" "\${line##*-X }" | xxd -r -p > "$d/store" ;;
    stale) printf "old" > "$d/store" ;;
  esac
  exit 0
fi
[ -f "$d/store" ] || exit 44
cat "$d/store"`)

test('keychainWrite sends the hex secret on stdin and never in argv', async () => {
  const { bin, dir } = storingSecurity('store')
  const secret = 'sup3r-s3cret-value'
  await keychainWrite('refresh-token', secret, bin)
  const argv = readFileSync(join(dir, 'argv'), 'utf8')
  const stdin = readFileSync(join(dir, 'stdin'), 'utf8')
  assert.equal(argv, '-i\n')
  assert.equal(stdin, `add-generic-password -U -s gmail-triage -a refresh-token -X ${Buffer.from(secret).toString('hex')}\n`)
  assert.ok(!argv.includes(secret) && !stdin.includes(secret))
})

test('keychainWrite round-trips non-ASCII through the hex encoding', async () => {
  const { bin } = storingSecurity('store')
  const v = 'p\u00e4ss-\u65e5\u672c-\ud83d\udd11'
  await keychainWrite('oauth-client', v, bin)
  assert.equal(await keychainRead('oauth-client', bin), v)
})

test('keychainWrite rejects when security exits 0 but the value is missing or stale, without leaking it', async () => {
  for (const mode of ['noop', 'stale'] as const) {
    await assert.rejects(keychainWrite('refresh-token', 'topsecret', storingSecurity(mode).bin), (e: Error) => /not persisted/.test(e.message) && !e.message.includes('topsecret'))
  }
})

test('keychainWrite throws on a nonzero exit', async () => {
  const { bin } = fakeSecurity('cat >/dev/null\nexit 1')
  await assert.rejects(keychainWrite('refresh-token', 'v', bin))
})

test('keychainRead trims, maps 44 to null, and throws otherwise', async () => {
  assert.equal(await keychainRead('oauth-client', fakeSecurity('echo value').bin), 'value')
  assert.equal(await keychainRead('oauth-client', fakeSecurity('exit 44').bin), null)
  await assert.rejects(keychainRead('oauth-client', fakeSecurity('exit 1').bin))
})

test('parseClientJson accepts installed and web, rejects the rest', () => {
  const inner = { client_id: 'abcdefgh1234.apps.googleusercontent.com', client_secret: 's3' }
  assert.deepEqual(parseClientJson(JSON.stringify({ installed: inner })), { clientId: inner.client_id, clientSecret: 's3' })
  assert.deepEqual(parseClientJson(JSON.stringify({ web: inner })), { clientId: inner.client_id, clientSecret: 's3' })
  assert.throws(() => parseClientJson('not json'))
  assert.throws(() => parseClientJson('{}'))
  assert.throws(() => parseClientJson(JSON.stringify({ installed: { client_id: 'x' } })))
})

test('stripControl removes C0/C1 control characters', () => {
  assert.equal(stripControl('hi\x1b[31mred\x07\u009b\x7f!'), 'hi[31mred!')
})

const fakeRes = () => {
  const r = { status: 0, body: '', writeHead: (n: number) => { r.status = n }, end: (b?: string) => { r.body = b ?? '' } }
  return r
}

test('callback handler rejects a state mismatch without accepting the code', () => {
  let code = ''
  let err: Error | null = null
  const h = makeCallbackHandler('http://127.0.0.1:1', 'good', (c) => { code = c }, (e) => { err = e })
  const res = fakeRes()
  h({ url: '/?code=abc&state=evil' }, res)
  assert.equal(code, '')
  assert.equal((err as Error | null)?.message, 'state mismatch')
  assert.equal(res.status, 400)
  const ok = fakeRes()
  h({ url: '/?code=abc&state=good' }, ok)
  assert.equal(code, 'abc')
  assert.equal(ok.status, 200)
  const fav = fakeRes()
  h({ url: '/favicon.ico' }, fav)
  assert.equal(fav.status, 404)
})

// Fake browser: follows the auth URL's redirect_uri back to the loopback server with the right state.
const browser = (stateOverride?: string) => async (url: string): Promise<void> => {
  const u = new URL(url)
  const cb = new URL(u.searchParams.get('redirect_uri') as string)
  cb.searchParams.set('code', 'c0de')
  cb.searchParams.set('state', stateOverride ?? (u.searchParams.get('state') as string))
  void fetch(cb).then((r) => r.text()).catch(() => undefined)
}
const creds = { clientId: 'id', clientSecret: 'secret' }

test('authorize times out when the token exchange never resolves, and stores nothing', async () => {
  let stored = false
  let aborted = false
  await assert.rejects(authorize(creds, {
    open: browser(),
    exchange: (_c, _r, signal) => { signal.addEventListener('abort', () => { aborted = true }); return new Promise(() => undefined) },
    store: async () => { stored = true },
    timeoutMs: 300,
  }), /timed out/)
  assert.equal(stored, false)
  assert.equal(aborted, true)
})

test('authorize stores the refresh token on success and rejects when none is returned', async () => {
  let stored = ''
  await authorize(creds, { open: browser(), exchange: async (c) => `rt-${c}`, store: async (t) => { stored = t }, timeoutMs: 5000 })
  assert.equal(stored, 'rt-c0de')
  await assert.rejects(authorize(creds, { open: browser(), exchange: async () => undefined, store: async () => { stored = 'bad' }, timeoutMs: 5000 }), /no refresh token/)
  assert.equal(stored, 'rt-c0de')
})

test('authorize rejects a callback with the wrong state and never exchanges', async () => {
  let exchanged = false
  await assert.rejects(authorize(creds, { open: browser('evil'), exchange: async () => { exchanged = true; return 'x' }, store: async () => undefined, timeoutMs: 5000 }), /state mismatch/)
  assert.equal(exchanged, false)
})

const toMe = (header: [string, string], me = 'me@example.com', mine: string[] = []): boolean | undefined => {
  const t: gmail_v1.Schema$Thread = { id: 'tr', messages: [msg('m', '1', ['UNREAD'], [['from', 'a@x.com'], header])] }
  return toThreadInput(t, me, mine)?.toOrCcMe
}

const mkDirect = (header: [string, string], mine: string[] = []) => {
  const t: gmail_v1.Schema$Thread = { id: 'tr', messages: [msg('m', '1', ['UNREAD'], [['from', 'a@x.com'], header])] }
  return toThreadInput(t, 'me@example.com', mine)!
}

test('addressTokens extracts every address-shaped token', () => {
  assert.deepEqual(addressTokens('"Doe, Jane" <Jane@X.com>, bare@y.com (Pat <p@z.org>)'), ['Jane@X.com', 'bare@y.com', 'p@z.org'])
  assert.deepEqual(addressTokens('Team: a@x.com, me@example.com;'), ['a@x.com', 'me@example.com'])
  assert.deepEqual(addressTokens(''), [])
  assert.deepEqual(addressTokens('me@example.com. x@a@b.org me@example..com'), ['me@example.com', 'a@b.org'])
})

test('addressTokens stays linear on long hostile runs', () => {
  for (const [name, input] of [['ü', 'ü'.repeat(200_000)], ['a.', 'a.'.repeat(100_000)], ['a@', 'a@'.repeat(100_000)]]) {
    const start = performance.now()
    addressTokens(input)
    const ms = performance.now() - start
    assert.ok(ms < 2000, `addressTokens on 200,000 chars of ${name} took ${ms.toFixed(1)} ms`)
  }
})

test('toOrCcMe: plus-address, case, quoted comma name, alias from myAddresses, unrelated address', () => {
  assert.equal(toMe(['to', 'Me <me+partner@example.com>']), true)
  assert.equal(toMe(['Cc', 'ME@EXAMPLE.COM']), true)
  assert.equal(toMe(['to', '"Doe, Jane" <jane@x.com>, "Me, Myself" <me@example.com>']), true)
  assert.equal(toMe(['to', 'work@corp.com'], 'me@example.com', ['Work+Tag@Corp.com']), true)
  assert.equal(toMe(['to', 'work@corp.com']), false)
  assert.equal(toMe(['to', 'someone-me@example.com.evil.io']), false)
})

const FORMS = [
  'me@example.com (Jane Doe)', 'Team: me@example.com;', 'Team: a@x.com, me@example.com;', '"Jane, Doe" <me+tag@example.com>',
  '(comment) <ME@EXAMPLE.COM>', 'Team: Pat <a@x.com>, Me <me@example.com>; other@x.com',
]

test('commented addresses and groups in To and Cc count as direct mail and the floor keeps an archive verdict', () => {
  for (const f of FORMS) {
    for (const h of ['to', 'Cc']) {
      const ti = mkDirect([h, f])
      assert.equal(ti.toOrCcMe, true, `${h}: ${f}`)
      assert.equal(applyDirectMailFloor(ti, 'nonwork'), 'attention', `${h}: ${f}`)
    }
  }
})

test('a myAddresses alias inside a group is direct mail; a mention in a comment of another address is only over-matching, never a miss', () => {
  const ti = mkDirect(['to', 'Team: a@x.com, work@corp.com;'], ['work@corp.com'])
  assert.equal(applyDirectMailFloor(ti, 'receipts'), 'attention')
  const neg = mkDirect(['to', 'someone@else.com (me at example dot com)'])
  assert.equal(neg.toOrCcMe, false)
  assert.equal(applyDirectMailFloor(neg, 'receipts'), 'receipts')
})

test('a Unicode-domain myAddresses alias in Cc triggers the floor, composed or decomposed', () => {
  const composed = 'me@b\u00fccher.de'
  const decomposed = 'me@bu\u0308cher.de'
  for (const [header, alias] of [[`Me <${composed}>`, composed], [`Me <${decomposed}>`, composed], [`Me <${composed.toUpperCase()}>`, decomposed]]) {
    const ti = mkDirect(['Cc', header], [alias])
    assert.equal(ti.toOrCcMe, true, header)
    assert.equal(applyDirectMailFloor(ti, 'nonwork'), 'attention', header)
  }
  assert.equal(mkDirect(['Cc', `Me <other@b\u00fccher.de>`], [composed]).toOrCcMe, false)
})

const automatedOf = (headers: [string, string][]): boolean | undefined => {
  const t: gmail_v1.Schema$Thread = { id: 'tr', messages: [msg('m', '1', ['UNREAD'], headers)] }
  return toThreadInput(t, 'me@example.com')?.automated
}

test('automated: Auto-Submitted other than no, bulk-ish Precedence, role-address local parts', () => {
  const from: [string, string] = ['From', 'jane@x.com']
  assert.equal(automatedOf([from, ['Auto-Submitted', 'auto-generated']]), true)
  assert.equal(automatedOf([from, ['Auto-Submitted', 'auto-replied; foo']]), true)
  assert.equal(automatedOf([from, ['Auto-Submitted', ' No ']]), false)
  assert.equal(automatedOf([from, ['Auto-Submitted', 'no; x']]), false)
  assert.equal(automatedOf([from, ['Precedence', 'Bulk']]), true)
  assert.equal(automatedOf([from, ['Precedence', ' list ']]), true)
  assert.equal(automatedOf([from, ['Precedence', 'junk']]), true)
  assert.equal(automatedOf([from, ['Precedence', 'first-class']]), false)
  for (const f of ['No-Reply@x.com', 'noreply+abc@x.com', 'alerts@x.com', 'notifications@x.com', 'Bot <Billing@x.com>', 'noreply-github@x.com']) {
    assert.equal(automatedOf([['From', f]]), true, f)
  }
  for (const f of ['jane@x.com', 'Jane <jane+alerts@x.com>', 'x@noreply.com', 'v-smoralesnu@microsoft.com', 'mfsdepthops@microsoft.com']) {
    assert.equal(automatedOf([['From', f]]), false, f)
  }
})

test('automated: a local part containing noreply, no-reply or do(-)not(-)reply is a role address', () => {
  for (const f of ['startups-no-reply@microsoft.com', 'googledevelopers-noreply@google.com', 'googlebase-noreply@google.com', 'payments-noreply@google.com', 'cloudplatform-noreply@google.com', 'invoicing@aws.com', 'a-donotreply@x.com', 'a-do-not-reply+t@x.com', 'noreply-abc@x.com', 'jane.noreply@x.com', 'jane_no_reply@x.com']) {
    assert.equal(automatedOf([['From', f]]), true, f)
  }
  for (const f of ['noreplyjane@x.com', 'replyno@x.com', 'janenoreply@x.com', 'no.jane.reply@x.com', 'do-not-jane@x.com']) {
    assert.equal(automatedOf([['From', f]]), false, f)
  }
  // health@aws.com is no role address: only the automatedDomains pin exempts it
  assert.equal(automatedOf([['From', 'health@aws.com']]), false)
})

test('automatedDomains: exact host or full address only, no subdomains, vendor humans keep the floor', () => {
  const list = ['dtdg.co', 'status.dtdg.co', 'statuspage.io', 'updates.linear.app', 'health@aws.com']
  const direct = (from: string) => dtdg([['From', from], ['To', 'me@example.com']], list)
  for (const f of ['x@updates.linear.app', 'health@aws.com', 'Health <HEALTH@aws.com>', 'x@dtdg.co', 'x@status.dtdg.co', 'x@statuspage.io']) {
    assert.equal(direct(f).automated, true, f)
    assert.equal(direct(f).humanDirectUnread, false, f)
  }
  for (const f of ['jane@linear.app', 'jane@sub.slack.com', 'jane@aws.com', 'status@aws.com', 'x@sub.dtdg.co', 'x@eu.statuspage.io']) {
    assert.equal(direct(f).automated, false, f)
    assert.equal(direct(f).humanDirectUnread, true, f)
  }
  assert.equal(dtdg([['From', 'x@slack.com']], ['@slack.com']).automated, true)
  assert.equal(dtdg([['From', 'x@sub.slack.com']], ['slack.com']).automated, false)
})

const dtdg = (headers: [string, string][], domains: string[] = []) => {
  const t: gmail_v1.Schema$Thread = { id: 'tr', messages: [msg('m', '1', ['UNREAD'], headers)] }
  return toThreadInput(t, 'me@example.com', [], domains)!
}

test('automated: a From comment or quoted string cannot fake a role address or an automated domain', () => {
  assert.equal(dtdg([['From', 'Jane <jane@example.com> (backup <alerts@example.net>)']]).automated, false)
  assert.equal(dtdg([['From', 'Jane <jane@example.com> (see <x@slack.com>)']], ['slack.com']).automated, false)
  assert.equal(dtdg([['From', '"alerts@x.com" <jane@y.com>']]).automated, false)
  assert.equal(dtdg([['From', 'alerts@x.com, jane@y.com']]).automated, false)
  assert.equal(dtdg([['From', 'Bot <x@slack.com>']], ['slack.com']).automated, true)
  assert.equal(dtdg([['From', 'x@notslack.com']], ['slack.com']).automated, false)
})

const DIRECT: [string, string][] = [['To', 'me@example.com']]
const thread2 = (...messages: gmail_v1.Schema$Message[]) => toThreadInput({ id: 'tr', messages }, 'me@example.com', [], ['dtdg.co'])!

test('humanDirectUnread: an automated latest reply cannot hide an earlier unread human direct message', () => {
  const ti = thread2(
    msg('h', '1000', ['UNREAD'], [['From', 'Jane <jane@y.com>'], ...DIRECT]),
    msg('a', '2000', ['UNREAD'], [['From', 'jane@y.com'], ['Auto-Submitted', 'auto-generated'], ...DIRECT]),
  )
  assert.equal(ti.messageId, 'a')
  assert.equal(ti.automated, true)
  assert.equal(ti.humanDirectUnread, true)
  assert.equal(applyDirectMailFloor(ti, 'nonwork'), 'attention')
})

test('humanDirectUnread: false for automated-only, list, not-to-me, read-human and automated-domain threads', () => {
  const auto: [string, string][] = [['Auto-Submitted', 'auto-generated'], ...DIRECT]
  assert.equal(thread2(msg('a', '1', ['UNREAD'], [['From', 'jane@y.com'], ...auto])).humanDirectUnread, false)
  assert.equal(thread2(msg('a', '1', ['UNREAD'], [['From', 'noreply@y.com'], ...DIRECT])).humanDirectUnread, false)
  assert.equal(thread2(msg('a', '1', ['UNREAD'], [['From', 'x@dtdg.co'], ...DIRECT])).humanDirectUnread, false)
  assert.equal(thread2(msg('a', '1', ['UNREAD'], [['From', 'jane@y.com'], ['List-Id', '<l.y.com>'], ...DIRECT])).humanDirectUnread, false)
  assert.equal(thread2(msg('a', '1', ['UNREAD'], [['From', 'jane@y.com'], ['List-Unsubscribe', '<https://y.com/u>'], ...DIRECT])).humanDirectUnread, false)
  assert.equal(thread2(msg('a', '1', ['UNREAD'], [['From', 'jane@y.com'], ['To', 'other@y.com']])).humanDirectUnread, false)
  assert.equal(thread2(msg('h', '1', ['INBOX'], [['From', 'jane@y.com'], ...DIRECT]), msg('a', '2', ['UNREAD'], [['From', 'jane@y.com'], ...auto])).humanDirectUnread, false)
  assert.equal(thread2(msg('a', '1', ['UNREAD'], [['From', 'jane@y.com'], ...DIRECT])).humanDirectUnread, true)
})

test('an ambiguous or missing From is never automated, whatever the other headers say', () => {
  for (const from of ['jane@example.com, pat@example.net', 'not an address', '']) {
    for (const signal of [['Auto-Submitted', 'auto-generated'], ['Precedence', 'bulk']] as [string, string][]) {
      const ti = thread2(msg('m', '1', ['UNREAD'], [['From', from], signal, ...DIRECT]))
      assert.equal(ti.automated, false, `${from}: ${signal[0]}`)
      assert.equal(ti.humanDirectUnread, true, `${from}: ${signal[0]}`)
      assert.equal(applyDirectMailFloor(ti, 'nonwork'), 'attention', `${from}: ${signal[0]}`)
    }
  }
  const noFrom = thread2(msg('m', '1', ['UNREAD'], [['Precedence', 'bulk'], ...DIRECT]))
  assert.equal(noFrom.automated, false)
  assert.equal(noFrom.humanDirectUnread, true)
})

test('allUnread and messageCount describe the whole thread, not just the classified message', () => {
  const all = toThreadInput({ id: 't', messages: [msg('a', '1', ['UNREAD', 'INBOX'], base), msg('b', '2', ['UNREAD', 'INBOX'], base)] }, 'me@example.com')!
  assert.equal(all.allUnread, true)
  assert.equal(all.messageCount, 2)
  const mixed = toThreadInput({ id: 't', messages: [msg('a', '1', ['INBOX'], base), msg('b', '2', ['UNREAD', 'INBOX'], base)] }, 'me@example.com')!
  assert.equal(mixed.allUnread, false)
  assert.equal(mixed.messageCount, 2)
})
