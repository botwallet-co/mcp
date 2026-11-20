// FROST interop tests — deterministic vectors from the Go implementation.
//
// tests/fixtures/frost-vectors.json is written by the Agent CLI's tests
// (packages/cli-go: go test ./solana/frost -run TestInteropVector -update) and
// copied here unchanged; see its "about". Any mismatch means the TS
// implementation is incompatible with Go.

import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import {
  computeGroupKey,
  partialSign,
  computeChallenge,
  aggregateSignatures,
} from '../../../src/frost/core.js';
import { keyShareFromMnemonic, scalarFromEntropy } from '../../../src/frost/encoding.js';
import { bytesToNumberLE, mod, numberToBytesLE } from '../../../src/frost/scalar.js';
import { bytesToHex, hexToBytes } from '../../helpers/hex.js';
import vectors from '../../fixtures/frost-vectors.json' with { type: 'json' };

const { ExtendedPoint } = ed25519;
const { scalar_from_entropy: entropyVector, key_share_from_mnemonic: mnemonicVector, dkg, signing } = vectors;

describe('FROST interop with Go', () => {
  it('VECTOR 1: scalarFromEntropy produces identical output', () => {
    const scalar = scalarFromEntropy(hexToBytes(entropyVector.entropy));

    expect(bytesToHex(scalar)).toBe(entropyVector.scalar);

    // Derive public key from scalar
    const pub = ExtendedPoint.BASE.multiply(bytesToNumberLE(scalar)).toRawBytes();
    expect(bytesToHex(pub)).toBe(entropyVector.public);
  });

  it('VECTOR 1b: Key 1 from its 12 words is the key share Go derives', () => {
    const share = keyShareFromMnemonic(mnemonicVector.mnemonic);
    expect(bytesToHex(share.secret)).toBe(mnemonicVector.scalar);
    expect(bytesToHex(share.public)).toBe(mnemonicVector.public);
  });

  it('VECTOR 2: DKG group key computation', () => {
    expect(bytesToHex(scalarFromEntropy(hexToBytes(dkg.bot_entropy)))).toBe(dkg.bot_scalar);
    expect(bytesToHex(scalarFromEntropy(hexToBytes(dkg.server_entropy)))).toBe(dkg.server_scalar);

    const groupKey = computeGroupKey(hexToBytes(dkg.bot_public), hexToBytes(dkg.server_public));
    expect(bytesToHex(groupKey)).toBe(dkg.group_key);
  });

  it('VECTOR 3: Challenge computation', () => {
    const challenge = computeChallenge(
      hexToBytes(signing.group_nonce),
      hexToBytes(dkg.group_key),
      hexToBytes(signing.message),
    );
    expect(bytesToHex(challenge)).toBe(signing.challenge);
  });

  it('VECTOR 4: Signature aggregation', () => {
    const finalSig = aggregateSignatures(
      hexToBytes(signing.group_nonce),
      hexToBytes(signing.bot_partial_sig),
      hexToBytes(signing.server_partial_sig),
    );
    expect(bytesToHex(finalSig)).toBe(signing.signature);
  });

  it('VECTOR 5: Final signature is a valid Ed25519 signature', () => {
    const valid = ed25519.verify(
      hexToBytes(signing.signature),
      hexToBytes(signing.message),
      hexToBytes(dkg.group_key),
    );
    expect(valid).toBe(true);
  });

  it('VECTOR 6: partialSign produces correct output with known nonce', () => {
    // Go reduces 64 uniform bytes to the bot's nonce secret r1 (SetUniformBytes)
    const r1 = mod(bytesToNumberLE(hexToBytes(signing.bot_nonce_bytes)));

    // Verify: r1 * G should equal the bot's nonce commitment
    const r1Point = ExtendedPoint.BASE.multiply(r1).toRawBytes();
    expect(bytesToHex(r1Point)).toBe(signing.bot_nonce_commitment);

    const result = partialSign(
      hexToBytes(signing.message),
      hexToBytes(dkg.bot_scalar),
      {
        secret: numberToBytesLE(r1, 32),
        commitment: hexToBytes(signing.bot_nonce_commitment),
      },
      hexToBytes(signing.server_nonce_commitment),
      hexToBytes(dkg.group_key),
    );

    expect(bytesToHex(result.partialSig)).toBe(signing.bot_partial_sig);
    expect(bytesToHex(result.groupNonce)).toBe(signing.group_nonce);
    expect(bytesToHex(result.challenge)).toBe(signing.challenge);
  });
});
