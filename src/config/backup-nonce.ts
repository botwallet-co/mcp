// One-time code for revealing Key 1 (a speed bump against revealing it by
// accident, not a security boundary: the code goes back to the same agent).
//
// Port of the backup nonce in packages/cli-go/config. Same file
// (~/.botwallet/.backup-nonce), same JSON fields and same deletion rules, so
// a code started by either tool works in both. The expiry differs: codes
// last 30 seconds here but 5 minutes in the CLI (its BackupNonceTTL), so a
// code the CLI started is honoured here for 30 seconds only, and checking it
// later deletes it from the shared file.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { rfc3339Seconds } from '../utils/bytes.js';
import { configDir } from './config.js';

/** Same alphabet as the CLI: no l, 1, o, 0 or i. */
const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_LENGTH = 4;
export const BACKUP_CODE_TTL_MS = 30_000;

interface BackupNonce {
  code: string;
  wallet: string;
  /** RFC 3339, UTC, whole seconds (Go's time.RFC3339) */
  created_at: string;
}

export function backupNoncePath(): string {
  return path.join(configDir(), '.backup-nonce');
}

/** A random 4-character code. */
export function generateBackupCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  }
  return code;
}

/** Start a backup for a wallet. Replaces any earlier pending code. */
export function writeBackupNonce(code: string, wallet: string, now: Date = new Date()): void {
  const nonce: BackupNonce = {
    code,
    wallet,
    created_at: rfc3339Seconds(now),
  };
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(backupNoncePath(), JSON.stringify(nonce), { mode: 0o600 });
}

export type BackupCodeCheck =
  | { ok: true; wallet: string }
  | { ok: false; reason: 'none' | 'invalid' | 'expired' | 'wrong_code' };

function removeNonce(): void {
  fs.rmSync(backupNoncePath(), { force: true });
}

/**
 * Check a code against the pending backup and return its wallet.
 *
 * Deletion rules, as in the CLI's ValidateBackupNonce:
 *   - correct code: deleted (single use)
 *   - expired: deleted (a new code is needed)
 *   - wrong code: kept (the right code can still be given)
 *   - unreadable file: deleted
 */
export function checkBackupCode(code: string, now: Date = new Date()): BackupCodeCheck {
  let raw: string;
  try {
    raw = fs.readFileSync(backupNoncePath(), 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, reason: 'none' };
    throw e;
  }

  let nonce: Partial<BackupNonce>;
  try {
    nonce = JSON.parse(raw) as Partial<BackupNonce>;
  } catch {
    removeNonce();
    return { ok: false, reason: 'invalid' };
  }

  const createdAt = typeof nonce.created_at === 'string' ? Date.parse(nonce.created_at) : NaN;
  if (Number.isNaN(createdAt) || typeof nonce.wallet !== 'string' || !nonce.wallet) {
    removeNonce();
    return { ok: false, reason: 'invalid' };
  }

  if (now.getTime() - createdAt > BACKUP_CODE_TTL_MS) {
    removeNonce();
    return { ok: false, reason: 'expired' };
  }

  if (nonce.code !== code) {
    return { ok: false, reason: 'wrong_code' };
  }

  removeNonce();
  return { ok: true, wallet: nonce.wallet };
}
