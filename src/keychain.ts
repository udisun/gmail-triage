import { execFile, spawn } from 'node:child_process'

export class KeychainError extends Error {}

export type Account = 'oauth-client' | 'refresh-token'

const SERVICE = 'gmail-triage'
const NOT_FOUND = 44
const defaultBin = (): string => process.env.SECURITY_BIN ?? 'security'

export const keychainRead = (account: Account, bin: string = defaultBin()): Promise<string | null> => new Promise((resolve, reject) => {
  execFile(bin, ['find-generic-password', '-s', SERVICE, '-a', account, '-w'], (err, stdout) => {
    if (!err) {
      resolve(stdout.replace(/\r?\n$/, ''))
      return
    }
    if ((err as { code?: unknown }).code === NOT_FOUND) {
      resolve(null)
      return
    }
    reject(new KeychainError(`keychain read failed for ${account}`))
  })
})

// The secret goes to `security -i` on stdin as hex, so it never appears in argv or ps.
const writeOnce = (account: Account, value: string, bin: string): Promise<void> => new Promise((resolve, reject) => {
  const child = spawn(bin, ['-i'], { stdio: ['pipe', 'ignore', 'ignore'] })
  child.on('error', () => reject(new KeychainError(`keychain write failed for ${account}`)))
  child.on('close', (code) => {
    if (code === 0) {
      resolve()
      return
    }
    reject(new KeychainError(`keychain write failed for ${account} (exit ${code})`))
  })
  child.stdin.on('error', () => undefined)
  child.stdin.end(`add-generic-password -U -s ${SERVICE} -a ${account} -X ${Buffer.from(value, 'utf8').toString('hex')}\n`)
})

// The exit code alone can't prove persistence, so read back and require an exact match.
export const keychainWrite = async (account: Account, value: string, bin: string = defaultBin()): Promise<void> => {
  await writeOnce(account, value, bin)
  if ((await keychainRead(account, bin)) !== value.replace(/\r?\n$/, '')) {
    throw new KeychainError(`keychain write for ${account} was not persisted`)
  }
}
