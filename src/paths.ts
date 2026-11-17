import { homedir } from 'node:os'
import { join } from 'node:path'

export const homeDir = (): string => process.env.GMAIL_TRIAGE_HOME ?? join(homedir(), 'Library', 'Application Support', 'gmail-triage')
