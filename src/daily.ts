import { stripControl } from './gmail.ts'
import { PinsError } from './pins.ts'
import { publishAndNotify, summaryOf } from './publish.ts'
import { codeOf, httpReasonsOf, httpStatusOf, realSleep } from './retry.ts'
import type { Sleep } from './retry.ts'
import { errorInput, exitCodeOf, localDate, runTriage, writeReport } from './run.ts'
import type { Deps } from './run.ts'
import { loadState } from './state.ts'
import type { Pins } from './types.ts'

export type DailyDeps = {
  gmail: Deps['gmail'], classify: Deps['classify'], loadPins: () => Promise<Pins>, now: () => Date, repo: string,
  publish?: typeof publishAndNotify, sleep?: Sleep,
}

// Class, code, or HTTP status and reason only: a raw message can carry email content into the report and the notification.
export const failureReason = (e: unknown): string => {
  if (e instanceof PinsError) {
    return 'pins.json invalid'
  }
  if (e instanceof Error && e.message.startsWith('state.json is corrupt')) {
    return 'state.json corrupt'
  }
  const status = httpStatusOf(e)
  if (status !== null && e instanceof Error && e.constructor.name === 'GaxiosError') {
    const reason = httpReasonsOf(e).find((r) => /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(r))
    return reason ? `GaxiosError ${status} ${reason}` : `GaxiosError ${status}`
  }
  const code = codeOf(e)
  if (code !== null && /^[A-Z][A-Z0-9_]{2,40}$/.test(code)) {
    return code
  }
  const name = e instanceof Error ? e.constructor.name : ''
  return /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) ? name : 'Error'
}

// Launchd log only: which call failed (method and path, id-like segments masked), never what it carried.
export const failureWhere = (e: unknown): string => {
  const c = (e as { config?: { method?: unknown, url?: unknown } } | null)?.config
  let path: string
  try {
    path = new URL(String(c?.url)).pathname
  } catch {
    return ''
  }
  const masked = path.split('/').map((seg) => (seg === '' || /^[A-Za-z]{1,12}\d?$/.test(seg) ? seg : ':id')).join('/')
  const method = typeof c?.method === 'string' && /^[A-Z]{3,7}$/.test(c.method) ? `${c.method} ` : ''
  return ` (${method}${masked})`
}

export const RUN_RETRY_MS = 2 * 60 * 1000

// A 401 that survives googleapis' own refresh-and-retry, or a 5xx, escaping runTriage: worth one fresh whole run (per-thread failures stay failed rows, retried by the next run) (2026-11-17 failed with a 401 after waking from sleep).
export const isTransientRunError = (e: unknown): boolean => {
  const status = httpStatusOf(e)
  return status !== null && e instanceof Error && e.constructor.name === 'GaxiosError' && (status === 401 || status >= 500)
}

// Returns the process exit code; any failure after pins load or lock still leaves a report and a notification.
export const runDaily = async (deps: DailyDeps, opts: { dryRun: boolean }): Promise<number> => {
  const publish = deps.publish ?? publishAndNotify
  let res: Awaited<ReturnType<typeof runTriage>>
  try {
    const pins = await deps.loadPins()
    const triage = () => runTriage({ gmail: deps.gmail, classify: deps.classify, pins, now: deps.now, repo: deps.repo, sleep: deps.sleep }, opts)
    // runTriage releases its lock in a finally, so the second run can take it again
    res = await triage().catch(async (e: unknown) => {
      if (!isTransientRunError(e)) {
        throw e
      }
      console.error(`${failureReason(e)}${failureWhere(e)}: retrying the whole run in ${RUN_RETRY_MS / 60_000} min`)
      await (deps.sleep ?? realSleep)(RUN_RETRY_MS)
      return triage()
    })
  } catch (e) {
    const mode = await loadState().then((s) => (opts.dryRun || s.mode === 'dry' ? 'dry' : 'live'), () => 'live' as const)
    const input = errorInput(localDate(deps.now()), mode, `Run failed: ${failureReason(e)}`, deps.repo)
    console.error(`${input.error}${failureWhere(e)}`)
    await publish(await writeReport(input), summaryOf(input))
    return 1
  }
  if (res === null) {
    return 0
  }
  console.log(`report: ${res.reportFile}`)
  if (res.input.error !== null) {
    console.error(stripControl(res.input.error))
  }
  if (res.failed.length > 0) {
    console.error(`failed to triage ${res.failed.length} thread(s): ${res.failed.map(stripControl).join(', ')}`)
  }
  await publish(res.reportFile, stripControl(summaryOf(res.input)))
  return exitCodeOf(res)
}
