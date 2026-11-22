import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseListUnsubscribe, renderReport } from '../src/report.ts'
import type { ReportInput } from '../src/report.ts'

const base: ReportInput = {
  date: '2026-11-15', mode: 'live', keptByFloor: 3, inbox: { total: 9, keptToday: 4, keptEarlier: 5, toTriage: 0, capped: false }, open: null, ifLive: null, repo: '/opt/gmail-triage', home: null,
  rows: [
    { threadId: 't1', from: 'Boss <boss@x.com>', subject: 'Outage now', reason: 'prod is down', bucket: 'urgent' },
    { threadId: 't2', from: 'Pat <pat@x.com>', subject: 'Contract review', reason: 'asks for sign-off', bucket: 'attention' },
    { threadId: 't3', from: 'GitHub <n@github.com>', subject: 'PR merged', reason: 'automated', bucket: 'notifications' },
    { threadId: 't4', from: 'Stripe <s@stripe.com>', subject: 'Receipt', reason: 'billing', bucket: 'receipts' },
  ],
  failed: [],
  dupes: [],
  dupArchived: 0,
  dupProtected: 0,
  unsub: [{ sender: 'News <n@news.com>', count30d: 12, link: { kind: 'https', href: 'https://news.com/u?id=1' } }],
  error: null,
}

test('escapesHostileSubject', () => {
  const html = renderReport({ ...base, rows: [{ threadId: 't9', from: '<b>x</b>', subject: '<img src=x onerror=alert(1)>', reason: 'r', bucket: 'urgent' }] })
  assert.ok(html.includes('&lt;img'))
  assert.ok(!html.includes('<img src=x'))
  assert.ok(!html.includes('<b>x</b>'))
})

test('subject, from and unsubscribe sender are cut to 120 characters plus an ellipsis before escaping', () => {
  const long = '<'.repeat(5000)
  const html = renderReport({
    ...base,
    rows: [{ threadId: 't9', from: long, subject: long, reason: 'r', bucket: 'urgent' }],
    unsub: [{ sender: long, count30d: 1, link: { kind: 'https', href: 'https://news.com/u' } }],
  })
  assert.ok(html.length < 20000)
  assert.equal(html.split('&lt;'.repeat(120) + '…').length - 1, 3)
  assert.ok(!html.includes('&lt;'.repeat(121)))
  assert.ok(renderReport({ ...base, rows: [{ ...base.rows[0], subject: 'y'.repeat(120) }] }).includes('y'.repeat(120) + '<'))
})

const undoCmd = (html: string): string =>
  /<code id="undo-cmd">(.*?)<\/code>/.exec(html)![1].replaceAll('&#39;', "'").replaceAll('&amp;', '&')

test('undo command runs the repo script with a quoted path and no home prefix when unset', () => {
  assert.equal(undoCmd(renderReport(base)), "node '/opt/gmail-triage/src/main.ts' undo 2026-11-15")
  assert.equal(undoCmd(renderReport({ ...base, repo: "/a b/it's" })), "node '/a b/it'\\''s/src/main.ts' undo 2026-11-15")
})

test('undo command carries a quoted GMAIL_TRIAGE_HOME prefix only when set', () => {
  assert.equal(undoCmd(renderReport({ ...base, home: "/h o'me" })), "GMAIL_TRIAGE_HOME='/h o'\\''me' node '/opt/gmail-triage/src/main.ts' undo 2026-11-15")
  assert.ok(!renderReport({ ...base, error: 'x' }).includes('GMAIL_TRIAGE_HOME'))
})

test('the head carries a kind marker for live, dry and error before any mail content', () => {
  const kind = (html: string) => html.match(/<meta name="gmail-triage-kind" content="([a-z]+)">/)?.[1]
  assert.equal(kind(renderReport(base)), 'live')
  assert.equal(kind(renderReport({ ...base, mode: 'dry' })), 'dry')
  assert.equal(kind(renderReport({ ...base, error: 'boom' })), 'error')
  assert.equal(kind(renderReport({ ...base, mode: 'dry', error: 'boom' })), 'error')
  const html = renderReport(base)
  assert.ok(html.indexOf('gmail-triage-kind') < html.indexOf('</head>'))
})

