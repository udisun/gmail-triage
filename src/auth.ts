import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { google } from 'googleapis'
import { keychainRead, keychainWrite } from './keychain.ts'

export const SCOPE = 'https://www.googleapis.com/auth/gmail.modify'
const TIMEOUT_MS = 5 * 60 * 1000

export type OAuthClient = { clientId: string, clientSecret: string }

export const parseClientJson = (text: string): OAuthClient => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('client JSON is not valid JSON')
  }
  const root = (parsed ?? {}) as { installed?: Record<string, unknown>, web?: Record<string, unknown> }
  const inner = root.installed ?? root.web
  if (typeof inner?.client_id !== 'string' || typeof inner.client_secret !== 'string' || !inner.client_id || !inner.client_secret) {
    throw new Error('client JSON needs installed.client_id/client_secret (or web.*)')
  }
  return { clientId: inner.client_id, clientSecret: inner.client_secret }
}

export const loadClient = async (): Promise<OAuthClient | null> => {
  const raw = await keychainRead('oauth-client')
  return raw === null ? null : JSON.parse(raw) as OAuthClient
}

type Res = { writeHead: (status: number, headers?: Record<string, string>) => unknown, end: (body?: string) => unknown }

// Pure per-request handler so state and error handling can be tested without a socket.
export const makeCallbackHandler = (redirect: string, state: string, onCode: (code: string) => void, onFail: (e: Error) => void) =>
  (req: { url?: string }, res: Res): void => {
    const u = new URL(req.url ?? '/', redirect)
    if (u.pathname !== '/') {
      res.writeHead(404)
      res.end()
      return
    }
    const fail = (msg: string): void => {
      res.writeHead(400, { 'content-type': 'text/plain' })
      res.end(msg)
      onFail(new Error(msg))
    }
    if (u.searchParams.get('state') !== state) {
      fail('state mismatch')
      return
    }
    const code = u.searchParams.get('code')
    if (!code) {
      fail(`authorization failed: ${u.searchParams.get('error') ?? 'no code'}`)
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('gmail-triage authorized. You can close this tab.')
    onCode(code)
  }

export type AuthDeps = {
  open: (url: string) => Promise<void>
  exchange: (code: string, redirect: string, signal: AbortSignal) => Promise<string | undefined>
  store: (refreshToken: string) => Promise<void>
  timeoutMs: number
}

// One deadline covers the browser step and the token exchange; the listener closes once a code is accepted.
export const authorize = async (client: OAuthClient, deps: AuthDeps): Promise<void> => {
  const state = randomBytes(16).toString('hex')
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const oauth = new google.auth.OAuth2(client.clientId, client.clientSecret, redirect)
  const url = oauth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: [SCOPE], state })
  const abort = new AbortController()
  let timer: NodeJS.Timeout | undefined
  try {
    const refreshToken = await Promise.race([
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('auth timed out')), deps.timeoutMs)
      }),
      (async () => {
        const code = await new Promise<string>((resolve, reject) => {
          const handle = makeCallbackHandler(redirect, state, (c) => {
            server.close()
            resolve(c)
          }, reject)
          server.on('request', handle)
          deps.open(url).catch(() => reject(new Error('could not open the browser')))
        })
        return deps.exchange(code, redirect, abort.signal)
      })(),
    ])
    if (!refreshToken) {
      throw new Error('Google returned no refresh token; revoke the app at myaccount.google.com/permissions and retry')
    }
    await deps.store(refreshToken)
  } finally {
    abort.abort()
    clearTimeout(timer)
    server.close()
    server.closeAllConnections()
  }
}

const openBrowser = (url: string): Promise<void> => new Promise((resolve, reject) => {
  console.log('Opening browser for Google sign-in...')
  execFile('open', [url], (err) => err ? reject(err) : resolve())
})

export const runAuth = async (): Promise<void> => {
  const client = await loadClient()
  if (!client) {
    throw new Error('no OAuth client stored: run store-client first')
  }
  await authorize(client, {
    open: openBrowser,
    // shortcut: getToken takes no AbortSignal, so a stalled request is abandoned (result discarded), not cancelled.
    exchange: async (code, redirect, signal) => {
      const oauth = new google.auth.OAuth2(client.clientId, client.clientSecret, redirect)
      const { tokens } = await oauth.getToken(code)
      return signal.aborted ? undefined : tokens.refresh_token ?? undefined
    },
    store: async (token) => {
      await keychainWrite('refresh-token', token)
      console.log('stored refresh token')
    },
    timeoutMs: TIMEOUT_MS,
  })
}
