import type { Bucket } from './types.ts'
import { BUCKETS, DUPLICATE_LABEL, LABEL_NAME, RESOLVED_LABEL, STALE_LABEL } from './buckets.ts'
import type { SweepPlan, SweepRow } from './sweep.ts'

export type ReportRow = { threadId: string, from: string, subject: string, reason: string, bucket: Bucket }
// A thread left in the inbox; duplicate copies never get a bucket.
export type FailedRow = Omit<ReportRow, 'bucket'> & { bucket?: Bucket }
export type DupeRow = { threadId: string, from: string, subject: string, older: number }
export type UnsubRow = { sender: string, count30d: number | null, link: { kind: 'https' | 'mailto', href: string } }
// Every unread inbox thread after the run, in exactly one bucket (a dry run counts the real inbox); counts are floors when capped, null inbox means unavailable.
export type InboxSplit = { total: number, keptToday: number, keptEarlier: number, toTriage: number, capped: boolean }
// Inbox threads labeled urgent/attention by any run; rows hold the newest few hundred, rest the unfetched ids. null means unavailable.
export type OpenRow = { threadId: string, from: string, subject: string, ageDays: number }
export type OpenInbox = { urgent: { rows: OpenRow[], rest: string[] }, attention: { rows: OpenRow[], rest: string[] } }
export type ReportInput = {
  date: string, mode: 'dry' | 'live', keptByFloor: number,
  inbox: InboxSplit | null, open: OpenInbox | null, swept: SweepPlan | null, ifLive: { archive: number, duplicates: number, keep: number } | null, repo: string, home: string | null, rows: ReportRow[], failed: FailedRow[], dupes: DupeRow[], dupArchived: number, dupProtected: number, unsub: UnsubRow[], error: string | null,
}

const MAIL = 'https://mail.google.com/mail'

const ENT: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const shq = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ENT[c])

export type UnsubLinks = { https: string | null, mailto: string | null }

// Both targets of a List-Unsubscribe header: the first https URL and the first valid mailto as a Gmail compose link.
export const unsubLinks = (header: string): UnsubLinks => {
  const entries = [...header.matchAll(/<([^>]*)>/g)].map((m) => m[1].trim())
  let https: string | null = null
  for (const e of entries) {
    try {
      const u = new URL(e)
      if (u.protocol === 'https:') {
        https = u.href
        break
      }
    } catch {
      // not a URL, try the next entry
    }
  }
  let mailto: string | null = null
  for (const e of entries) {
    if (!/^mailto:/i.test(e)) {
      continue
    }
    try {
      const u = new URL(e)
      const to = decodeURIComponent(u.pathname)
      if (!to.includes('@') || /\s/.test(to)) {
        continue
      }
      const q = new URLSearchParams({ view: 'cm', to, su: u.searchParams.get('subject') || 'unsubscribe' })
      mailto = `${MAIL}/?${q.toString()}`
      break
    } catch {
      // malformed mailto, try the next entry
    }
  }
  return { https, mailto }
}

export const parseListUnsubscribe = (header: string): UnsubRow['link'] | null => {
  const l = unsubLinks(header)
  return l.https !== null ? { kind: 'https', href: l.https } : l.mailto !== null ? { kind: 'mailto', href: l.mailto } : null
}

const threadHref = (id: string): string => `${MAIL}/u/0/#all/${encodeURIComponent(id)}`
const labelHref = (name: string): string => `${MAIL}/u/0/#label/${encodeURIComponent(name)}`

const NAME = (b: Bucket): string => b.charAt(0).toUpperCase() + b.slice(1)

