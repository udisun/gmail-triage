import { google } from 'googleapis'
import type { gmail_v1 } from 'googleapis'
import { loadClient } from './auth.ts'
import { keychainRead } from './keychain.ts'
import { addressTokens, fromMailbox } from './pins.ts'
import { createRetryBudget, withRateLimitRetry } from './retry.ts'
import type { RetryBudget } from './retry.ts'
import type { ThreadInput } from './types.ts'

// Strips C0/C1 control characters so a hostile header can't inject terminal escapes.
export const stripControl = (s: string): string => s.replace(/[\x00-\x1f\x7f-\x9f]/g, '')

export { addressTokens }

export class AuthError extends Error {}

const AUTH_HINT = 'run gmail-triage auth'
export const HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date', 'List-Id', 'List-Unsubscribe', 'List-Unsubscribe-Post', 'Auto-Submitted', 'Precedence']
const SNIPPET_MAX = 200
const GET_CHUNK = 5
const LIST_PAGE = 500
export const COUNT_CAP = 5000

export const gmailClient = async (): Promise<gmail_v1.Gmail> => {
  const client = await loadClient()
  const refresh = await keychainRead('refresh-token')
  if (!client || !refresh) {
    throw new AuthError(`no Gmail credentials stored: ${AUTH_HINT}`)
  }
  const oauth = new google.auth.OAuth2(client.clientId, client.clientSecret)
  oauth.setCredentials({ refresh_token: refresh })
  try {
    await oauth.getAccessToken()
  } catch (e) {
    const text = `${(e as { message?: string }).message ?? ''} ${JSON.stringify((e as { response?: { data?: unknown } }).response?.data ?? '')}`
    if (text.includes('invalid_grant')) {
      throw new AuthError(`Gmail refresh token is expired or revoked: ${AUTH_HINT}`)
    }
    throw e
  }
  return google.gmail({ version: 'v1', auth: oauth })
}

// A +tag is the same mailbox, so it is dropped before comparing.
const normalizeAddress = (a: string): string => a.trim().normalize('NFC').toLowerCase().replace(/\+[^@]*@/, '@')

const ROLE_LOCAL_RE = /^(no-?reply|do-?not-?reply|noreply-[a-z0-9-]+|notifications?|notify|alerts?|alerting|mailer-daemon|postmaster|bounces?|updates?|news|newsletters?|billing|invoicing|invoices?|receipts?)$/

// Token match, never substring: noreplyjane stays human, payments-noreply and jane.noreply are machines.
const noreplyTokens = (local: string): boolean => {
  const t = local.split(/[-_.]/)
  return t.some((x, i) => x === 'noreply' || x === 'donotreply' || (x === 'no' && t[i + 1] === 'reply') || (x === 'do' && t[i + 1] === 'not' && t[i + 2] === 'reply'))
}

// Own matcher, not matchesPin: `@host`/`host` is that exact host only (no subdomains), a full address is exact.
const inAutomatedList = (from: string, entries: string[]): boolean => {
  const addr = fromMailbox(from)
  return addr !== null && entries.some((raw) => {
    const e = raw.trim().toLowerCase()
    return e.lastIndexOf('@') > 0 ? addr === e : addr.slice(addr.lastIndexOf('@') + 1) === e.replace(/^@/, '')
  })
}

const headerMap = (m: gmail_v1.Schema$Message): Map<string, string> => {
  const h = new Map<string, string>()
  for (const x of m.payload?.headers ?? []) {
    if (x.name && x.value !== undefined && x.value !== null) {
      h.set(x.name.toLowerCase(), x.value)
    }
  }
  return h
}

// Machine-sent signals that a person never sets; an unparseable or multi-address From is never automated, so the floor stays on.
const isAutomated = (h: Map<string, string>, automatedDomains: string[]): boolean => {
  const from = h.get('from') ?? ''
  const addr = fromMailbox(from)
  if (addr === null) {
    return false
  }
  const auto = h.get('auto-submitted')?.split(';')[0].trim().toLowerCase()
  const precedence = h.get('precedence')?.trim().toLowerCase() ?? ''
  const local = addr.slice(0, addr.lastIndexOf('@')).replace(/\+.*$/, '')
  return (auto !== undefined && auto !== 'no') || ['bulk', 'list', 'junk'].includes(precedence)
    || ROLE_LOCAL_RE.test(local) || noreplyTokens(local) || inAutomatedList(from, automatedDomains)
}

