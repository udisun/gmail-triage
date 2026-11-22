#!/usr/bin/env node
// Daily Gmail triage: label, archive and report unread mail
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseClientJson, runAuth } from './auth.ts'
import { runArchiveOld } from './archiveOld.ts'
import { classifyBatch } from './claude.ts'
import { runDaily } from './daily.ts'
import { fetchUnreadThreads, listUnreadIds, gmailClient, stripControl } from './gmail.ts'
import { keychainWrite } from './keychain.ts'
import { loadPins } from './pins.ts'
import { createRetryBudget } from './retry.ts'
import { ARTIFACT_URL_RE, GEN_RE, markPublished } from './publish.ts'
import { goLive, runUndo, runUnsubCapture } from './run.ts'
import { runUnsubscribe } from './unsubscribe.ts'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) {
    chunks.push(c as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const commands: Record<string, (args: string[]) => Promise<void>> = {
  'store-client': async () => {
    const client = parseClientJson(await readStdin())
    await keychainWrite('oauth-client', JSON.stringify(client))
    console.log(`stored client ${client.clientId.slice(0, 8)}…`)
  },
  auth: runAuth,
  probe: async () => {
    const g = await gmailClient()
    const { threads } = await fetchUnreadThreads(g, 3)
    const { ids, capped } = await listUnreadIds(g, createRetryBudget())
    console.log(`unread threads: ${ids.length}${capped ? '+' : ''}`)
    for (const t of threads) {
      console.log(`- ${stripControl(t.subject)}`)
    }
  },
  run: async (args) => {
    // launchd's log has no timestamps of its own
    console.log(`run start ${new Date().toISOString()}`)
    process.exitCode = await runDaily({ gmail: gmailClient, classify: classifyBatch, loadPins, now: () => new Date(), repo: REPO }, { dryRun: args.includes('--dry-run') })
    console.log(`run end ${new Date().toISOString()} exit ${process.exitCode}`)
  },
  'mark-published': async (args) => {
    const url = args[0] ?? ''
    const gen = args[1] ?? ''
    if (!ARTIFACT_URL_RE.test(url) || !GEN_RE.test(gen)) {
      console.error('usage: mark-published <https://claude.ai/... artifact URL> <generation id>')
      process.exitCode = 2
      return
    }
    const ack = await markPublished(url, gen)
    if (ack === 'busy') {
      console.error('a triage run is in progress; retry mark-published in a minute')
      process.exitCode = 1
      return
    }
    console.log(ack === 'newer' ? 'url saved; a newer report is pending' : 'marked published')
  },
  undo: async (args) => {
    const date = args[0] ?? ''
    const r = await runUndo(gmailClient, date)
    if (r !== null) {
      console.log(`undo ${stripControl(date)}: restored ${r.restored}, skipped ${r.skipped}, superseded ${r.superseded}`)
    }
  },
  unsubscribe: async (args) => {
    process.exitCode = await runUnsubscribe(args.find((a) => !a.startsWith('--')) ?? '', { yes: args.includes('--yes'), retryUnknown: args.includes('--retry-unknown') })
  },
  'unsubscribe-capture': async (args) => {
    process.exitCode = await runUnsubCapture(gmailClient, args[0] ?? '')
  },
  'archive-old': async (args) => {
    process.exitCode = await runArchiveOld({ gmail: gmailClient, now: () => new Date() }, args)
  },
  'go-live': async () => {
    if (await goLive()) {
      console.log('mode is now live: the next run labels, stars and archives mail')
    }
  },
}

const cmd = Object.hasOwn(commands, process.argv[2] ?? '') ? commands[process.argv[2]] : undefined
if (!cmd) {
  console.error(`usage: gmail-triage ${Object.keys(commands).join(' | ')}`)
  process.exit(2)
}
cmd(process.argv.slice(3)).catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : 'failed')
  process.exit(1)
})
