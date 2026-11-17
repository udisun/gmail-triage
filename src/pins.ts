import { readFile } from 'node:fs/promises'
import { actionFor } from './buckets.ts'
import type { Bucket, Pins, ThreadInput } from './types.ts'

export class PinsError extends Error {}

const REPO_PINS = new URL('../pins.json', import.meta.url)

export const loadPins = async (file: URL | string = REPO_PINS): Promise<Pins> => {
  const bad = (why: string): never => {
    throw new PinsError(`pins.json is invalid (${why}); fix it, no run was made`)
  }
  let v: unknown
  try {
    v = JSON.parse(await readFile(file, 'utf8'))
  } catch (e) {
    // Fail closed: a lost pins.json must not let a live run archive pinned or alias-addressed mail.
    if ((e as { code?: unknown }).code === 'ENOENT') {
      return bad('missing; copy pins.example.json to pins.json')
    }
    return bad(e instanceof Error ? e.message : 'unreadable')
  }
  const { neverArchive, alwaysUrgent, myAddresses, automatedDomains, owner, work } = (v ?? {}) as Record<string, unknown>
  const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((e) => typeof e === 'string')
  if (!strings(neverArchive) || !strings(alwaysUrgent)) {
    return bad('neverArchive and alwaysUrgent must be arrays of strings')
  }
  if (myAddresses !== undefined && !strings(myAddresses)) {
    return bad('myAddresses must be an array of strings')
  }
  if (automatedDomains !== undefined && !strings(automatedDomains)) {
    return bad('automatedDomains must be an array of strings')
  }
  // Both reach the classifier prompt: one short line each.
  const name = (x: unknown): x is string | undefined => x === undefined || (typeof x === 'string' && /^[^\n\r<>]{1,80}$/.test(x))
  if (!name(owner) || !name(work)) {
    return bad('owner and work must be strings of 1 to 80 characters, one line, no < or >')
  }
  return { neverArchive, alwaysUrgent, myAddresses: myAddresses ?? [], automatedDomains: automatedDomains ?? [], ...(owner === undefined ? {} : { owner }), ...(work === undefined ? {} : { work }) }
}

// Every address-shaped token, comments and group syntax included: over-matching only keeps mail in the inbox.
// One split and anchored single-class checks keep this linear; a global unanchored regex backtracks quadratically.
const NOT_TOKEN_RE = /[^\p{L}\p{M}\p{N}.!#$%&'*+/=?^_`{|}~@-]+/u
const DOMAIN_PREFIX_RE = /^[\p{L}\p{M}\p{N}.-]*/u
export const addressTokens = (header: string): string[] => {
  const out: string[] = []
  for (const piece of header.normalize('NFC').split(NOT_TOKEN_RE)) {
    const parts = piece.split('@')
    for (let i = 0; i + 1 < parts.length; i++) {
      const labels = (parts[i + 1].match(DOMAIN_PREFIX_RE)?.[0] ?? '').split('.')
      const end = labels.indexOf('')
      const domain = end === -1 ? labels : labels.slice(0, end)
      if (parts[i] !== '' && domain.length >= 2) {
        out.push(`${parts[i]}@${domain.join('.')}`)
      }
    }
  }
  return out
}


// Quoted strings and comments are dropped first, so a display name or trailing comment cannot supply the address; exactly one address or null.
export const fromMailbox = (from: string): string | null => {
  let out = ''
  let quoted = false
  let depth = 0
  for (let i = 0; i < from.length; i++) {
    const c = from[i]
    if (c === '\\' && (quoted || depth > 0)) {
      i++
    } else if (quoted) {
      quoted = c !== '"'
    } else if (depth > 0) {
      depth += c === '(' ? 1 : c === ')' ? -1 : 0
    } else if (c === '"') {
      quoted = true
    } else if (c === '(') {
      depth = 1
    } else {
      out += c
    }
  }
  const found = addressTokens(out)
  return found.length === 1 ? found[0].toLowerCase() : null
}

export const matchesPin = (from: string, entry: string): boolean => {
  const addr = fromMailbox(from)
  const e = entry.trim().toLowerCase()
  const pin = e.startsWith('@') ? e : fromMailbox(entry)
  if (addr === null || pin === null) {
    return false
  }
  if (!pin.startsWith('@')) {
    return addr === pin
  }
  const domain = addr.slice(addr.lastIndexOf('@') + 1)
  return domain === pin.slice(1) || domain.endsWith(`.${pin.slice(1)}`)
}

export const applyPins = (from: string, bucket: Bucket, pins: Pins): Bucket => {
  if (pins.alwaysUrgent.some((e) => matchesPin(from, e))) {
    return 'urgent'
  }
  if (bucket !== 'urgent' && bucket !== 'attention' && pins.neverArchive.some((e) => matchesPin(from, e))) {
    return 'attention'
  }
  return bucket
}

// Archiving is thread-wide, so any unread human direct message in the thread keeps it in the inbox.
export const applyDirectMailFloor = (t: ThreadInput, bucket: Bucket): Bucket =>
  actionFor(bucket).archive && t.humanDirectUnread ? 'attention' : bucket
