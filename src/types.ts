export type Bucket = 'urgent' | 'attention' | 'notifications' | 'outreach' | 'receipts' | 'nonwork' | 'unsubscribe'

export type ThreadInput = {
  threadId: string
  messageId: string
  from: string
  toOrCcMe: boolean
  automated: boolean
  humanDirectUnread: boolean
  subject: string
  date: string
  internalDate: number
  // every message in the thread carries UNREAD; a dedupe undo can then restore read state exactly
  allUnread: boolean
  messageCount: number
  // every label on any message of the thread
  labelIds: string[]
  listId: string | null
  listUnsubscribe: string | null
  listUnsubscribePost: string | null
  snippet: string
}

export type Verdict = { bucket: Bucket, reason: string }

export type Pins = { neverArchive: string[], alwaysUrgent: string[], myAddresses?: string[], automatedDomains?: string[], owner?: string, work?: string }
