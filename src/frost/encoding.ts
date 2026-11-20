// FROST key share encoding: Ed25519 scalars <-> 12-word BIP39 mnemonics.
//
// Port of packages/cli-go/solana/frost/encoding.go
//
// ENCODING SCHEME:
//  1. Generate 16 bytes (128 bits) of cryptographic randomness
//  2. Encode as 12-word BIP39 mnemonic (standard, human-readable)
//  3. Derive Ed25519 scalar via SHA-512(entropy || domain) -> reduce mod l
//
// DETERMINISM: Same mnemonic always produces the same scalar.

import { sha512 } from '@noble/hashes/sha2';
import { randomBytes } from '@noble/hashes/utils';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToNumberLE, reduceScalar64 } from './scalar.js';
import type { KeyShare } from './types.js';

const { ExtendedPoint } = ed25519;

const DOMAIN_SEPARATOR = 'botwallet/frost/v1/key-share';

/**
 * Generate a new random 12-word BIP39 mnemonic for a FROST key share.
 */
export function generateShareMnemonic(): string {
  const entropy = randomBytes(16);
  return bip39.entropyToMnemonic(entropy, wordlist);
}

/**
 * Derive a FROST key share scalar from raw entropy bytes.
 * Core derivation: SHA-512(entropy || "botwallet/frost/v1/key-share") -> reduce mod l
 */
export function scalarFromEntropy(entropy: Uint8Array): Uint8Array {
  if (entropy.length < 16) {
    throw new Error(`frost: entropy too short (${entropy.length} bytes, need >= 16)`);
  }
  const domainBytes = new TextEncoder().encode(DOMAIN_SEPARATOR);
  const hash = sha512.create();
  hash.update(entropy);
  hash.update(domainBytes);
  return reduceScalar64(hash.digest());
}

/**
 * Derive a FROST key share scalar from a 12-word BIP39 mnemonic.
 */
export function scalarFromMnemonic(mnemonic: string): Uint8Array {
  if (!bip39.validateMnemonic(mnemonic, wordlist)) {
    throw new Error('frost: invalid mnemonic');
  }
  const entropy = bip39.mnemonicToEntropy(mnemonic, wordlist);
  // mnemonicToEntropy returns Uint8Array directly
  return scalarFromEntropy(entropy);
}

/**
 * Derive a complete KeyShare (secret + public point) from a 12-word mnemonic.
 * Called when loading a key share from the seed file.
 */
export function keyShareFromMnemonic(mnemonic: string): KeyShare {
  const secret = scalarFromMnemonic(mnemonic);
  const pub = ExtendedPoint.BASE.multiply(bytesToNumberLE(secret)).toRawBytes();
  return { secret, public: pub };
}

/**
 * Decode a 32-byte compressed Ed25519 point. Validates it's on the curve.
 */
export function decodePoint(bytes: Uint8Array): Uint8Array {
  if (bytes.length !== 32) {
    throw new Error(`frost: point must be 32 bytes, got ${bytes.length}`);
  }
  // Validate by parsing — throws if invalid
  ExtendedPoint.fromHex(bytes);
  return bytes;
}
