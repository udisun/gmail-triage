import type { Bucket } from './types.ts'

export const BUCKETS: readonly Bucket[] = ['urgent', 'attention', 'notifications', 'outreach', 'receipts', 'nonwork', 'unsubscribe']

export const LABEL_NAME: Record<Bucket, string> = {
  urgent: 'Triage/Urgent',
  attention: 'Triage/Attention',
  notifications: 'Triage/Notifications',
  outreach: 'Triage/Outreach',
  receipts: 'Triage/Receipts',
  nonwork: 'Triage/Nonwork',
  unsubscribe: 'Triage/Unsubscribe',
}

// Not a classifier bucket: only the duplicate-collapse path uses it.
export const DUPLICATE_LABEL = 'Triage/Duplicate'

// Not a classifier bucket: only the one-time archive-old command uses it.
export const ARCHIVED_OLD_LABEL = 'Triage/Archived-old'

export const actionFor = (b: Bucket): { star: boolean, archive: boolean } => {
  if (b === 'urgent') {
    return { star: true, archive: false }
  }
  if (b === 'attention') {
    return { star: false, archive: false }
  }
  return { star: false, archive: true }
}

// owner and work come from pins.json, so the prompt can name the mailbox owner and their company.
export const bucketDefinitions = ({ owner = 'the mailbox owner', work = `${owner}'s work` }: { owner?: string, work?: string } = {}): string => [
  `urgent: needs action today — deadlines, outages, security, partners waiting on ${owner}`,
  `attention: a real person or system wants something from ${owner}, but not today`,
  'notifications: automated mail — code hosting, CI, monitoring, issue trackers, cloud providers, workspace admin',
  'outreach: cold sales and vendor pitches',
  'receipts: invoices, receipts, billing confirmations',
  `nonwork: not related to ${work}`,
  `unsubscribe: newsletters and marketing ${owner} never engages with, that have a List-Unsubscribe header`,
].join('\n')
