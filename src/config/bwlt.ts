// .bwlt encrypted wallet export/import format.
//
// Port of packages/cli-go/config/bwlt.go + crypto.go, and of the JSON payload
// built by `botwallet wallet export` (packages/cli-go/cmd/wallet.go).
//
// Binary format:
//   Bytes 0-3:   Magic "BWLT" (0x42, 0x57, 0x4C, 0x54)
//   Byte  4:     Version (0x01)
//   Bytes 5-7:   Reserved (0x00, 0x00, 0x00)
//   Bytes 8-43:  Export ID (36-byte UUID as ASCII)
//   Bytes 44-55: AES-GCM Nonce (12 bytes)
//   Bytes 56+:   AES-256-GCM ciphertext (JSON payload + 16-byte auth tag)

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { base58 } from '@scure/base';
import { keyShareFromMnemonic } from '../frost/encoding.js';

const BWLT_MAGIC = Uint8Array.from([0x42, 0x57, 0x4C, 0x54]); // "BWLT"
const BWLT_VERSION = 0x01;
const HEADER_SIZE = 8;
const EXPORT_ID_LEN = 36;
const NONCE_LEN = 12;
const AUTH_TAG_LEN = 16;
const MIN_FILE_SIZE = HEADER_SIZE + EXPORT_ID_LEN + NONCE_LEN + AUTH_TAG_LEN;

export interface BwltContents {
  exportId: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

/**
 * Write an encrypted wallet export to a new .bwlt file.
 * Never replaces an existing file: fails with EEXIST instead.
 */
export function writeBwlt(
  filePath: string,
  exportId: string,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): void {
  if (exportId.length !== EXPORT_ID_LEN) {
    throw new Error(`Export ID must be ${EXPORT_ID_LEN} characters, got ${exportId.length}`);
  }
  if (nonce.length !== NONCE_LEN) {
    throw new Error(`Nonce must be ${NONCE_LEN} bytes, got ${nonce.length}`);
  }

  const totalSize = HEADER_SIZE + EXPORT_ID_LEN + NONCE_LEN + ciphertext.length;
  const buf = Buffer.alloc(totalSize);
  let offset = 0;

  // Header: magic + version + reserved
  buf.set(BWLT_MAGIC, offset); offset += 4;
  buf[offset++] = BWLT_VERSION;
  buf[offset++] = 0x00;
  buf[offset++] = 0x00;
  buf[offset++] = 0x00;

  // Export ID (36-byte UUID ASCII)
  buf.write(exportId, offset, 'ascii'); offset += EXPORT_ID_LEN;

  // Nonce (12 bytes)
  buf.set(nonce, offset); offset += NONCE_LEN;

  // Ciphertext (includes GCM auth tag)
  buf.set(ciphertext, offset);

  fs.writeFileSync(filePath, buf, { mode: 0o600, flag: 'wx' });
}

/**
 * Read and parse a .bwlt file.
 */
export function readBwlt(filePath: string): BwltContents {
  const data = fs.readFileSync(filePath);

  if (data.length < MIN_FILE_SIZE) {
    throw new Error(`File too small to be a valid .bwlt file (${data.length} bytes)`);
  }

  // Verify magic
  for (let i = 0; i < 4; i++) {
    if (data[i] !== BWLT_MAGIC[i]) {
      throw new Error('Not a .bwlt file (invalid magic bytes)');
    }
  }

  // Check version
  if (data[4] !== BWLT_VERSION) {
    throw new Error(`Unsupported .bwlt version ${data[4]} (expected ${BWLT_VERSION})`);
  }

  const exportId = data.toString('ascii', HEADER_SIZE, HEADER_SIZE + EXPORT_ID_LEN);
  const nonceStart = HEADER_SIZE + EXPORT_ID_LEN;
  const nonce = Uint8Array.from(data.subarray(nonceStart, nonceStart + NONCE_LEN));
  const ciphertext = Uint8Array.from(data.subarray(nonceStart + NONCE_LEN));

  return { exportId, nonce, ciphertext };
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * Returns the 12-byte nonce and ciphertext (includes 16-byte auth tag).
 */
export function encryptPayload(
  key: Uint8Array,
  plaintext: Uint8Array,
): { nonce: Uint8Array; ciphertext: Uint8Array } {
  if (key.length !== 32) {
    throw new Error(`Encryption key must be 32 bytes, got ${key.length}`);
  }

  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // GCM ciphertext = encrypted data + auth tag (matches Go's gcm.Seal behavior)
  const ciphertext = Buffer.concat([encrypted, authTag]);

  return {
    nonce: Uint8Array.from(nonce),
    ciphertext: Uint8Array.from(ciphertext),
  };
}

/**
 * Decrypt AES-256-GCM ciphertext.
 * Ciphertext must include the 16-byte auth tag at the end.
 */
export function decryptPayload(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  if (key.length !== 32) {
    throw new Error(`Encryption key must be 32 bytes, got ${key.length}`);
  }
  if (nonce.length !== NONCE_LEN) {
    throw new Error(`Nonce must be ${NONCE_LEN} bytes, got ${nonce.length}`);
  }
  if (ciphertext.length < AUTH_TAG_LEN) {
    throw new Error('Ciphertext too short (must include auth tag)');
  }

  // Split ciphertext into encrypted data + auth tag
  const encData = ciphertext.subarray(0, ciphertext.length - AUTH_TAG_LEN);
  const authTag = ciphertext.subarray(ciphertext.length - AUTH_TAG_LEN);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([decipher.update(encData), decipher.final()]);
  return Uint8Array.from(plaintext);
}

// -----------------------------------------------------------------------------
// Payload
// -----------------------------------------------------------------------------
// The decrypted JSON. Same shape as the CLI's export (cmd/wallet.go), whose
// import refuses a file without api_key, seed, username or public_key, so
// every export must carry all of them.

export const BWLT_PAYLOAD_VERSION = 1;

export interface BwltPayload {
  version: number;
  /** Display name; the importer derives its local wallet name from it. */
  wallet_name: string;
  username: string;
  api_key: string;
  /** The wallet's Solana address (the FROST group key), base58. */
  public_key: string;
  /** Key 1: the 12-word mnemonic. */
  seed: string;
  exported_at: string;
}

/** Thrown when a decrypted .bwlt payload is unusable. */
export class BwltPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BwltPayloadError';
  }
}

