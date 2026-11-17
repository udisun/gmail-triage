import { ARCHIVED_OLD_LABEL, BUCKETS, DUPLICATE_LABEL, LABEL_NAME } from './buckets.ts'
import type { Bucket } from './types.ts'

export type ModifyBody = { addLabelIds: string[], removeLabelIds: string[] }
export type ThreadsApi = { modify: (p: { userId: 'me', id: string, requestBody: ModifyBody }) => Promise<unknown> }
export type LabelsApi = {
  list: (p: { userId: 'me' }) => Promise<{ data: { labels?: { id?: string | null, name?: string | null }[] } }>
  create: (p: { userId: 'me', requestBody: { name: string, labelListVisibility: 'labelShow', messageListVisibility: 'show' } }) => Promise<{ data: { id?: string | null } }>
}

// Wraps only the API call, after the guard has validated and snapshotted the body.
export type Retry = <T>(fn: () => Promise<T>) => Promise<T>
const direct: Retry = (fn) => fn()

const STARRED = 'STARRED'
const INBOX = 'INBOX'
const UNREAD = 'UNREAD'
const SYSTEM_LABELS = new Set(['', INBOX, UNREAD, STARRED, 'TRASH', 'SPAM'])

export type LabelIds = Record<Bucket, string> & { duplicate: string, archivedOld: string }

export const triageBody = (labelId: string, action: { star: boolean, archive: boolean }): ModifyBody => ({
  addLabelIds: action.star ? [labelId, STARRED] : [labelId],
  removeLabelIds: action.archive ? [INBOX] : [],
})

// The only body that changes read state: older duplicate copies, one shared label, never an add of UNREAD.
export const dedupeBody = (dupLabelId: string): ModifyBody => ({ addLabelIds: [dupLabelId], removeLabelIds: [UNREAD, INBOX] })

// Read mail only: one shared audit label and an INBOX removal, never a change to UNREAD or STARRED.
export const archiveOldBody = (labelId: string): ModifyBody => ({ addLabelIds: [labelId], removeLabelIds: [INBOX] })

const copyIds = (v: unknown, field: string): string[] => {
  if (!Array.isArray(v)) {
    throw new Error(`${field} is not an array`)
  }
  const n = v.length
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const x: unknown = v[i]
    if (typeof x !== 'string') {
      throw new Error(`${field}[${i}] is not a string`)
    }
    out.push(x)
  }
  return out
}

// Copy by index into a plain body so iterators, toJSON, extra keys and later mutation cannot reach the API call.
const snapshot = (b: unknown): ModifyBody => {
  if (typeof b !== 'object' || b === null || Object.getPrototypeOf(b) !== Object.prototype) {
    throw new Error('modify body must be a plain object')
  }
  const keys = Object.keys(b).sort()
  if (keys.length !== 2 || keys[0] !== 'addLabelIds' || keys[1] !== 'removeLabelIds') {
    throw new Error('modify body has unexpected keys')
  }
  const rec = b as Record<string, unknown>
  return { addLabelIds: copyIds(rec.addLabelIds, 'addLabelIds'), removeLabelIds: copyIds(rec.removeLabelIds, 'removeLabelIds') }
}

// Fail closed: every id must be explicitly allowed, and an empty body is an upstream bug.
const assertWithin = (b: ModifyBody, addOk: Set<string>, removeOk: Set<string>): void => {
  if (b.addLabelIds.length === 0 && b.removeLabelIds.length === 0) {
    throw new Error('empty modify body')
  }
  for (const id of b.addLabelIds) {
    if (!addOk.has(id)) {
      throw new Error(`forbidden add label: ${id}`)
    }
  }
  for (const id of b.removeLabelIds) {
    if (!removeOk.has(id)) {
      throw new Error(`forbidden remove label: ${id}`)
    }
  }
}

export const assertTriageBody = (b: ModifyBody, triageLabelIds: Set<string>): void => {
  assertWithin(snapshot(b), new Set([...triageLabelIds, STARRED]), new Set([INBOX]))
}