export const toThreadInput = (t: gmail_v1.Schema$Thread, me: string, myAddresses: string[] = [], automatedDomains: string[] = []): ThreadInput | null => {
  const unread = (t.messages ?? []).filter((m) => m.labelIds?.includes('UNREAD'))
  let latest: gmail_v1.Schema$Message | null = null
  for (const m of unread) {
    if (latest === null || Number(m.internalDate ?? 0) >= Number(latest.internalDate ?? 0)) {
      latest = m
    }
  }
  if (latest === null || !t.id || !latest.id) {
    return null
  }
  const h = headerMap(latest)
  const mine = new Set([me, ...myAddresses].filter((a) => a.trim() !== '').map(normalizeAddress))
  const toMe = (x: Map<string, string>): boolean => addressTokens(`${x.get('to') ?? ''},${x.get('cc') ?? ''}`).some((a) => mine.has(normalizeAddress(a)))
  const automated = isAutomated(h, automatedDomains)
  // Archiving is thread-wide, so the floor must see every unread message, not just the classified latest.
  const humanDirectUnread = unread.some((m) => {
    const x = headerMap(m)
    return toMe(x) && !x.has('list-id') && !x.has('list-unsubscribe') && !isAutomated(x, automatedDomains)
  })
  return {
    threadId: t.id,
    messageId: latest.id,
    from: h.get('from') ?? '',
    toOrCcMe: toMe(h),
    automated,
    humanDirectUnread,
    subject: h.get('subject') ?? '',
    date: h.get('date') ?? '',
    internalDate: Number(latest.internalDate ?? 0),
    allUnread: unread.length === (t.messages ?? []).length,
    messageCount: (t.messages ?? []).length,
    labelIds: [...new Set((t.messages ?? []).flatMap((m) => m.labelIds ?? []))],
    listId: h.get('list-id') ?? null,
    listUnsubscribe: h.get('list-unsubscribe') ?? null,
    listUnsubscribePost: h.get('list-unsubscribe-post') ?? null,
    snippet: (latest.snippet ?? '').slice(0, SNIPPET_MAX),
  }
}

// Ids only (no metadata gets), so a deep backlog costs a few list calls; stops at COUNT_CAP. The signal cancels an in-flight page.
export const listUnreadIds = async (g: gmail_v1.Gmail, budget: RetryBudget, signal?: AbortSignal): Promise<{ ids: string[], capped: boolean }> => {
  const ids: string[] = []
  let pageToken: string | undefined
  do {
    const token = pageToken
    const { data } = await withRateLimitRetry(() => g.users.threads.list({ userId: 'me', q: 'is:unread in:inbox', maxResults: LIST_PAGE, pageToken: token }, { signal }), { budget })
    pageToken = data.nextPageToken ?? undefined
    ids.push(...(data.threads ?? []).map((t) => t.id).filter((id): id is string => !!id))
  } while (pageToken && ids.length < COUNT_CAP)
  return { ids: ids.slice(0, COUNT_CAP), capped: ids.length >= COUNT_CAP }
}