const CSS = `
:root{--surface-void:#0F0F14;--surface-base:#121217;--surface-raised:#16161D;--surface-panel:#1C1D26;--surface-line:#363745;--ink-muted:#8A909A;--ink-soft:#B3B3BD;--ink:#DEDEDE;--ink-bright:#FFFFFF;--indigo:#3a35fb;--indigo-hover:#2e2ac9;--indigo-text:#8986fd;--success:#02b059;--warning:#eb5d05;--error-text:#f25f7a}
*{box-sizing:border-box}
body{margin:0;background:var(--surface-void);color:var(--ink);font:15px/1.5 "Sofia Sans",system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 48px}
a{color:var(--indigo-text)}a:hover{color:var(--ink-bright)}
h1{font-size:22px;color:var(--ink-bright);margin:0 0 4px}
h3{font-size:14px;color:var(--ink-soft);margin:16px 0 8px}
h2{font-size:16px;color:var(--ink-bright);margin:28px 0 8px;border-bottom:1px solid var(--surface-line);padding-bottom:6px}
.sub{color:var(--ink-muted);margin:0 0 16px;overflow-wrap:anywhere}
.dry{display:inline-block;background:var(--warning);color:var(--ink-bright);padding:1px 8px;border-radius:4px;font-weight:700;margin-right:8px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}
.tile{background:var(--surface-raised);border:1px solid var(--surface-line);border-radius:4px;padding:12px}
.tile-l{color:var(--ink-muted);font-size:13px}.tile-n{color:var(--ink-bright);font-size:28px;font-weight:700}
ul{list-style:none;margin:0;padding:0}
li{background:var(--surface-base);border:1px solid var(--surface-line);border-radius:4px;padding:8px 12px;margin-bottom:6px;overflow-wrap:anywhere}
li .from{color:var(--ink-soft);font-size:13px}li .why{color:var(--ink-muted);font-size:13px}
details{background:var(--surface-raised);border:1px solid var(--surface-line);border-radius:4px;padding:8px 12px;margin-bottom:6px}
summary{cursor:pointer;color:var(--ink-bright)}details ul{margin-top:8px}
.err{background:var(--surface-panel);border:1px solid var(--error-text);border-radius:4px;color:var(--error-text);padding:12px;overflow-wrap:anywhere}
.undo{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
code{background:var(--surface-panel);border:1px solid var(--surface-line);border-radius:4px;padding:6px 10px;color:var(--ink-bright);overflow-wrap:anywhere}
button{background:var(--indigo);color:var(--ink-bright);border:0;border-radius:4px;padding:7px 14px;font:inherit;cursor:pointer}button:hover{background:var(--indigo-hover)}
.empty{color:var(--ink-muted)}
`

// Clipboard can be denied on a sandboxed page, so fall back to selecting the text.
const SCRIPT = `
document.getElementById('copy').addEventListener('click',function(){
var el=document.getElementById('undo-cmd');
var sel=function(){var r=document.createRange();r.selectNodeContents(el);var s=getSelection();s.removeAllRanges();s.addRange(r)};
try{navigator.clipboard.writeText(el.textContent).then(function(){this.textContent='Copied'}.bind(this),sel)}catch(e){sel()}
});
`

// Mail-derived text is capped so a hostile sender gets little room to write instructions into the report.
const clip = (s: string): string => s.length > 120 ? `${s.slice(0, 120)}…` : s

const item = (r: FailedRow): string =>
  `<li><a href="${esc(threadHref(r.threadId))}">${esc(clip(r.subject))}</a><div class="from">${esc(clip(r.from))}</div><div class="why">${esc(r.reason)}</div></li>`

const list = (rows: FailedRow[]): string => rows.length === 0 ? '<p class="empty">None</p>' : `<ul>${rows.map(item).join('')}</ul>`

const sweptItem = (s: SweepRow): string =>
  `<li><a href="${esc(threadHref(s.threadId))}">${esc(clip(s.subject))}</a><div class="from">${esc(clip(s.from))}</div><div class="why">${esc(s.why)}</div></li>`

// Live: what the sweep archived; dry: what it would. Omitted when there is nothing.
const sweptSection = (r: ReportInput): string => {
  const s = r.swept
  if (s === null || s.resolved.length + s.stale.length === 0) {
    return ''
  }
  const group = (title: string, label: string, rows: SweepRow[]): string => rows.length === 0 ? '' : `<details><summary>${title} (${rows.length})</summary><p><a href="${esc(labelHref(label))}">Open label in Gmail</a></p><ul>${rows.map(sweptItem).join('')}</ul></details>`
  return `<h2>${r.mode === 'dry' ? 'Would auto-archive' : 'Auto-archived'}</h2>${group('Resolved alerts', RESOLVED_LABEL, s.resolved)}${group('Stale attention', STALE_LABEL, s.stale)}`
}