export const assertDedupeBody = (b: ModifyBody, dupLabelId: string): void => {
  if (SYSTEM_LABELS.has(dupLabelId)) {
    throw new Error('dedupe label id must be a user label')
  }
  const snap = snapshot(b)
  // a read-state change without the audit label would be untraceable
  if (!snap.addLabelIds.includes(dupLabelId)) {
    throw new Error('dedupe body must add the duplicate label')
  }
  assertWithin(snap, new Set([dupLabelId]), new Set([UNREAD, INBOX]))
}

export const assertArchiveOldBody = (b: ModifyBody, labelId: string): void => {
  if (SYSTEM_LABELS.has(labelId)) {
    throw new Error('archive-old label id must be a user label')
  }
  const snap = snapshot(b)
  // an archive without the audit label would be untraceable, and a label alone archives nothing
  if (!snap.addLabelIds.includes(labelId) || !snap.removeLabelIds.includes(INBOX)) {
    throw new Error('archive-old body must add the label and remove INBOX')
  }
  assertWithin(snap, new Set([labelId]), new Set([INBOX]))
}

// UNREAD may be re-added only when undoing a dedupe entry (mode true), whose loggedLabelIds hold just the dup label; an archive-old undo may only add INBOX and remove its label.
export const assertUndoBody = (b: ModifyBody, loggedLabelIds: Set<string>, mode: boolean | 'archiveOld' = false): void => {
  if (mode === true) {
    assertWithin(snapshot(b), new Set([INBOX, UNREAD]), loggedLabelIds)
    return
  }
  if (mode === 'archiveOld') {
    assertWithin(snapshot(b), new Set([INBOX]), loggedLabelIds)
    return
  }
  assertWithin(snapshot(b), new Set([INBOX]), new Set([...loggedLabelIds, STARRED]))
}

export const applyTriage = async (threads: ThreadsApi, threadId: string, b: ModifyBody, triageLabelIds: Set<string>, retry: Retry = direct): Promise<void> => {
  const snap = snapshot(b)
  assertTriageBody(snap, triageLabelIds)
  await retry(() => threads.modify({ userId: 'me', id: threadId, requestBody: snap }))
}

export const applyDedupe = async (threads: ThreadsApi, threadId: string, b: ModifyBody, dupLabelId: string, retry: Retry = direct): Promise<void> => {
  const snap = snapshot(b)
  assertDedupeBody(snap, dupLabelId)
  await retry(() => threads.modify({ userId: 'me', id: threadId, requestBody: snap }))
}

export const applyArchiveOld = async (threads: ThreadsApi, threadId: string, b: ModifyBody, labelId: string, retry: Retry = direct): Promise<void> => {
  const snap = snapshot(b)
  assertArchiveOldBody(snap, labelId)
  await retry(() => threads.modify({ userId: 'me', id: threadId, requestBody: snap }))
}

export const applyUndo = async (threads: ThreadsApi, threadId: string, b: ModifyBody, loggedLabelIds: Set<string>, retry: Retry = direct, mode: boolean | 'archiveOld' = false): Promise<void> => {
  const snap = snapshot(b)
  assertUndoBody(snap, loggedLabelIds, mode)
  await retry(() => threads.modify({ userId: 'me', id: threadId, requestBody: snap }))
}

export const ensureLabels = async (labels: LabelsApi, retry: Retry = direct): Promise<LabelIds> => {
  const existing = new Map<string, string>()
  const { data } = await retry(() => labels.list({ userId: 'me' }))
  for (const l of data.labels ?? []) {
    if (l.id && l.name) {
      existing.set(l.name, l.id)
    }
  }
  const ids: Record<string, string> = {}
  const wanted: [string, string][] = [...BUCKETS.map((b): [string, string] => [b, LABEL_NAME[b]]), ['duplicate', DUPLICATE_LABEL], ['archivedOld', ARCHIVED_OLD_LABEL]]
  for (const [key, name] of wanted) {
    let id = existing.get(name)
    if (!id) {
      const res = await retry(() => labels.create({ userId: 'me', requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' } }))
      id = res.data.id ?? undefined
    }
    if (!id) {
      throw new Error(`could not resolve label id for ${name}`)
    }
    ids[key] = id
  }
  return ids as LabelIds
}