/** Join the words of a mnemonic with single spaces. */
function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().split(/\s+/).join(' ');
}

function isSolanaAddress(value: string): boolean {
  try {
    return base58.decode(value).length === 32;
  } catch {
    return false;
  }
}

/** Encode an export payload as the CLI does (exported_at in RFC 3339, UTC). */
export function encodeBwltPayload(fields: Omit<BwltPayload, 'version' | 'exported_at'>): Uint8Array {
  const payload: BwltPayload = {
    version: BWLT_PAYLOAD_VERSION,
    wallet_name: fields.wallet_name,
    username: fields.username,
    api_key: fields.api_key,
    public_key: fields.public_key,
    seed: normalizeMnemonic(fields.seed),
    exported_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  return new TextEncoder().encode(JSON.stringify(payload));
}

/**
 * Parse and check a decrypted payload before anything is written to disk.
 * Accepts files from the CLI and from this server; rejects files written by
 * older MCP versions, which left out the API key, username and address.
 */
export function parseBwltPayload(plaintext: Uint8Array): BwltPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new BwltPayloadError('The wallet data in this .bwlt file could not be read. The file may be corrupted; export the wallet again.');
  }
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const text = (key: string) => (typeof obj[key] === 'string' ? (obj[key] as string).trim() : '');

  const payload: BwltPayload = {
    version: typeof obj.version === 'number' ? obj.version : 0,
    wallet_name: text('wallet_name'),
    username: text('username'),
    api_key: text('api_key'),
    public_key: text('public_key'),
    seed: normalizeMnemonic(text('seed')),
    exported_at: text('exported_at'),
  };

  if (!payload.api_key || !payload.seed || !payload.username || !payload.public_key) {
    throw new BwltPayloadError(
      'This .bwlt file is missing the wallet\'s API key, username or address. ' +
      'Files exported by older versions of the Botwallet MCP server are incomplete. ' +
      'Update the MCP server (or use the Botwallet CLI) on the machine that has the wallet and export it again.'
    );
  }

  try {
    keyShareFromMnemonic(payload.seed);
  } catch {
    throw new BwltPayloadError('The key share in this .bwlt file is not a valid 12-word phrase. Export the wallet again.');
  }

  if (!isSolanaAddress(payload.public_key)) {
    throw new BwltPayloadError('The wallet address in this .bwlt file is not valid. Export the wallet again.');
  }

  return payload;
}
