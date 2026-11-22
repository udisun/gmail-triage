import { applyUndo } from './gmailWrite.ts'
import type { ModifyBody, Retry, ThreadsApi } from './gmailWrite.ts'
import { appendUndone, loadState, readRunOps, readUndone, saveState } from './state.ts'

export type UndoApi = ThreadsApi & { get: (p: { userId: 'me', id: string, format: 'minimal' }) => Promise<{ data: { messages?: { id?: string | null, internalDate?: string | null }[] } }> }

// Newest message of the thread; a dedupe entry logged this id, so anything else means mail arrived since.
const newestMessageId = async (api: UndoApi, id: string, retry?: Retry): Promise<string | null> => {
  const read = () => api.get({ userId: 'me', id, format: 'minimal' })
  const { data } = await (retry ? retry(read) : read())
  let best: { id: string, at: number } | null = null
  for (const m of data.messages ?? []) {
    const at = Number(m.internalDate ?? 0)
    if (m.id && (best === null || at >= best.at)) {
      best = { id: m.id, at }
    }
  }
  return best?.id ?? null
}

export const undoRun = async (api: UndoApi, date: string, retry?: Retry): Promise<{ restored: number, skipped: number, superseded: string[] }> => {
  const ops = await readRunOps(date)
  const entries = ops.map((o) => o.entry)
  const logged = new Set(entries.filter((e) => e.kind === undefined || e.kind === 'triage').map((e) => e.labelId).filter((id) => id !== ''))
  const dupLogged = new Set(entries.filter((e) => e.kind === 'dedupe').map((e) => e.labelId))
  const oldLogged = new Set(entries.filter((e) => e.kind === 'archiveOld').map((e) => e.labelId))
  // A receipt is per operation; one written before operation ids existed matches only entries that have none.
  const receipts = await readUndone(date)
  const undoneOps = new Set(receipts.flatMap((u) => (u.opId === undefined ? [] : [u.opId])))
  const undoneLegacy = new Set(receipts.filter((u) => u.opId === undefined).map((u) => `${u.threadId}\n${u.messageId}`))
  const state = await loadState()
  const pruned: string[] = []
  const failed: string[] = []
  const superseded: string[] = []
  let skipped = 0
  let restored = 0
  for (const { entry: e, opId, legacy } of ops) {
    if (undoneOps.has(opId) || (legacy && undoneLegacy.has(`${e.threadId}\n${e.messageId}`))) {
      // A crash between the receipt and the state save leaves the marker behind: finish that cleanup, no Gmail call.
      if (e.kind !== 'archiveOld' && state.processed[e.threadId] === e.messageId) {
        pruned.push(e.threadId)
      }
      skipped++
      continue
    }
    // A missing marker means the write was uncertain (response lost) and label changes are idempotent, so undo it; a different marker means a later run owns the thread.
    // archive-old threads were never triaged, so any marker there belongs to an earlier run and is not ours to judge or prune
    const marker = state.processed[e.threadId]
    if (e.kind !== 'archiveOld' && marker !== undefined && marker !== e.messageId) {
      superseded.push(e.threadId)
      continue
    }
    // Re-adding UNREAD (dedupe) or INBOX (archive-old) is exact only while the thread still ends at the message the run archived.
    if (e.kind === 'dedupe' || e.kind === 'archiveOld') {
      try {
        if ((await newestMessageId(api, e.threadId, retry)) !== e.messageId) {
          superseded.push(e.threadId)
          continue
        }
      } catch {
        failed.push(e.threadId)
        continue
      }
    }
    const body: ModifyBody = e.kind === 'dedupe'
      ? { addLabelIds: ['UNREAD', 'INBOX'], removeLabelIds: [e.labelId] }
      : e.kind === 'archiveOld'
        ? { addLabelIds: ['INBOX'], removeLabelIds: [e.labelId] }
        : { addLabelIds: [...(e.archived ? ['INBOX'] : []), ...(e.removedLabelIds ?? [])], removeLabelIds: [...(e.labelId ? [e.labelId] : []), ...(e.starred ? ['STARRED'] : [])] }
    if (body.addLabelIds.length === 0 && body.removeLabelIds.length === 0) {
      skipped++
      continue
    }
    try {
      await applyUndo(api, e.threadId, body, e.kind === 'dedupe' ? dupLogged : e.kind === 'archiveOld' ? oldLogged : logged, retry, e.kind === 'dedupe' ? true : e.kind === 'archiveOld' ? 'archiveOld' : false, new Set(e.kind === 'dedupe' || e.kind === 'archiveOld' ? [] : e.removedLabelIds ?? []))
    } catch {
      failed.push(e.threadId)
      continue
    }
    await appendUndone(date, { threadId: e.threadId, messageId: e.messageId, opId })
    if (e.kind !== 'archiveOld') {
      pruned.push(e.threadId)
    }
    restored++
  }
  if (pruned.length > 0) {
    for (const id of pruned) {
      delete state.processed[id]
    }
    await saveState(state)
  }
  if (failed.length > 0) {
    throw new Error(`undo failed for ${failed.length} thread(s): ${failed.join(', ')}`)
  }
  return { restored, skipped, superseded }
}
