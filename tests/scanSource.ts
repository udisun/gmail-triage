const FORBIDDEN: RegExp[] = [
  /\b(messages|threads|drafts)\.(send|trash|untrash|delete|batchDelete|batchModify|import|insert)\b/,
  /\[\s*['"`](send|trash|untrash|delete|batchDelete|batchModify|import|insert)['"`]\s*\]/,
  /\bdrafts\b/,
  /\.filters\b/,
  /\bsettings\./,
  /messages\.modify/,
]

// Rewrite literal computed access to x.name (eating whitespace before the bracket), then collapse whitespace around dots.
export const normalize = (text: string): string => text
  .replace(/\s*\[\s*(['"`])([A-Za-z_$][\w$]*)\1\s*\]/g, '.$2')
  .replace(/\s*\.\s*/g, '.')

export const scanSource = (text: string): string[] => {
  const n = normalize(text)
  return FORBIDDEN.filter((re) => re.test(text) || re.test(n)).map((re) => re.source)
}

export const hasWriteCall = (text: string): boolean => /\b(threads\.modify|labels\.create)\b/.test(normalize(text))
