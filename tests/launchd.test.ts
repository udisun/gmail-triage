import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..')
const SCRIPT = join(REPO, 'scripts', 'install-launchd.sh')

const fakeBin = (root: string, dirName: string, bin: string): string => {
  const dir = join(root, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, bin), '#!/bin/sh\nexit 0\n')
  chmodSync(join(dir, bin), 0o755)
  return dir
}

const install = (path: string, dest: string, env: Record<string, string> = {}, cwd?: string) =>
  spawnSync('/bin/bash', [SCRIPT, '--no-load', '--dest', dest], { cwd, env: { PATH: path, HOME: dest, ...env }, encoding: 'utf8' })

const plistJson = (file: string): any => JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }))

test('generates a valid plist with resolved absolute paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'gt-launchd-'))
  const nodeDir = realpathSync(fakeBin(root, 'fake node bin', 'node'))
  const claudeDir = realpathSync(fakeBin(root, 'fake claude & bin', 'claude'))
  const dest = join(root, 'agents')
  mkdirSync(dest)
  const res = install(`${nodeDir}:${claudeDir}:/usr/bin:/bin`, dest)
  assert.equal(res.status, 0, res.stderr)
  const file = join(dest, 'local.gmail-triage.plist')
  execFileSync('/usr/bin/plutil', ['-lint', file])
  const p = plistJson(file)
  assert.equal(p.Label, 'local.gmail-triage')
  assert.deepEqual(p.ProgramArguments, ['/usr/bin/caffeinate', '-s', join(nodeDir, 'node'), join(REPO, 'src', 'main.ts'), 'run'])
  assert.deepEqual(p.StartCalendarInterval, { Hour: 7, Minute: 30 })
  assert.equal(p.WorkingDirectory, REPO)
  assert.equal(p.ProcessType, 'Background')
  const log = join(dest, 'Library', 'Logs', 'gmail-triage.log')
  assert.equal(p.StandardOutPath, log)
  assert.equal(p.StandardErrorPath, log)
  assert.ok(p.EnvironmentVariables.PATH.split(':').includes(nodeDir))
  assert.ok(p.EnvironmentVariables.PATH.split(':').includes(claudeDir))
  assert.deepEqual(Object.keys(p.EnvironmentVariables).sort(), ['CLAUDE_BIN', 'PATH'])
  assert.equal(p.EnvironmentVariables.CLAUDE_BIN, join(claudeDir, 'claude'))
  assert.ok(!/ANTHROPIC|CLAUDE_CONFIG_DIR/.test(JSON.stringify(p)))
})

test('GMAIL_TRIAGE_HOME is carried only when set at install time', () => {
  const root = mkdtempSync(join(tmpdir(), 'gt-launchd-'))
  const nodeDir = fakeBin(root, 'n', 'node')
  fakeBin(root, 'n', 'claude')
  const dest = join(root, 'agents')
  mkdirSync(dest)
  const res = install(`${nodeDir}:/usr/bin:/bin`, dest, { GMAIL_TRIAGE_HOME: '/tmp/a&b <home>' })
  assert.equal(res.status, 0, res.stderr)
  assert.equal(plistJson(join(dest, 'local.gmail-triage.plist')).EnvironmentVariables.GMAIL_TRIAGE_HOME, '/tmp/a&b <home>')
})

test('a missing claude fails loudly and writes nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'gt-launchd-'))
  const nodeDir = fakeBin(root, 'n', 'node')
  const dest = join(root, 'agents')
  mkdirSync(dest)
  const res = install(`${nodeDir}:/usr/bin:/bin`, dest)
  assert.notEqual(res.status, 0)
  assert.match(res.stderr, /claude/)
  assert.equal(spawnSync('/bin/ls', [dest], { encoding: 'utf8' }).stdout, '')
})

test('a missing node fails loudly', () => {
  const root = mkdtempSync(join(tmpdir(), 'gt-launchd-'))
  const claudeDir = fakeBin(root, 'c', 'claude')
  const dest = join(root, 'agents')
  mkdirSync(dest)
  const res = install(`${claudeDir}:/usr/bin:/bin`, dest)
  assert.notEqual(res.status, 0)
  assert.match(res.stderr, /node/)
})

test('relative PATH entries resolve to absolute paths, and CLAUDE_BIN pins the first claude', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gt-launchd-')))
  const nodeDir = fakeBin(root, 'rel', 'node')
  const claudeDir = fakeBin(root, 'rel', 'claude')
  const otherDir = fakeBin(root, 'other', 'claude')
  const dest = join(root, 'agents')
  mkdirSync(dest)
  const res = install(`rel:other:/usr/bin:/bin`, dest, {}, root)
  assert.equal(res.status, 0, res.stderr)
  const p = plistJson(join(dest, 'local.gmail-triage.plist'))
  assert.equal(p.ProgramArguments[2], join(nodeDir, 'node'))
  assert.equal(p.EnvironmentVariables.CLAUDE_BIN, join(claudeDir, 'claude'))
  assert.notEqual(p.EnvironmentVariables.CLAUDE_BIN, join(otherDir, 'claude'))
  assert.ok(p.EnvironmentVariables.PATH.split(':').every((d: string) => d.startsWith('/')))
})

test('GMAIL_TRIAGE_LABEL renames the job and its plist; a label with other characters is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'gt-launchd-'))
  const nodeDir = fakeBin(root, 'n', 'node')
  fakeBin(root, 'n', 'claude')
  const dest = join(root, 'agents')
  mkdirSync(dest)
  const res = install(`${nodeDir}:/usr/bin:/bin`, dest, { GMAIL_TRIAGE_LABEL: 'com.dana.mail-triage' })
  assert.equal(res.status, 0, res.stderr)
  assert.equal(plistJson(join(dest, 'com.dana.mail-triage.plist')).Label, 'com.dana.mail-triage')
  const bad = install(`${nodeDir}:/usr/bin:/bin`, join(root, 'bad'), { GMAIL_TRIAGE_LABEL: 'x/../../evil' })
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /GMAIL_TRIAGE_LABEL must be/)
})
