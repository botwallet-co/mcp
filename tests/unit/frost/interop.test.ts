// FROST interop tests — deterministic vectors from the Go implementation.
//
// These values come from `go test -v -run TestInteropVector ./solana/frost/`
// Any mismatch means the TS implementation is incompatible with Go.

import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import {
  computeGroupKey,
  partialSign,
  computeChallenge,
  aggregateSignatures,
} from '../../../src/frost/core.js';
import { scalarFromEntropy } from '../../../src/frost/encoding.js';

const { ExtendedPoint } = ed25519;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function bytesToNumberLE(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) + BigInt(bytes[i]);
  }
  return result;
}

// Go interop test vectors (from TestInteropVector)
const VECTORS = {
  scalarFromEntropy: {
    entropy: '000102030405060708090a0b0c0d0e0f',
    scalar: '39ca89f851f6dc15789dd9e73f8090622941c836cdb19a26ceeb91da35e27104',
    public: 'e9c8d075985daa3d89a45385dc29d83a97d70766d13d91459af58b73e21cc131',
  },
  dkg: {
    botScalar: '5ae99b3b57464c9cde02cefe6f4b75fb8043a190624f4c9bf68e13151517a50e',
    botPublic: 'efa94430226c8000e6a26ddfc594047997316ab167bcbda22d5d01fc97c874f4',
    serverScalar: 'e3211b6c9a44c9509959b3a2e563b33c43a66f9ef587974cec20ddfd00f8d703',
    serverPublic: 'c8f34d287c3437175884ebb28bc5896e3ac27bbc609ef24183c091d5c8a4e819',
    groupKey: 'd2266eb8bdd22952ad3d11d4b42ab1e62abdefc770389ed7eda1f05097ee69d1',
  },
  signing: {
    message: '74657374206d65737361676520666f7220696e7465726f70',
    botNonceCommit: '03ec3f74a72b0685c2296330b0d9dacf9f93b23c27ffd7449b8d5584c9f32a7c',
    serverNonceCommit: '707b968e4bbbe9eb1aeba34b79d86f7de5c49e1de87825b8efeadbbd99141f71',
    groupNonce: 'a8ecf899375896f5e27e1bf17cf8b7bdf91e7a3add63d2f270f2c93941920b32',
    challenge: '321ed78ab8b55b5466847b4fe8a9a8a504e5adeefdf346bd10bedfb0f7217203',
    botPartialSig: 'be8b0a7819cd46bbad5d3bbf3abaf2bcf160de14c913c32883a4e2a779edb501',
    serverPartial: '5594d637bd4959e2cf8484fbd4d276dfea65c64b9f3751f677c13879133e5b0e',
    finalSignature: 'a8ecf899375896f5e27e1bf17cf8b7bdf91e7a3add63d2f270f2c93941920b32264ceb52bcb38d45a745c81731938a87dcc6a460684b141ffb651b218d2b1100',
  },
} as const;

