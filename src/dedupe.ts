import { fromMailbox, matchesPin } from './pins.ts'
import type { Pins, ThreadInput } from './types.ts'

export type DupeGroup = { newest: ThreadInput, older: ThreadInput[] }

// Newest first by the classified message's date; the larger threadId wins a tie so reruns agree.
const newerFirst = (a: ThreadInput, b: ThreadInput): number => b.internalDate - a.internalDate || (a.threadId < b.threadId ? 1 : a.threadId > b.threadId ? -1 : 0)

// From is spoofable, so only machine mail (automated or List-Id) is grouped; pinned senders and threads with a read message are never touched.
const groupable = (t: ThreadInput, pins: Pins): boolean =>
  fromMailbox(t.from) !== null && t.allUnread && (t.automated || t.listId !== null)
  && !pins.neverArchive.some((e) => matchesPin(t.from, e)) && !pins.alwaysUrgent.some((e) => matchesPin(t.from, e))

// Groups by strict sender mailbox plus exact subject. Older copies with unread direct human mail are protectedOlder: left fully untouched.
export const groupDuplicates = (threads: ThreadInput[], pins: Pins): { keep: ThreadInput[], dupes: DupeGroup[], protectedOlder: ThreadInput[] } => {
  const groups = new Map<string, ThreadInput[]>()
  const keepIds = new Set<string>()
  for (const t of threads) {
    if (!groupable(t, pins)) {
      keepIds.add(t.threadId)
      continue
    }
    const key = `${fromMailbox(t.from)}\u0000${t.subject.trim().toLowerCase()}`
    groups.set(key, [...(groups.get(key) ?? []), t])
  }
  const dupes: DupeGroup[] = []
  const protectedOlder: ThreadInput[] = []
  for (const members of groups.values()) {
    const [newest, ...rest] = members.sort(newerFirst)
    const older = rest.filter((t) => !t.humanDirectUnread)
    protectedOlder.push(...rest.filter((t) => t.humanDirectUnread))
    if (older.length === 0) {
      keepIds.add(newest.threadId)
    } else {
      dupes.push({ newest, older })
    }
  }
  return { keep: threads.filter((t) => keepIds.has(t.threadId)), dupes, protectedOlder }
}
