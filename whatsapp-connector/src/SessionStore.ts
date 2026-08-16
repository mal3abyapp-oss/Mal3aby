import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * SessionStore — server-side, encrypted, tenant-isolated persistence
 * for a WhatsApp session's auth state (Baileys' multi-file auth state,
 * serialized as JSON).
 *
 * Security requirements this file exists to satisfy (per the WhatsApp
 * QR Connector directive):
 *   - Auth state is a secret: never localStorage, never browser
 *     storage, never source code / git, never console-logged, never
 *     returned through any API response, never stored unprotected in a
 *     public directory.
 *   - Multi-tenant isolation: the on-disk path for a session must be
 *     derived from clubId in a way that cannot be manipulated into a
 *     path-traversal read/write of another tenant's session, even if a
 *     clubId string were ever attacker-influenced upstream (it isn't —
 *     clubId always originates from an authenticated Supabase RPC
 *     result, never directly from a client string — but this file
 *     defends in depth anyway by hashing the id into a fixed-length
 *     hex filename rather than using it as a raw path segment).
 *
 * Encryption key: WHATSAPP_SESSION_ENCRYPTION_KEY (32 raw bytes,
 * base64-encoded) must be provided via environment variable / secret
 * manager, never committed. Session files are AES-256-GCM encrypted at
 * rest; a corrupted/tampered file fails to decrypt rather than silently
 * returning garbage auth state.
 */

const SESSIONS_DIR = process.env.WHATSAPP_SESSIONS_DIR ?? path.resolve(process.cwd(), '.sessions')

function getEncryptionKey(): Buffer {
  const raw = process.env.WHATSAPP_SESSION_ENCRYPTION_KEY
  if (!raw) {
    throw new Error(
      'WHATSAPP_SESSION_ENCRYPTION_KEY is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))" and store it in a secret manager, never in source control.',
    )
  }
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) {
    throw new Error('WHATSAPP_SESSION_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256).')
  }
  return key
}

/** Tenant isolation: never use clubId as a raw path segment. Hash it. */
function sessionFilePath(clubId: string): string {
  const hash = createHash('sha256').update(clubId).digest('hex')
  return path.join(SESSIONS_DIR, `${hash}.enc`)
}

export async function ensureSessionsDir(): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true, mode: 0o700 })
}

export async function saveSessionState(clubId: string, state: unknown): Promise<void> {
  await ensureSessionsDir()
  const key = getEncryptionKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(JSON.stringify(state), 'utf8')
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const authTag = cipher.getAuthTag()
  // [iv (12)] [authTag (16)] [ciphertext]
  const payload = Buffer.concat([iv, authTag, encrypted])
  await writeFile(sessionFilePath(clubId), payload, { mode: 0o600 })
}

export async function loadSessionState<T = unknown>(clubId: string): Promise<T | null> {
  try {
    const payload = await readFile(sessionFilePath(clubId))
    const iv = payload.subarray(0, 12)
    const authTag = payload.subarray(12, 28)
    const ciphertext = payload.subarray(28)
    const key = getEncryptionKey()
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(authTag)
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return JSON.parse(decrypted.toString('utf8')) as T
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    // A decrypt failure (tampered/corrupted file, wrong key) must never
    // silently return null and let the caller proceed as if there's no
    // session -- that would mask real tampering as "needs a fresh QR
    // scan". Surface it distinctly.
    throw new Error(`Failed to load WhatsApp session for club: ${(err as Error).message}`)
  }
}

export async function deleteSessionState(clubId: string): Promise<void> {
  await rm(sessionFilePath(clubId), { force: true })
}
