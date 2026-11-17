import { BUCKETS } from './buckets.ts'
import type { Bucket, ThreadInput, Verdict } from './types.ts'

const MAX_REASON_WORDS = 12
const unclassified = (): Verdict => ({ bucket: 'attention', reason: 'unclassified' })

const isBucket = (v: unknown): v is Bucket => BUCKETS.includes(v as Bucket)

const parseEntry = (e: unknown, input: ThreadInput): Verdict => {
  if (typeof e !== 'object' || e === null) {
    return unclassified()
  }
  const { bucket, reason } = e as Record<string, unknown>
  if (!isBucket(bucket) || typeof reason !== 'string') {
    return unclassified()
  }
  // unsubscribe is only actionable with a List-Unsubscribe header
  const safe: Bucket = bucket === 'unsubscribe' && input.listUnsubscribe === null ? 'outreach' : bucket
  return { bucket: safe, reason: reason.trim().split(/\s+/).slice(0, MAX_REASON_WORDS).join(' ') }
}

export const validateVerdicts = (inputs: ThreadInput[], raw: unknown): Map<string, Verdict> => {
  const verdicts = typeof raw === 'object' && raw !== null ? (raw as { verdicts?: unknown }).verdicts : undefined
  const seen = new Map<string, unknown>()
  const duplicated = new Set<string>()
  if (Array.isArray(verdicts)) {
    for (const e of verdicts) {
      const id = typeof e === 'object' && e !== null ? (e as { id?: unknown }).id : undefined
      if (typeof id !== 'string') {
        continue
      }
      if (seen.has(id)) {
        duplicated.add(id)
      }
      seen.set(id, e)
    }
  }
  // an id returned more than once is ambiguous, so it fails closed
  return new Map(inputs.map((i) => [i.threadId, duplicated.has(i.threadId) ? unclassified() : parseEntry(seen.get(i.threadId), i)]))
}