test('dry mode says DRY RUN, live does not', () => {
  assert.ok(renderReport({ ...base, mode: 'dry' }).includes('DRY RUN'))
  assert.ok(!renderReport(base).includes('DRY RUN'))
})

test('error report has the error and the undo, no sections or tiles', () => {
  const html = renderReport({ ...base, error: 'auth failed <run gmail-triage auth>' })
  assert.ok(html.includes('auth failed &lt;run gmail-triage auth&gt;'))
  assert.equal(undoCmd(html), "node '/opt/gmail-triage/src/main.ts' undo 2026-11-15")
  assert.ok(!html.includes('Outage now'))
  assert.ok(!html.includes('Unsubscribe queue'))
  assert.ok(!html.includes('class="tile"'))
})

test('full report has tiles, sections, links, counts', () => {
  const html = renderReport(base)
  assert.ok(html.includes('https://mail.google.com/mail/u/0/#all/t1'))
  assert.ok(html.includes('https://mail.google.com/mail/u/0/#label/Triage%2FReceipts'))
  assert.ok(html.includes('href="https://news.com/u?id=1"'))
  assert.match(html, /Archived<\/div><div class="tile-n">2</)
  assert.match(html, /Unsubscribe queue<\/div><div class="tile-n">1</)
  assert.ok(html.includes('<title>Inbox Triage</title>'))
  assert.ok(html.includes('name="viewport"'))
  assert.ok(!/<script[^>]+src=/.test(html))
})

test('no snippet text appears', () => {
  const rows = [{ ...base.rows[0], snippet: 'SECRET-SNIPPET-TEXT' }]
  assert.ok(!renderReport({ ...base, rows }).includes('SECRET-SNIPPET-TEXT'))
})

test('parseListUnsubscribe prefers https over mailto', () => {
  assert.deepEqual(parseListUnsubscribe('<mailto:a@x.com?subject=u>, <https://x.com/u?id=1>'), { kind: 'https', href: 'https://x.com/u?id=1' })
})

test('parseListUnsubscribe mailto fallback builds a compose link', () => {
  assert.deepEqual(parseListUnsubscribe('<mailto:a@x.com>'), { kind: 'mailto', href: 'https://mail.google.com/mail/?view=cm&to=a%40x.com&su=unsubscribe' })
  assert.deepEqual(parseListUnsubscribe('<mailto:a@x.com?subject=Stop me>'), { kind: 'mailto', href: 'https://mail.google.com/mail/?view=cm&to=a%40x.com&su=Stop+me' })
})

test('parseListUnsubscribe tolerates spaces and several entries', () => {
  assert.deepEqual(parseListUnsubscribe('  < mailto:a@x.com > ,  < https://x.com/u >  '), { kind: 'https', href: 'https://x.com/u' })
})

test('parseListUnsubscribe rejects everything else', () => {
  for (const h of ['garbage', '', '<javascript:alert(1)>', '<http://x.com/u>', '<data:text/html,hi>', '<https://>', '<mailto:>']) {
    assert.equal(parseListUnsubscribe(h), null, h)
  }
})

const unsubHtml = (link: { kind: 'https' | 'mailto', href: string }): string =>
  renderReport({ ...base, unsub: [{ sender: 'News <n@news.com>', count30d: 3, link }] })

