import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import {
  generateKeyShare,
  computeGroupKey,
  generateNonce,
  partialSign,
  verifyPartialSig,
  aggregateSignatures,
  computeChallenge,
} from '../../../src/frost/core.js';

describe('FROST core', () => {
  it('generateKeyShare produces valid key pair', () => {
    const share = generateKeyShare();

    expect(share.secret).toHaveLength(32);
    expect(share.public).toHaveLength(32);
    // Public key should be a valid Ed25519 point
    expect(() => ed25519.ExtendedPoint.fromHex(share.public)).not.toThrow();
  });

  it('generateKeyShare produces unique shares', () => {
    const s1 = generateKeyShare();
    const s2 = generateKeyShare();

    expect(Buffer.from(s1.secret).toString('hex'))
      .not.toBe(Buffer.from(s2.secret).toString('hex'));
  });

  it('computeGroupKey combines two public keys', () => {
    const s1 = generateKeyShare();
    const s2 = generateKeyShare();

    const groupKey = computeGroupKey(s1.public, s2.public);
    expect(groupKey).toHaveLength(32);

    // Should be a valid point
    expect(() => ed25519.ExtendedPoint.fromHex(groupKey)).not.toThrow();

    // Order doesn't matter
    const groupKey2 = computeGroupKey(s2.public, s1.public);
    expect(Buffer.from(groupKey).toString('hex'))
      .toBe(Buffer.from(groupKey2).toString('hex'));
  });

  it('generateNonce produces valid nonce', () => {
    const nonce = generateNonce();

    expect(nonce.secret).toHaveLength(32);
    expect(nonce.commitment).toHaveLength(32);
    expect(() => ed25519.ExtendedPoint.fromHex(nonce.commitment)).not.toThrow();
  });

  it('generateNonce produces unique nonces', () => {
    const n1 = generateNonce();
    const n2 = generateNonce();

    expect(Buffer.from(n1.secret).toString('hex'))
      .not.toBe(Buffer.from(n2.secret).toString('hex'));
  });

  it('full DKG + sign + verify cycle', () => {
    // Simulate full FROST 2-of-2 protocol

    // DKG: each party generates a key share
    const bot = generateKeyShare();
    const server = generateKeyShare();
    const groupKey = computeGroupKey(bot.public, server.public);

    // Message to sign
    const message = new TextEncoder().encode('test payment for FROST');

    // Round 1: generate nonces
    const botNonce = generateNonce();
    const serverNonce = generateNonce();

    // Round 2: compute partial signatures
    const botResult = partialSign(
      message, bot.secret, botNonce, serverNonce.commitment, groupKey,
    );
    const serverResult = partialSign(
      message, server.secret, serverNonce, botNonce.commitment, groupKey,
    );

    // Group nonce should be the same on both sides
    expect(Buffer.from(botResult.groupNonce).toString('hex'))
      .toBe(Buffer.from(serverResult.groupNonce).toString('hex'));

    // Challenge should be the same on both sides
    expect(Buffer.from(botResult.challenge).toString('hex'))
      .toBe(Buffer.from(serverResult.challenge).toString('hex'));

    // Verify partial signatures
    expect(
      verifyPartialSig(botResult.partialSig, botNonce.commitment, bot.public, botResult.challenge),
    ).toBe(true);
    expect(
      verifyPartialSig(serverResult.partialSig, serverNonce.commitment, server.public, serverResult.challenge),
    ).toBe(true);

    // Aggregate
    const signature = aggregateSignatures(
      botResult.groupNonce,
      botResult.partialSig,
      serverResult.partialSig,
    );
    expect(signature).toHaveLength(64);

    // Verify the final Ed25519 signature
    expect(ed25519.verify(signature, message, groupKey)).toBe(true);
  });

  it('multiple signatures with same keys', () => {
    const bot = generateKeyShare();
    const server = generateKeyShare();
    const groupKey = computeGroupKey(bot.public, server.public);

    for (let i = 0; i < 3; i++) {
      const message = new TextEncoder().encode(`message ${i}`);

      // CRITICAL: fresh nonces every time
      const botNonce = generateNonce();
      const serverNonce = generateNonce();

      const botResult = partialSign(
        message, bot.secret, botNonce, serverNonce.commitment, groupKey,
      );
      const serverResult = partialSign(
        message, server.secret, serverNonce, botNonce.commitment, groupKey,
      );

      const signature = aggregateSignatures(
        botResult.groupNonce,
        botResult.partialSig,
        serverResult.partialSig,
      );

      expect(ed25519.verify(signature, message, groupKey)).toBe(true);
    }
  });

  it('partialSign rejects empty message', () => {
    const bot = generateKeyShare();
    const nonce = generateNonce();
    const serverNonce = generateNonce();
    const groupKey = computeGroupKey(bot.public, generateKeyShare().public);

    expect(() =>
      partialSign(new Uint8Array(0), bot.secret, nonce, serverNonce.commitment, groupKey),
    ).toThrow('message cannot be empty');
  });
});
