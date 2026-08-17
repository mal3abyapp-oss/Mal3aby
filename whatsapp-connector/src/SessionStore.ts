import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

/**
 * SessionStore -- encrypts/decrypts a Baileys multi-file auth-state
 * DIRECTORY (creds.json + app-state-sync files) as a single blob for
 * storage as `bytea` via whatsapp_connector_store_session()/
 * whatsapp_connector_load_session(), and restores that blob back onto
 * disk so Baileys' own useMultiFileAuthState can read it on the next
 * connect.
 *
 * This matters for real restart survival: BaileysProvider's local temp
 * auth dir (WHATSAPP_TEMP_AUTH_DIR) is a working cache that may not
 * exist after a process restart on a fresh container/host -- Postgres
 * (via whatsapp_accounts.session_credentials_encrypted) is the actual
 * system of record. restoreSessionToDisk() is what makes a Postgres-
 * only session usable again without a new QR scan.
 *
 * Security requirements (per the re-integration directive):
 *   - Auth state is a secret: never localStorage, never plain text
 *     long-term, never source code / git, never console-logged, never
 *     returned through any API response.
 *   - The row storage itself (and its own access control -- zero RLS
 *     SELECT/UPDATE grants, RPC-only) lives in Postgres. This file only
 *     handles the encrypt/decrypt step on the connector side, so the
 *     bytes that ever leave this process for Supabase are already
 *     ciphertext -- defense in depth even though the connector
 *     authenticates with the service-role key.
 *
 * Encryption key: WHATSAPP_SESSION_ENCRYPTION_KEY (32 raw bytes,
 * base64-encoded) must be provided via environment variable / secret
 * manager, never committed.
 */

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

function encrypt(plaintext: Buffer): Buffer {
  const key = getEncryptionKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const authTag = cipher.getAuthTag()
  // [iv (12)] [authTag (16)] [ciphertext]
  return Buffer.concat([iv, authTag, encrypted])
}

function decrypt(payload: Buffer): Buffer {
  const iv = payload.subarray(0, 12)
  const authTag = payload.subarray(12, 28)
  const ciphertext = payload.subarray(28)
  const key = getEncryptionKey()
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

function tenantAuthDir(clubId: string): string {
  const root = process.env.WHATSAPP_TEMP_AUTH_DIR ?? path.resolve(process.cwd(), '.baileys-auth-tmp')
  const hash = createHash('sha256').update(clubId).digest('hex')
  return path.join(root, hash)
}

/** Reads every file in the tenant's local Baileys auth dir, encrypts them as one archive, ready for whatsapp_connector_store_session(). Called on every creds.update. */
export async function encryptAuthDirForClub(clubId: string): Promise<Buffer> {
  const dir = tenantAuthDir(clubId)
  const entries = await readdir(dir)
  const files: Record<string, string> = {}
  for (const name of entries) {
    files[name] = await readFile(path.join(dir, name), 'utf8')
  }
  return encrypt(Buffer.from(JSON.stringify(files), 'utf8'))
}

/** Decrypts a Postgres-stored session blob and writes its files back into the tenant's local auth dir, so Baileys' useMultiFileAuthState finds a valid session on the next connect -- this is what makes a session survive a process restart on a fresh host, not just within the same running process. Throws (never silently no-ops) on a corrupted/tampered payload or wrong key. */
export async function restoreAuthDirForClub(clubId: string, payload: Buffer): Promise<void> {
  const decrypted = decrypt(payload)
  const files = JSON.parse(decrypted.toString('utf8')) as Record<string, string>
  const dir = tenantAuthDir(clubId)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(path.join(dir, name), contents, { mode: 0o600 })
  }
}

export async function clearAuthDirForClub(clubId: string): Promise<void> {
  await rm(tenantAuthDir(clubId), { recursive: true, force: true })
}
