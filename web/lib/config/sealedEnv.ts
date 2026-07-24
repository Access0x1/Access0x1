/**
 * sealedEnv.ts — one encrypted keystore file instead of N secrets in a console.
 *
 * THE PROBLEM IT SOLVES: pasting 20+ credentials into a deploy provider's UI is
 * slow, unauditable, and easy to get wrong. Sealing them into a single file that
 * travels with the deploy makes provisioning one step.
 *
 * THE HONEST LIMIT — read this before trusting it:
 *
 *   Sealing does NOT eliminate the need for a secret at deploy time. It reduces
 *   N secrets to ONE: the passphrase that unlocks the file. That passphrase
 *   still has to reach the running process some other way (a deploy-provider env
 *   var, a CI secret, typed by hand at boot). Anything claiming to remove the
 *   last secret is moving it, not deleting it. The win is real but it is
 *   "20 secrets -> 1", not "20 secrets -> 0".
 *
 *   Consequences that follow from that:
 *   - The sealed file is only as strong as the passphrase. It is an OFFLINE
 *     target: whoever holds the file can brute-force it forever with no rate
 *     limit and nothing to alert on. Use a long generated passphrase, never a
 *     memorable one.
 *   - DO NOT COMMIT the sealed file to a public repository. Encrypted-at-rest is
 *     not encrypted-against-a-patient-attacker-with-your-file. `.env.sealed` is
 *     gitignored and should stay that way.
 *   - There is no rotation, no revocation, and no audit log. A managed secrets
 *     store (AWS Secrets Manager, 1Password, Doppler) gives you all three. For
 *     testnet keys the tradeoff is fine; for anything guarding real money the
 *     audit trail is the point, and this file is not a substitute.
 *
 * CRYPTO: AES-256-GCM (authenticated — tampering fails loudly rather than
 * decrypting to garbage), key derived with scrypt at N=2^17 so a guess is
 * expensive. Salt and IV are random per seal, so sealing the same input twice
 * never produces the same bytes.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/** Format version — lets a future change stay readable against old files. */
const VERSION = 1

/** scrypt cost. N=2^17 is ~1s to derive: negligible at deploy, brutal to brute-force. */
const SCRYPT_N = 1 << 17
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_BYTES = 32
const SALT_BYTES = 16
const IV_BYTES = 12

/** Below this a passphrase is guessable offline; sealing refuses. */
export const MIN_PASSPHRASE_LENGTH = 16

/** The on-disk shape. Everything here is safe to store EXCEPT with a weak passphrase. */
export interface SealedFile {
  readonly version: number
  readonly kdf: 'scrypt'
  readonly N: number
  readonly r: number
  readonly p: number
  /** base64 */
  readonly salt: string
  /** base64 */
  readonly iv: string
  /** base64 — GCM authentication tag */
  readonly tag: string
  /** base64 — the encrypted payload */
  readonly data: string
}

/** Thrown when the passphrase is wrong or the file was tampered with. */
export class SealedEnvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SealedEnvError'
  }
}

function deriveKey(passphrase: string, salt: Buffer, N: number, r: number, p: number): Buffer {
  // maxmem must be raised explicitly: node's default rejects N=2^17.
  return scryptSync(passphrase, salt, KEY_BYTES, { N, r, p, maxmem: 256 * 1024 * 1024 })
}

/**
 * Encrypt `plaintext` under `passphrase`.
 *
 * @throws {SealedEnvError} if the passphrase is too short to resist offline attack.
 */
export function seal(plaintext: string, passphrase: string): SealedFile {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new SealedEnvError(
      `passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters — a sealed file is an offline target with no rate limit`,
    )
  }
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const key = deriveKey(passphrase, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    version: VERSION,
    kdf: 'scrypt',
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }
}

/**
 * Decrypt a sealed file. GCM authentication means a wrong passphrase or a
 * modified file throws — it can never silently return wrong plaintext.
 *
 * @throws {SealedEnvError} on a bad passphrase, tampering, or an unknown version.
 */
export function open(file: SealedFile, passphrase: string): string {
  if (file?.version !== VERSION) {
    throw new SealedEnvError(`unsupported sealed-file version: ${String(file?.version)}`)
  }
  if (file.kdf !== 'scrypt') {
    throw new SealedEnvError(`unsupported kdf: ${String(file.kdf)}`)
  }
  const salt = Buffer.from(file.salt, 'base64')
  const iv = Buffer.from(file.iv, 'base64')
  const tag = Buffer.from(file.tag, 'base64')
  const key = deriveKey(passphrase, salt, file.N, file.r, file.p)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    // Deliberately identical for both causes: distinguishing "wrong passphrase"
    // from "tampered file" tells an attacker which half they got right.
    throw new SealedEnvError('could not open: wrong passphrase or the file has been modified')
  }
}

/** Parse dotenv text into pairs. Blank lines, comments, and quotes handled. */
export function parseDotenv(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1)
    }
    out.set(key, value)
  }
  return out
}

/**
 * Apply sealed values to `process.env` WITHOUT overwriting anything already set.
 *
 * Precedence is deliberate: a real environment variable always beats the sealed
 * file, so a deploy can override one value (or rotate a leaked key) without
 * re-sealing everything. Returns the NAMES applied — never the values — so the
 * caller can log what happened safely.
 */
export function applyToEnv(
  dotenvText: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const applied: string[] = []
  for (const [name, value] of parseDotenv(dotenvText)) {
    if (env[name] === undefined || env[name] === '') {
      env[name] = value
      applied.push(name)
    }
  }
  return applied
}

/** Constant-time compare, for callers checking a passphrase against a known value. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