export const fetchUnreadThreads = async (
  g: gmail_v1.Gmail, cap: number, skip?: (threadId: string, messageId: string) => boolean, budget: RetryBudget = createRetryBudget(), myAddresses: string[] = [], automatedDomains: string[] = [],
): Promise<{ threads: ThreadInput[], skipped: number }> => {
  const me = (await withRateLimitRetry(() => g.users.getProfile({ userId: 'me' }), { budget })).data.emailAddress ?? ''
  const threads: ThreadInput[] = []
  let skipped = 0
  let pageToken: string | undefined
  // Page until `cap` non-skipped threads are held or the inbox is exhausted, so processed mail cannot starve older mail.
  do {
    const { data } = await withRateLimitRetry(() => g.users.threads.list({ userId: 'me', q: 'is:unread in:inbox', maxResults: 100, pageToken }), { budget })
    pageToken = data.nextPageToken ?? undefined
    const ids = (data.threads ?? []).map((t) => t.id).filter((id): id is string => !!id)
    for (let i = 0; i < ids.length && threads.length < cap; i += GET_CHUNK) {
      // allSettled so no sibling get outlives a failed batch
      const settled = await Promise.allSettled(ids.slice(i, i + GET_CHUNK).map((id) => withRateLimitRetry(() => g.users.threads.get({ userId: 'me', id, format: 'metadata', metadataHeaders: HEADERS }), { budget })))
      const got: { data: gmail_v1.Schema$Thread }[] = []
      for (const r of settled) {
        if (r.status === 'rejected') {
          throw r.reason
        }
        got.push(r.value)
      }
      for (const r of got) {
        const ti = toThreadInput(r.data, me, myAddresses, automatedDomains)
        if (!ti) {
          continue
        }
        if (skip?.(ti.threadId, ti.messageId)) {
          skipped++
        } else if (threads.length < cap) {
          threads.push(ti)
        }
      }
    }
  } while (pageToken && threads.length < cap)
  return { threads, skipped }
}

export type OpenRow = { threadId: string, messageId: string, from: string, subject: string, lastAt: number }
// rest: ids listed but past OPEN_ROWS, never fetched
export type OpenList = { rows: OpenRow[], rest: string[] }
const OPEN_ROWS = 200

// Read-only: inbox threads carrying each label (read or not), each thread under the first name that has it; rows hold the newest OPEN_ROWS, rest the unfetched ids. A missing label is an empty list.
export const listOpenByLabel = async (g: gmail_v1.Gmail, names: string[], budget: RetryBudget, signal?: AbortSignal): Promise<Map<string, OpenList>> => {
  const { data } = await withRateLimitRetry(() => g.users.labels.list({ userId: 'me' }, { signal }), { budget })
  const out = new Map<string, OpenList>()
  const seen = new Set<string>()
  for (const name of names) {
    const labelId = data.labels?.find((l) => l.name === name)?.id
    const ids: string[] = []
    let pageToken: string | undefined
    while (labelId) {
      const token = pageToken
      const page = (await withRateLimitRetry(() => g.users.threads.list({ userId: 'me', labelIds: ['INBOX', labelId], maxResults: LIST_PAGE, pageToken: token }, { signal }), { budget })).data
      ids.push(...(page.threads ?? []).map((t) => t.id).filter((id): id is string => !!id && !seen.has(id)))
      pageToken = page.nextPageToken ?? undefined
      if (!pageToken || ids.length >= COUNT_CAP) {
        break
      }
    }
    ids.forEach((id) => seen.add(id))
    const rows: OpenRow[] = []
    const want = ids.slice(0, OPEN_ROWS)
    for (let i = 0; i < want.length; i += GET_CHUNK) {
      const settled = await Promise.allSettled(want.slice(i, i + GET_CHUNK).map((id) => withRateLimitRetry(() => g.users.threads.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject'] }, { signal }), { budget })))
      for (const r of settled) {
        if (r.status === 'rejected') {
          // deleted between list and get: skip it rather than lose the whole section
          if ((r.reason as { response?: { status?: number } })?.response?.status === 404) {
            continue
          }
          throw r.reason
        }
        const t = r.value.data
        const newest = (t.messages ?? []).reduce<gmail_v1.Schema$Message | null>((a, m) => a === null || Number(m.internalDate ?? 0) >= Number(a.internalDate ?? 0) ? m : a, null)
        if (t.id && newest?.id) {
          const h = headerMap(newest)
          rows.push({ threadId: t.id, messageId: newest.id, from: h.get('from') ?? '', subject: h.get('subject') ?? '', lastAt: Number(newest.internalDate ?? 0) })
        }
      }
    }
    out.set(name, { rows, rest: ids.slice(OPEN_ROWS) })
  }
  return out
}

// shortcut: resultSizeEstimate is approximate, fine for a "known sender" signal.
export const senderCount30d = async (g: gmail_v1.Gmail, address: string, budget: RetryBudget = createRetryBudget()): Promise<number> => {
  const { data } = await withRateLimitRetry(() => g.users.threads.list({ userId: 'me', q: `from:${address} newer_than:30d`, maxResults: 1 }), { budget })
  return data.resultSizeEstimate ?? 0
}
