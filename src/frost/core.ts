// FROST 2-of-2 threshold signatures for Ed25519/Solana.
//
// Port of packages/cli-go/solana/frost/frost.go
//
// SECURITY MODEL:
//   - Bot holds S1, server holds S2. Full key s = s1+s2 is NEVER constructed.
//   - Signing produces partial sigs that aggregate into a standard Ed25519 sig.
//   - Solana validators cannot distinguish FROST-signed from conventional.

import { ed25519 } from '@noble/curves/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { randomBytes } from '@noble/hashes/utils';
import type { KeyShare, SigningNonce, PartialSignResult } from './types.js';

const { ExtendedPoint, CURVE } = ed25519;

// Ed25519 group order
const ORDER = CURVE.n;

function mod(a: bigint, m: bigint = ORDER): bigint {
  const result = a % m;
  return result >= 0n ? result : result + m;
}

function bytesToNumberLE(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) + BigInt(bytes[i]);
  }
  return result;
}

function numberToBytesLE(n: bigint, len: number): Uint8Array {
  const result = new Uint8Array(len);
  let val = n;
  for (let i = 0; i < len; i++) {
    result[i] = Number(val & 0xFFn);
    val >>= 8n;
  }
  return result;
}

/**
 * Reduce a 64-byte hash to a uniform scalar mod l.
 * Equivalent to Go's edwards25519.Scalar.SetUniformBytes.
 */
function reduceScalar64(bytes: Uint8Array): Uint8Array {
  if (bytes.length !== 64) throw new Error('reduceScalar64 requires 64 bytes');
  const n = bytesToNumberLE(bytes);
  return numberToBytesLE(mod(n), 32);
}

/**
 * Generate a new random FROST key share.
 *
 * SECURITY: The returned secret is the most sensitive value in the system.
 * Save to disk immediately, NEVER log or transmit.
 */
export function generateKeyShare(): KeyShare {
  const randBytes = randomBytes(64);
  const secret = reduceScalar64(randBytes);
  const pub = ExtendedPoint.BASE.multiply(bytesToNumberLE(secret)).toRawBytes();
  return { secret, public: pub };
}

/**
 * Compute the combined FROST group public key: A = A1 + A2.
 * This is the Solana deposit address — a standard Ed25519 public key.
 */
export function computeGroupKey(ourPublic: Uint8Array, theirPublic: Uint8Array): Uint8Array {
  const p1 = ExtendedPoint.fromHex(ourPublic);
  const p2 = ExtendedPoint.fromHex(theirPublic);
  return p1.add(p2).toRawBytes();
}

/**
 * Generate a random signing nonce for one round of FROST signing.
 *
 * SECURITY: Nonce MUST be used exactly once. Reusing across two messages
 * allows extraction of the key share.
 */
export function generateNonce(): SigningNonce {
  const randBytes = randomBytes(64);
  const secret = reduceScalar64(randBytes);
  const commitment = ExtendedPoint.BASE.multiply(bytesToNumberLE(secret)).toRawBytes();
  return { secret, commitment };
}

/**
 * Compute the Ed25519 challenge: k = SHA-512(R || A || M) mod l
 */
export function computeChallenge(
  groupNonce: Uint8Array,
  groupKey: Uint8Array,
  message: Uint8Array,
): Uint8Array {
  const hash = sha512.create();
  hash.update(groupNonce);
  hash.update(groupKey);
  hash.update(message);
  return reduceScalar64(hash.digest());
}

/**
 * Compute this party's partial signature for a message.
 *
 * Returns z1 = r1 + k * s1 (mod l), the group nonce R = R1+R2, and challenge k.
 *
 * SECURITY: The partial signature is safe to send to the server.
 * After calling, the nonce MUST be discarded.
 */
export function partialSign(
  message: Uint8Array,
  keyShareSecret: Uint8Array,
  nonce: SigningNonce,
  theirCommitment: Uint8Array,
  groupKey: Uint8Array,
): PartialSignResult {
  if (!message || message.length === 0) {
    throw new Error('frost: message cannot be empty');
  }

  // R = R1 + R2
  const r1Point = ExtendedPoint.fromHex(nonce.commitment);
  const r2Point = ExtendedPoint.fromHex(theirCommitment);
  const groupNoncePoint = r1Point.add(r2Point);
  const groupNonce = groupNoncePoint.toRawBytes();

  // k = SHA-512(R || A || M) mod l
  const challenge = computeChallenge(groupNonce, groupKey, message);

  // z1 = r1 + k * s1 (mod l)
  const r1 = bytesToNumberLE(nonce.secret);
  const k = bytesToNumberLE(challenge);
  const s1 = bytesToNumberLE(keyShareSecret);
  const z1 = mod(r1 + mod(k * s1));

  return {
    partialSig: numberToBytesLE(z1, 32),
    groupNonce,
    challenge,
  };
}

/**
 * Verify a partial signature from the other party.
 * Checks: z_i * G == R_i + k * A_i
 */
export function verifyPartialSig(
  partialSig: Uint8Array,
  theirCommitment: Uint8Array,
  theirPublicShare: Uint8Array,
  challenge: Uint8Array,
): boolean {
  const z = bytesToNumberLE(partialSig);
  const k = bytesToNumberLE(challenge);

  // Left: z * G
  const lhs = ExtendedPoint.BASE.multiply(z);

  // Right: R_i + k * A_i
  const ri = ExtendedPoint.fromHex(theirCommitment);
  const ai = ExtendedPoint.fromHex(theirPublicShare);
  const rhs = ri.add(ai.multiply(k));

  return lhs.equals(rhs);
}

/**
 * Aggregate two partial signatures into a final Ed25519 signature.
 * Result is 64 bytes: R (32) || z (32) — standard Ed25519 format.
 */
export function aggregateSignatures(
  groupNonce: Uint8Array,
  partialSig1: Uint8Array,
  partialSig2: Uint8Array,
): Uint8Array {
  const z1 = bytesToNumberLE(partialSig1);
  const z2 = bytesToNumberLE(partialSig2);
  const z = mod(z1 + z2);

  const signature = new Uint8Array(64);
  signature.set(groupNonce, 0);
  signature.set(numberToBytesLE(z, 32), 32);
  return signature;
}
