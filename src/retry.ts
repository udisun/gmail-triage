export type Sleep = (ms: number) => Promise<void>

const NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH'])

export const codeOf = (e: unknown): string | null => {
  const c = (e as { code?: unknown, cause?: { code?: unknown } } | null)?.code ?? (e as { cause?: { code?: unknown } } | null)?.cause?.code
  return typeof c === 'string' ? c : null
}

export const isNetworkError = (e: unknown): boolean => NETWORK_CODES.has(codeOf(e) ?? '')

export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A missed launchd slot runs on wake before Wi-Fi/DNS is up, so network-class failures wait and retry.
export const retryNetwork = async <T>(fn: () => Promise<T>, sleep: Sleep = realSleep, attempts = 3, gapMs = 60_000): Promise<T> => {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i >= attempts || !isNetworkError(e)) {
        throw e
      }
      await sleep(gapMs)
    }
  }
}

type HttpErr = { status?: unknown, errors?: unknown, response?: { status?: unknown, data?: { error?: { errors?: unknown } } } }

export const httpStatusOf = (e: unknown): number | null => {
  const x = e as HttpErr | null
  const s = x?.response?.status ?? x?.status
  return typeof s === 'number' ? s : null
}

export const httpReasonsOf = (e: unknown): string[] => {
  const x = e as HttpErr | null
  const list = x?.response?.data?.error?.errors ?? x?.errors
  return Array.isArray(list) ? list.map((r) => (r as { reason?: unknown } | null)?.reason).filter((r): r is string => typeof r === 'string') : []
}

const isRateLimit = (e: unknown): boolean => {
  const status = httpStatusOf(e)
  return status === 429 || (status === 403 && httpReasonsOf(e).some((r) => r === 'rateLimitExceeded' || r === 'userRateLimitExceeded'))
}

export class QuotaExhaustedError extends Error {}

export type RetryBudget = { maxSleepMs: number, sleep: Sleep, slept: number, exhausted: boolean }

// One budget per run: a persistent throttle must cost a bounded total wait, not a full wait per call.
export const createRetryBudget = (o: { maxSleepMs?: number, sleep?: Sleep } = {}): RetryBudget =>
  ({ maxSleepMs: o.maxSleepMs ?? 600_000, sleep: o.sleep ?? realSleep, slept: 0, exhausted: false })

// Gmail's per-user quota is per minute, so calls back off exponentially with jitter; anything else rethrows at once.
export const withRateLimitRetry = async <T>(
  fn: () => Promise<T>, opts: { tries?: number, baseMs?: number, sleep?: Sleep, budget?: RetryBudget } = {},
): Promise<T> => {
  const { tries = 6, baseMs = 2000, budget = createRetryBudget({ sleep: opts.sleep }) } = opts
  for (let i = 1; ; i++) {
    // checked before every attempt, so a call that slept through another's exhaustion stops too
    if (budget.exhausted) {
      throw new QuotaExhaustedError('gmail quota exhausted')
    }
    try {
      return await fn()
    } catch (e) {
      if (i >= tries || !isRateLimit(e)) {
        throw e
      }
      const wait = Math.min(64_000, baseMs * 2 ** (i - 1))
      const ms = Math.min(64_000, wait + Math.random() * wait / 2)
      if (budget.slept + ms > budget.maxSleepMs) {
        budget.exhausted = true
        throw new QuotaExhaustedError('gmail quota exhausted')
      }
      budget.slept += ms
      await budget.sleep(ms)
    }
  }
}
