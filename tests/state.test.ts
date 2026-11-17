import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { acquireLock, appendRunEntry, homeDir, loadState, readRun, saveState } from '../src/state.ts'
import type { RunEntry } from '../src/state.ts'

beforeEach(() => {
  process.env.GMAIL_TRIAGE_HOME = mkdtempSync(join(tmpdir(), 'gt-state-'))
})

const entry = (threadId: string): RunEntry => ({ threadId, messageId: `m-${threadId}`, bucket: 'receipts', labelId: 'L1', starred: false, archived: true })

test('a missing state file loads the defaults', async () => {
  assert.deepEqual(await loadState(), { mode: 'dry', artifactUrl: null, processed: {} })
})

test('save then load round-trips, files are private', async () => {
  const s = { mode: 'live' as const, artifactUrl: 'https://x/y', processed: { t1: 'm1' } }
  await saveState(s)
  assert.deepEqual(await loadState(), s)
  assert.equal(statSync(join(homeDir(), 'state.json')).mode & 0o777, 0o600)
  assert.equal(statSync(homeDir()).mode & 0o777, 0o700)
})

test('malformed state.json throws instead of resetting to defaults', async () => {
  await saveState({ mode: 'live', artifactUrl: null, processed: {} })
  const file = join(homeDir(), 'state.json')
  for (const bad of ['{not json', '{"mode":"yolo","artifactUrl":null,"processed":{}}', '{"mode":"live","artifactUrl":null}', '{"mode":"live","artifactUrl":null,"processed":{"t":1}}', '[]', 'null']) {
    writeFileSync(file, bad)
    await assert.rejects(loadState(), /state\.json/, bad)
  }
})

test('run log appends one line per entry and reads back', async () => {
  await appendRunEntry('2026-11-15', entry('a'))
  await appendRunEntry('2026-11-15', entry('b'))
  assert.equal(readFileSync(join(homeDir(), 'runs', '2026-11-15.jsonl'), 'utf8').trim().split('\n').length, 2)
  assert.deepEqual(await readRun('2026-11-15'), [entry('a'), entry('b')])
  assert.equal(statSync(join(homeDir(), 'runs', '2026-11-15.jsonl')).mode & 0o777, 0o600)
})

test('readRun on an unknown date throws "no run log"', async () => {
  await assert.rejects(readRun('2026-01-01'), /no run log/)
})

test('a date that is not YYYY-MM-DD is rejected before touching a path', async () => {
  for (const d of ['../../etc/passwd', '2026-1-1', '2026-11-15/../x', '']) {
    await assert.rejects(readRun(d), /invalid date/, d)
    await assert.rejects(appendRunEntry(d, entry('a')), /invalid date/, d)
  }
})

test('lockRejectsSecondRun', async () => {
  const release = await acquireLock()
  assert.ok(release)
  assert.equal(await acquireLock(), null)
  await release()
  const again = await acquireLock()
  assert.ok(again)
  await again()
})

test('release leaves a lock that holds another pid', async () => {
  const release = await acquireLock()
  assert.ok(release)
  const lock = join(homeDir(), 'run.lock')
  writeFileSync(lock, '999999999')
  await release()
  assert.equal(readFileSync(lock, 'utf8'), '999999999')
})

const lockFile = (): string => join(homeDir(), 'run.lock')
const putLock = (content: string): string => {
  mkdirSync(homeDir(), { recursive: true })
  writeFileSync(lockFile(), content)
  return lockFile()
}
const deadPid = '999999999'

test('a lock held by a dead pid is taken over', async () => {
  putLock(deadPid)
  const release = await acquireLock({ alive: () => false })
  assert.ok(release)
  assert.equal(readFileSync(lockFile(), 'utf8'), String(process.pid))
  assert.equal(existsSync(`${lockFile()}.takeover`), false)
  await release()
})

test('a lock held by a live pid is left untouched', async () => {
  putLock(String(process.pid))
  const before = statSync(lockFile()).ino
  assert.equal(await acquireLock(), null)
  assert.equal(readFileSync(lockFile(), 'utf8'), String(process.pid))
  assert.equal(statSync(lockFile()).ino, before)
})

test('the real liveness probe sees a dead pid as stale', async () => {
  putLock(deadPid)
  const release = await acquireLock()
  assert.ok(release)
  await release()
})

test('a lock whose content is not a positive pid is stale', async () => {
  for (const junk of ['', 'abc', '0', '-5', '12abc', '99999999999999999999']) {
    putLock(junk)
    const release = await acquireLock({ alive: () => true })
    assert.ok(release, JSON.stringify(junk))
    await release()
  }
})

test('a fresh live lock appears between the guarded read and the rm: it survives, one owner', async () => {
  putLock(deadPid)
  const release = await acquireLock({
    alive: (pid) => pid === process.pid,
    afterGuard: async () => {
      await rm(lockFile())
      writeFileSync(lockFile(), String(process.pid))
    },
  })
  assert.equal(release, null)
  assert.equal(readFileSync(lockFile(), 'utf8'), String(process.pid))
  assert.equal(existsSync(`${lockFile()}.takeover`), false)
})