const age = (d: number): string => d === 0 ? 'today' : `${d}d ago`

const openItem = (o: OpenRow): string =>
  `<li><a href="${esc(threadHref(o.threadId))}">${esc(clip(o.subject))}</a><div class="from">${esc(clip(o.from))}</div><div class="why">last mail ${age(o.ageDays)}</div></li>`

// Today's verdicts first, then every earlier thread still in the inbox under that label (cross-label dedupe happens at fetch). Dry verdicts are hypothetical, so they never hide a real label.
const openSections = (r: ReportInput): Record<'urgent' | 'attention', { html: string, count: number }> => {
  const today = (b: Bucket): ReportRow[] => r.rows.filter((x) => x.bucket === b)
  const shown = new Set(r.mode === 'dry' ? [] : r.rows.filter((x) => x.bucket === 'urgent' || x.bucket === 'attention').map((x) => x.threadId))
  const section = (b: 'urgent' | 'attention'): { html: string, count: number } => {
    const o = r.open?.[b] ?? null
    const earlier = (o?.rows ?? []).filter((x) => !shown.has(x.threadId))
    const more = (o?.rest ?? []).filter((id) => !shown.has(id)).length
    const tail = o === null
      ? '<p class="why">Earlier threads still in inbox: unavailable this run</p>'
      : earlier.length === 0 && more === 0 ? '' : `<h3>Earlier, still in inbox (${earlier.length + more})</h3>${earlier.length === 0 ? '' : `<ul>${earlier.map(openItem).join('')}</ul>`}${more === 0 ? '' : `<p><a href="${esc(labelHref(LABEL_NAME[b]))}">${more} more in Gmail</a></p>`}`
    const head = today(b).length === 0 && tail !== '' ? '<p class="empty">None new today</p>' : list(today(b))
    return { html: `<h2>${NAME(b)}</h2>${head}${tail}`, count: today(b).length + earlier.length + more }
  }
  const urgent = section('urgent')
  return { urgent, attention: section('attention') }
}

// Renderer-side check so a bad UnsubRow can never reach an href.
const safeUnsubHref = (l: UnsubRow['link']): string | null => {
  try {
    const u = new URL(l.href)
    if (u.protocol !== 'https:') {
      return null
    }
    if (l.kind === 'mailto' && (u.host !== 'mail.google.com' || u.pathname !== '/mail/' || u.searchParams.get('view') !== 'cm')) {
      return null
    }
    return u.href
  } catch {
    return null
  }
}

const dupeItem = (d: DupeRow): string =>
  `<li><a href="${esc(threadHref(d.threadId))}">${esc(clip(d.subject))}</a> <span class="why">${d.older} older ${d.older === 1 ? 'copy' : 'copies'}</span><div class="from">${esc(clip(d.from))}</div></li>`

const unsubItem = (u: UnsubRow): string => {
  const href = safeUnsubHref(u.link)
  const action = href === null
    ? 'no safe unsubscribe link'
    : `<a href="${esc(href)}">${u.link.kind === 'https' ? 'unsubscribe page' : 'compose email'}</a>`
  return `<li>${esc(clip(u.sender))} <span class="why">${u.count30d ?? 'n/a'} in 30d</span><div class="why">${action}</div></li>`
}

// The repo and home override arrive in the input so rendering stays pure.
const undoCommand = (r: ReportInput): string =>
  `${r.home === null ? '' : `GMAIL_TRIAGE_HOME=${shq(r.home)} `}node ${shq(`${r.repo}/src/main.ts`)} undo ${r.date}`

const KIND_RE = /<meta name="gmail-triage-kind" content="(live|dry|error)">/

// Reads only the first marker inside <head>, which is written before any mail content; anything else is unknown.
export const reportKind = (html: string): 'live' | 'dry' | 'error' | null => {
  const end = html.indexOf('</head>')
  return end === -1 ? null : (html.slice(0, end).match(KIND_RE)?.[1] as 'live' | 'dry' | 'error' | undefined) ?? null
}

