import crypto from 'node:crypto';

/** Normalise a pasted/loaded setup token: trim, drop a pasted "OWNER_SETUP_TOKEN=" prefix and wrapping quotes. */
export function cleanToken(value) {
  let t = String(value || '').trim();
  t = t.replace(/^OWNER_SETUP_TOKEN\s*=\s*/i, '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1).trim();
  return t;
}

/** Short, non-reversible tag that lets you compare two tokens without revealing either. */
export const tokenFingerprint = t => crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 6);