test('the stale lock vanishes under the guard: retry the plain create, never rm', async () => {
  putLock(deadPid)
  const release = await acquireLock({ alive: () => false, afterGuard: async () => { await rm(lockFile()) } })
  assert.ok(release)
  assert.equal(readFileSync(lockFile(), 'utf8'), String(process.pid))
  await release()
})

test('two contenders on a dead lock: B runs inside A\'s guarded window, exactly one wins', async () => {
  putLock(deadPid)
  let b: (() => Promise<void>) | null | undefined
  const a = await acquireLock({
    alive: () => false,
    afterGuard: async () => {
      b = await acquireLock({ alive: () => false })
    },
  })
  assert.ok(a)
  assert.equal(b, null)
})

test('a leftover takeover guard blocks a dead-lock takeover', async () => {
  putLock(deadPid)
  writeFileSync(`${lockFile()}.takeover`, '1')
  assert.equal(await acquireLock({ alive: () => false }), null)
  assert.equal(readFileSync(lockFile(), 'utf8'), deadPid)
})

test('a leftover guard does not matter while the lock holder is alive', async () => {
  const first = await acquireLock()
  assert.ok(first)
  writeFileSync(`${lockFile()}.takeover`, '1')
  assert.equal(await acquireLock(), null)
  await first()
})

const runLog = (): string => join(homeDir(), 'runs', '2026-11-15.jsonl')
const line = (id: string): string => JSON.stringify(entry(id))

test('a torn final line is ignored by readRun, intact entries still come back', async () => {
  await appendRunEntry('2026-11-15', entry('a'))
  writeFileSync(runLog(), `${line('a')}\n${line('b').slice(0, 20)}`)
  assert.deepEqual(await readRun('2026-11-15'), [entry('a')])
})

test('append after a torn tail parks the fragment in .torn and keeps intact + new', async () => {
  await appendRunEntry('2026-11-15', entry('a'))
  const frag = line('b').slice(0, 20)
  writeFileSync(runLog(), `${line('a')}\n${frag}`)
  await appendRunEntry('2026-11-15', entry('c'))
  assert.deepEqual(await readRun('2026-11-15'), [entry('a'), entry('c')])
  assert.equal(readFileSync(`${runLog()}.torn`, 'utf8'), `${frag}\n`)
})

test('a complete last line that only lost its newline is kept', async () => {
  await appendRunEntry('2026-11-15', entry('a'))
  writeFileSync(runLog(), line('a'))
  await appendRunEntry('2026-11-15', entry('b'))
  assert.deepEqual(await readRun('2026-11-15'), [entry('a'), entry('b')])
  assert.equal(existsSync(`${runLog()}.torn`), false)
})

test('interior corruption throws naming the line number', async () => {
  await appendRunEntry('2026-11-15', entry('a'))
  writeFileSync(runLog(), `${line('a')}\n{broken\n${line('c')}\n`)
  await assert.rejects(readRun('2026-11-15'), /line 2/)
  writeFileSync(runLog(), `${line('a')}\n{"threadId":1}\n${line('c')}\n`)
  await assert.rejects(readRun('2026-11-15'), /line 2/)
})

test('A pauses between the temp write and the link: the lock is never empty, exactly one of A/B owns it, no tmp files remain', async () => {
  const seen: string[] = []
  const peek = (): void => {
    seen.push(existsSync(lockFile()) ? readFileSync(lockFile(), 'utf8') : 'absent')
  }
  let b: (() => Promise<void>) | null | undefined
  let paused = false
  const a = await acquireLock({
    beforeLink: async () => {
      if (paused) {
        return
      }
      paused = true
      peek()
      b = await acquireLock()
      peek()
    },
  })
  assert.deepEqual(seen, ['absent', String(process.pid)])
  assert.equal([a, b].filter((r) => typeof r === 'function').length, 1)
  assert.ok(b)
  assert.equal(a, null)
  assert.equal(readdirSync(homeDir()).filter((f) => f.endsWith('.tmp')).length, 0)
})

test('a dedupe entry round-trips and one with a bad shape is rejected', async () => {
  const d: RunEntry = { kind: 'dedupe', threadId: 't1', messageId: 'm1', labelId: 'D1' }
  await appendRunEntry('2026-11-15', d)
  assert.deepEqual(await readRun('2026-11-15'), [d])
  await appendRunEntry('2026-11-16', { ...d, labelId: 5 } as unknown as RunEntry)
  await assert.rejects(readRun('2026-11-16'), /not a valid entry/)
  await appendRunEntry('2026-11-17', { ...entry('a'), kind: 'weird' } as unknown as RunEntry)
  await assert.rejects(readRun('2026-11-17'), /not a valid entry/)
})

test('an entry may not claim the reserved legacy: operation id prefix, nor an empty one', async () => {
  for (const [i, opId] of ['legacy:x', ''].entries()) {
    await appendRunEntry(`2026-12-0${i + 1}`, { ...entry('a'), opId })
    await assert.rejects(readRun(`2026-12-0${i + 1}`), /not a valid entry/)
  }
})