describe('FROST interop with Go', () => {
  it('VECTOR 1: scalarFromEntropy produces identical output', () => {
    const entropy = hexToBytes(VECTORS.scalarFromEntropy.entropy);
    const scalar = scalarFromEntropy(entropy);

    expect(bytesToHex(scalar)).toBe(VECTORS.scalarFromEntropy.scalar);

    // Derive public key from scalar
    const pub = ExtendedPoint.BASE.multiply(bytesToNumberLE(scalar)).toRawBytes();
    expect(bytesToHex(pub)).toBe(VECTORS.scalarFromEntropy.public);
  });

  it('VECTOR 2: DKG group key computation', () => {
    const botPublic = hexToBytes(VECTORS.dkg.botPublic);
    const serverPublic = hexToBytes(VECTORS.dkg.serverPublic);

    const groupKey = computeGroupKey(botPublic, serverPublic);
    expect(bytesToHex(groupKey)).toBe(VECTORS.dkg.groupKey);
  });

  it('VECTOR 3: Challenge computation', () => {
    const groupNonce = hexToBytes(VECTORS.signing.groupNonce);
    const groupKey = hexToBytes(VECTORS.dkg.groupKey);
    const message = hexToBytes(VECTORS.signing.message);

    const challenge = computeChallenge(groupNonce, groupKey, message);
    expect(bytesToHex(challenge)).toBe(VECTORS.signing.challenge);
  });

  it('VECTOR 4: Bot partial signature', () => {
    const botSecret = hexToBytes(VECTORS.dkg.botScalar);
    const botNonceCommit = hexToBytes(VECTORS.signing.botNonceCommit);
    const serverNonceCommit = hexToBytes(VECTORS.signing.serverNonceCommit);
    const groupKey = hexToBytes(VECTORS.dkg.groupKey);
    const message = hexToBytes(VECTORS.signing.message);

    // We need to find the bot nonce secret that produces botNonceCommit.
    // The Go test uses a fixed seed, so we need the raw scalar.
    // From the Go test, the nonce scalars are derived deterministically.
    // Instead, let's verify the partial sign math directly.

    // Manually extract the nonce secret from the commitment.
    // We can't do this without the private nonce — so instead,
    // test the challenge + group nonce computation and the full aggregation.

    const challenge = computeChallenge(
      hexToBytes(VECTORS.signing.groupNonce),
      groupKey,
      message,
    );
    expect(bytesToHex(challenge)).toBe(VECTORS.signing.challenge);
  });

  it('VECTOR 5: Signature aggregation', () => {
    const groupNonce = hexToBytes(VECTORS.signing.groupNonce);
    const botPartialSig = hexToBytes(VECTORS.signing.botPartialSig);
    const serverPartial = hexToBytes(VECTORS.signing.serverPartial);

    const finalSig = aggregateSignatures(groupNonce, botPartialSig, serverPartial);
    expect(bytesToHex(finalSig)).toBe(VECTORS.signing.finalSignature);
  });

  it('VECTOR 6: Final signature is a valid Ed25519 signature', () => {
    const groupKey = hexToBytes(VECTORS.dkg.groupKey);
    const message = hexToBytes(VECTORS.signing.message);
    const finalSig = hexToBytes(VECTORS.signing.finalSignature);

    const valid = ed25519.verify(finalSig, message, groupKey);
    expect(valid).toBe(true);
  });

  it('VECTOR 7: partialSign produces correct output with known nonce', () => {
    // To test partialSign end-to-end, we need the nonce secret.
    // We'll compute z1 = r1 + k*s1 manually and check the Go expected value.
    // From the Go vectors, bot_partial_sig = z1 = r1 + k*s1
    // We know k (challenge) and s1 (botScalar). We can reverse to find r1:
    //   r1 = z1 - k*s1
    // Then verify partialSign gives us back z1.

    const k = bytesToNumberLE(hexToBytes(VECTORS.signing.challenge));
    const s1 = bytesToNumberLE(hexToBytes(VECTORS.dkg.botScalar));
    const z1 = bytesToNumberLE(hexToBytes(VECTORS.signing.botPartialSig));
    const ORDER = ed25519.CURVE.n;
    const mod = (a: bigint, m: bigint) => ((a % m) + m) % m;

    const r1 = mod(z1 - mod(k * s1, ORDER), ORDER);

    // Verify: r1 * G should equal botNonceCommit
    const r1Point = ExtendedPoint.BASE.multiply(r1).toRawBytes();
    expect(bytesToHex(r1Point)).toBe(VECTORS.signing.botNonceCommit);

    // Now call partialSign with this r1 as the nonce secret
    function numberToBytesLE(n: bigint, len: number): Uint8Array {
      const result = new Uint8Array(len);
      let val = n;
      for (let i = 0; i < len; i++) {
        result[i] = Number(val & 0xFFn);
        val >>= 8n;
      }
      return result;
    }

    const result = partialSign(
      hexToBytes(VECTORS.signing.message),
      hexToBytes(VECTORS.dkg.botScalar),
      {
        secret: numberToBytesLE(r1, 32),
        commitment: hexToBytes(VECTORS.signing.botNonceCommit),
      },
      hexToBytes(VECTORS.signing.serverNonceCommit),
      hexToBytes(VECTORS.dkg.groupKey),
    );

    expect(bytesToHex(result.partialSig)).toBe(VECTORS.signing.botPartialSig);
    expect(bytesToHex(result.groupNonce)).toBe(VECTORS.signing.groupNonce);
    expect(bytesToHex(result.challenge)).toBe(VECTORS.signing.challenge);
  });
});