test('renderer drops unsafe unsubscribe hrefs', () => {
  const bad = [
    { kind: 'https' as const, href: 'javascript:alert(document.domain)' },
    { kind: 'https' as const, href: 'data:text/html,hi' },
    { kind: 'https' as const, href: 'http://x.com/u' },
    { kind: 'https' as const, href: 'not a url' },
    { kind: 'mailto' as const, href: 'javascript:alert(1)' },
    { kind: 'mailto' as const, href: 'https://evil.example/mail/?view=cm&to=a%40x.com' },
    { kind: 'mailto' as const, href: 'https://mail.google.com.evil.example/mail/?view=cm&to=a%40x.com' },
    { kind: 'mailto' as const, href: 'https://mail.google.com@evil.example/mail/?view=cm&to=a%40x.com' },
    { kind: 'mailto' as const, href: 'https://mail.google.com/other?view=cm' },
  ]
  for (const link of bad) {
    const html = unsubHtml(link)
    assert.ok(!html.includes(`href="${link.href}"`), link.href)
    assert.ok(!/href="(javascript|data):/.test(html), link.href)
    assert.ok(html.includes('no safe unsubscribe link'), link.href)
  }
})

test('renderer keeps valid unsubscribe links', () => {
  const m = parseListUnsubscribe('<mailto:a@x.com>')!
  assert.ok(unsubHtml(m).includes(`href="${m.href}"`.replace(/&/g, '&amp;')))
  assert.ok(!unsubHtml(m).includes('no safe unsubscribe link'))
  assert.ok(unsubHtml({ kind: 'https', href: 'https://x.com/u' }).includes('href="https://x.com/u"'))
})

test('failed section renders after Attention only when non-empty, with the error class and no raw text', () => {
  assert.ok(!renderReport(base).includes('Failed'))
  const html = renderReport({ ...base, failed: [{ threadId: 't7', from: 'Al <al@x.com>', subject: 'Stuck mail', reason: 'gmail write failed', bucket: 'receipts' }] })
  assert.ok(html.includes('Failed — still in inbox'))
  assert.ok(html.includes('Stuck mail') && html.includes('gmail write failed'))
  assert.ok(html.indexOf('Contract review') < html.indexOf('Failed — still in inbox'))
  assert.ok(html.indexOf('Failed — still in inbox') < html.indexOf('Unsubscribe queue</h2>'))
})

test('the error variant ignores failed rows', () => {
  const html = renderReport({ ...base, error: 'x', failed: [{ threadId: 't7', from: 'a', subject: 'Stuck mail', reason: 'r', bucket: 'receipts' }] })
  assert.ok(!html.includes('Stuck mail'))
})

test('the header line reports how many threads the direct-mail rule kept in the inbox', () => {
  assert.match(renderReport(base), /3 kept in inbox by direct-mail rule/)
  assert.match(renderReport(base), /9 unread in inbox now: 4 kept today · 5 kept earlier · 0 still to triage/)
})

test('an unavailable sender count renders as n/a', () => {
  const html = renderReport({ ...base, unsub: [{ sender: 'News <n@news.com>', count30d: null, link: { kind: 'https', href: 'https://news.com/u' } }] })
  assert.match(html, /n\/a in 30d/)
  assert.doesNotMatch(html, /null/)
})

test('a collapsed group is listed with sender, subject, older-copy count and a link to the newest thread', () => {
  const html = renderReport({ ...base, dupArchived: 26, dupes: [{ threadId: 'tn', from: 'Datadog <digest@dtdg.co>', subject: 'Weekly digest', older: 26 }] })
  assert.ok(html.includes('<h2>Duplicates collapsed</h2>'))
  assert.ok(html.includes('href="https://mail.google.com/mail/u/0/#all/tn"'))
  assert.ok(html.includes('Weekly digest') && html.includes('Datadog &lt;digest@dtdg.co&gt;'))
  assert.match(html, /26 older/)
  assert.ok(html.includes('26 older duplicates archived'))
})

test('the duplicates section is absent when nothing collapsed, and the header still says 0', () => {
  const html = renderReport(base)
  assert.ok(!html.includes('Duplicates collapsed'))
  assert.ok(html.includes('0 older duplicates archived'))
})

test('dry mode says would archive', () => {
  const html = renderReport({ ...base, mode: 'dry', dupArchived: 3, dupes: [{ threadId: 'tn', from: 'a@x.com', subject: 's', older: 3 }] })
  assert.ok(html.includes('would archive 3 older duplicates'))
  assert.ok(!html.includes('3 older duplicates archived'))
})

test('a hostile duplicate subject and sender are escaped and cut to 120 characters', () => {
  const evil = '<img src=x onerror=alert(1)>'.repeat(20)
  const html = renderReport({ ...base, dupes: [{ threadId: 'a"><script>', from: evil, subject: evil, older: 2 }] })
  assert.ok(!html.includes('<img src=x'))
  assert.ok(!html.includes('<script>alert'))
  assert.ok(!html.includes('a"><script>'))
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
  assert.equal(html.split('…').length - 1, 2)
})

test('the duplicates section links the Triage/Duplicate label and notes protected older copies', () => {
  const html = renderReport({ ...base, dupArchived: 2, dupProtected: 3, dupes: [{ threadId: 'tn', from: 'a@x.com', subject: 's', older: 2 }] })
  assert.ok(html.includes('href="https://mail.google.com/mail/u/0/#label/Triage%2FDuplicate"'))
  assert.ok(html.includes('3 older copies left in inbox (direct mail)'))
  const only = renderReport({ ...base, dupProtected: 1 })
  assert.ok(only.includes('Duplicates collapsed') && only.includes('1 older copy left in inbox (direct mail)'))
  assert.ok(!renderReport(base).includes('left in inbox (direct mail)'))
})

test('header splits the inbox, hints a re-run only when threads still need triage, and never shows an undercount as exact', () => {
  assert.doesNotMatch(renderReport(base), /run again/)
  const inbox = (over: object) => ({ ...base, inbox: { total: 122, keptToday: 0, keptEarlier: 0, toTriage: 122, capped: false, ...over } })
  assert.match(renderReport(inbox({})), /122 unread in inbox now: 0 kept today · 0 kept earlier · 122 still to triage — run again or wait for tomorrow's run/)
  assert.match(renderReport(inbox({ total: 5000, toTriage: 4990, keptToday: 5, keptEarlier: 5, capped: true })), /5000\+ unread in inbox now: 5\+ kept today · 5\+ kept earlier · 4990\+ still to triage — run again/)
  assert.match(renderReport({ ...base, inbox: null }), /unknown unread in inbox now — counts unavailable; run again to finish/)
  assert.match(renderReport({ ...inbox({}), mode: 'dry' }), /still to triage \(dry run: nothing changed\)/)
  assert.match(renderReport({ ...base, mode: 'dry', ifLive: { archive: 300, duplicates: 4, keep: 2 } }), /If live: would archive 300 \(incl\. 4 older duplicates\), keep 2/)
  assert.doesNotMatch(renderReport(base), /If live/)
  assert.match(renderReport(base), /Kept earlier = kept by earlier runs \(new replies there are re-checked next run\)/)
})

const open = (over: Partial<NonNullable<ReportInput['open']>> = {}): ReportInput['open'] => ({
  urgent: { total: 2, rows: [{ threadId: 't1', from: 'Boss <boss@x.com>', subject: 'Outage now', ageDays: 0 }, { threadId: 'u2', from: 'Bank <b@bank.com>', subject: 'Overdue invoice', ageDays: 3 }] },
  attention: { total: 3, rows: [{ threadId: 'u2', from: 'Bank <b@bank.com>', subject: 'Overdue invoice', ageDays: 3 }, { threadId: 'a2', from: 'Rep <r@cf.com>', subject: 'Renewal terms', ageDays: 2 }] },
  ...over,
})

test('earlier open threads follow today\'s verdicts; today\'s and urgent ones are not repeated; the rest links to Gmail', () => {
  const html = renderReport({ ...base, open: open() })
  const urgent = html.slice(html.indexOf('<h2>Urgent</h2>'), html.indexOf('<h2>Attention</h2>'))
  const attention = html.slice(html.indexOf('<h2>Attention</h2>'), html.indexOf('<h2>Unsubscribe'))
  assert.equal(urgent.split('Outage now').length - 1, 1)
  assert.ok(urgent.includes('Earlier, still in inbox (1)') && urgent.includes('Overdue invoice') && urgent.includes('3d ago'))
  assert.ok(!attention.includes('Overdue invoice'))
  assert.ok(attention.includes('Contract review') && attention.includes('Renewal terms') && attention.includes('2d ago'))
  assert.ok(attention.includes('Earlier, still in inbox (2)') && attention.includes('1 more in Gmail') && attention.includes('#label/Triage%2FAttention'))
  assert.ok(html.includes('Urgent open</div><div class="tile-n">2<') && html.includes('Attention open</div><div class="tile-n">3<'))
})

test('open rows are escaped and clipped; unavailable open data says so; nothing new shows None new today', () => {
  const hostile = renderReport({ ...base, rows: [], open: open({ urgent: { total: 1, rows: [{ threadId: 'x', from: 'f', subject: '<img src=x onerror=alert(1)>', ageDays: 1 }] } }) })
  assert.ok(hostile.includes('&lt;img') && !hostile.includes('<img src=x'))
  assert.ok(hostile.includes('None new today') && hostile.includes('1d ago'))
  assert.equal(renderReport(base).split('unavailable this run').length - 1, 2)
})
