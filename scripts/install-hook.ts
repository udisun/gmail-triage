#!/usr/bin/env node
// Usage: node scripts/install-hook.ts [settings.json ...]; with no args, edits the real Claude Code settings files.
import { copyFile, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// The settings value runs through a shell, so the path is single-quoted.
const shellQuote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`
const COMMAND = shellQuote(join(import.meta.dirname, '..', 'hooks', 'pending-publish.sh'))

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const defaultFiles = async (): Promise<string[]> => {
  const profiles = join(homedir(), 'Library', 'Application Support', 'orca', 'claude-profiles')
  const ids = await readdir(profiles).catch(() => [])
  return [join(homedir(), '.claude', 'settings.json'), ...ids.map((id) => join(profiles, id, 'home', 'settings.json'))]
}

const install = async (file: string): Promise<string> => {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return `missing: ${file}`
  }
  let cfg: unknown
  try {
    cfg = JSON.parse(raw)
  } catch {
    return `skipped (invalid JSON, left untouched): ${file}`
  }
  const hooks = isRecord(cfg) ? (cfg.hooks ?? {}) : null
  const start = isRecord(hooks) ? (hooks.SessionStart ?? []) : null
  if (!isRecord(cfg) || !isRecord(hooks) || !Array.isArray(start)) {
    return `skipped (unexpected hooks shape, left untouched): ${file}`
  }
  const has = start.some((e) => isRecord(e) && Array.isArray(e.hooks) && e.hooks.some((h) => isRecord(h) && h.command === COMMAND))
  if (has) {
    return `already installed: ${file}`
  }
  start.push({ hooks: [{ type: 'command', command: COMMAND }] })
  hooks.SessionStart = start
  cfg.hooks = hooks
  // the first backup is the pristine one, so an existing backup is never replaced
  await copyFile(file, `${file}.bak-gmail-triage`, constants.COPYFILE_EXCL).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'EEXIST') {
      throw e
    }
  })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(cfg, null, 2)}${raw.endsWith('\n') ? '\n' : ''}`, { mode: (await stat(file)).mode & 0o777 })
  await rename(tmp, file)
  return `changed: ${file}`
}

const argv = process.argv.slice(2)
for (const file of argv.length > 0 ? argv : await defaultFiles()) {
  console.log(await install(file))
}