const inboxText = (r: ReportInput): string => {
  const x = r.inbox
  if (x === null) {
    return 'unknown unread in inbox now — counts unavailable; run again to finish'
  }
  const n = (v: number): string => `${v}${x.capped ? '+' : ''}`
  const hint = x.toTriage > 0 ? ' — run again or wait for tomorrow\'s run' : ''
  return `${n(x.total)} unread in inbox now: ${n(x.keptToday)} kept today · ${n(x.keptEarlier)} kept earlier · ${n(x.toTriage)} still to triage${r.mode === 'dry' ? ' (dry run: nothing changed)' : ''}${hint}`
}

export const renderReport = (r: ReportInput): string => {
  const rows = (b: Bucket): ReportRow[] => r.rows.filter((x) => x.bucket === b)
  const archived = r.rows.filter((x) => x.bucket !== 'urgent' && x.bucket !== 'attention')
  const head = `<h1>${r.mode === 'dry' ? '<span class="dry">DRY RUN</span>' : ''}Inbox Triage ${esc(r.date)}</h1>`
  const undo = `<h2>Undo</h2><div class="undo"><code id="undo-cmd">${esc(undoCommand(r))}</code><button id="copy" type="button">Copy</button></div>`
  const tile = (label: string, n: number): string => `<div class="tile"><div class="tile-l">${label}</div><div class="tile-n">${n}</div></div>`

  let body: string
  if (r.error !== null) {
    // a failed classify still lists what is open; other errors have no open data and show only the error
    const open = r.open === null ? null : openSections(r)
    body = `${head}<div class="err">${esc(r.error)}</div>${open === null ? '' : `${open.urgent.html}${open.attention.html}`}${undo}`
  } else {
    const sub = `<p class="sub">${r.keptByFloor} kept in inbox by direct-mail rule, ${r.mode === 'dry' ? `would archive ${r.dupArchived} older duplicates` : `${r.dupArchived} older duplicates archived`}</p><p class="sub">${inboxText(r)}</p>${r.ifLive === null ? '' : `<p class="sub">If live: would archive ${r.ifLive.archive} (incl. ${r.ifLive.duplicates} older duplicates), keep ${r.ifLive.keep}</p>`}<p class="why">Kept earlier = kept by earlier runs (new replies there are re-checked next run).</p>`
    const open = openSections(r)
    const tiles = `<div class="tiles">${tile('Archived', archived.length)}${tile('Unsubscribe queue', r.unsub.length)}${tile('Urgent open', open.urgent.count)}${tile('Attention open', open.attention.count)}</div>`
    const failedSection = r.failed.length === 0 ? '' : `<h2>Failed — still in inbox</h2>${list(r.failed)}`
    const kept = r.dupProtected === 0 ? '' : `<p class="why">${r.dupProtected} older ${r.dupProtected === 1 ? 'copy' : 'copies'} left in inbox (direct mail)</p>`
    const dupSection = r.dupes.length === 0 && r.dupProtected === 0 ? '' : `<h2>Duplicates collapsed</h2><p><a href="${esc(labelHref(DUPLICATE_LABEL))}">Open ${esc(DUPLICATE_LABEL)} in Gmail</a></p>${r.dupes.length === 0 ? '' : `<ul>${r.dupes.map(dupeItem).join('')}</ul>`}${kept}`
    const unsub = r.unsub.length === 0 ? '<p class="empty">None</p>' : `<ul>${r.unsub.map(unsubItem).join('')}</ul>`
    const groups = BUCKETS.filter((b) => b !== 'urgent' && b !== 'attention').map((b) =>
      `<details><summary>${NAME(b)} (${rows(b).length})</summary><p><a href="${esc(labelHref(LABEL_NAME[b]))}">Open label in Gmail</a></p>${list(rows(b))}</details>`).join('')
    body = `${head}${sub}${tiles}${open.urgent.html}${open.attention.html}${sweptSection(r)}${failedSection}${dupSection}<h2>Unsubscribe queue</h2>${unsub}<h2>Archived</h2>${groups}${undo}`
  }

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="gmail-triage-kind" content="${r.error !== null ? 'error' : r.mode}"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Inbox Triage</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Sofia+Sans:wght@400;700&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body><main>${body}</main><script>${SCRIPT}</script></body></html>
`
}
