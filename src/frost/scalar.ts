// Ed25519 scalar arithmetic for FROST: numbers mod the group order l, stored
// as 32 little-endian bytes as Go's edwards25519.Scalar stores them.

import { ed25519 } from '@noble/curves/ed25519';

/** The Ed25519 group order l. */
export const ORDER = ed25519.CURVE.n;

export function mod(a: bigint, m: bigint = ORDER): bigint {
  const result = a % m;
  return result >= 0n ? result : result + m;
}

export function bytesToNumberLE(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) + BigInt(bytes[i]);
  }
  return result;
}

export function numberToBytesLE(n: bigint, len: number): Uint8Array {
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
export function reduceScalar64(bytes: Uint8Array): Uint8Array {
  if (bytes.length !== 64) throw new Error('reduceScalar64 requires 64 bytes');
  const n = bytesToNumberLE(bytes);
  return numberToBytesLE(mod(n), 32);
}
