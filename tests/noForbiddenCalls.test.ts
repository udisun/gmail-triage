import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hasWriteCall, scanSource } from './scanSource.ts'

const srcDir = join(import.meta.dirname, '..', 'src')
const files = readdirSync(srcDir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'))
const read = (f: string): string => readFileSync(join(srcDir, f), 'utf8')

test('positive control: the scan reads gmailWrite.ts', () => {
  assert.ok(files.includes('gmailWrite.ts'))
  assert.ok(read('gmailWrite.ts').includes('threads.modify'))
})

test('no forbidden Gmail calls anywhere in src', () => {
  for (const f of files) {
    assert.deepEqual(scanSource(read(f)), [], f)
  }
})

test('scanSource flags forbidden calls (negative controls)', () => {
  const bad = [
    'gmail.users.threads.trash({})', 'gmail.users.threads["trash"]({})', 'gmail.users.messages.send({})', 'x.drafts.create()',
    'gmail.users.messages["modify"]({})', "gmail.users.settings['filters'].create({})", 'gmail.users.settings[`filters`].create({})',
    'gmail.users.messages[ "modify" ]({})', 'gmail.users["drafts"].create({})',
    'gmail.users.messages ["modify"]({})', 'gmail.users.messages\n["modify"]({})', 'gmail.users.messages\n  .modify({})',
    'gmail.users.threads . trash({})', 'gmail.users.settings\n  .filters.create({})',
  ]
  for (const b of bad) {
    assert.ok(scanSource(b).length > 0, b)
  }
})

test('scanSource leaves harmless code alone', () => {
  assert.deepEqual(scanSource("map.delete(k)\nconst a = '--settings'"), [])
})

test('threads.modify and labels.create live only in gmailWrite.ts', () => {
  for (const f of files.filter((x) => x !== 'gmailWrite.ts')) {
    assert.equal(hasWriteCall(read(f)), false, f)
  }
  assert.ok(read('gmailWrite.ts').includes('labels.create'))
})

test('hasWriteCall sees computed threads.modify and labels.create (negative controls)', () => {
  for (const b of ['threads ["modify"]({})', 'threads\n["modify"]({})', 'labels\n  .create({})', 'labels ["create"]({})', 'threads . modify({})', 'threads.modify({})', "threads['modify']({})", 'threads["modify"]({})', 'labels[`create`]({})', 'labels.create({})']) {
    assert.equal(hasWriteCall(b), true, b)
  }
  assert.equal(hasWriteCall('map.modify(x)'), false)
})
