import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import {
  generateShareMnemonic,
  scalarFromEntropy,
  scalarFromMnemonic,
  keyShareFromMnemonic,
  encodePoint,
  decodePoint,
} from '../../../src/frost/encoding.js';

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

describe('FROST encoding', () => {
  it('generateShareMnemonic produces 12 words', () => {
    const mnemonic = generateShareMnemonic();
    const words = mnemonic.split(' ');
    expect(words).toHaveLength(12);
  });

  it('generateShareMnemonic is unique each call', () => {
    const m1 = generateShareMnemonic();
    const m2 = generateShareMnemonic();
    expect(m1).not.toBe(m2);
  });

  it('scalarFromEntropy is deterministic', () => {
    const entropy = hexToBytes('000102030405060708090a0b0c0d0e0f');
    const s1 = scalarFromEntropy(entropy);
    const s2 = scalarFromEntropy(entropy);

    expect(Buffer.from(s1).toString('hex')).toBe(Buffer.from(s2).toString('hex'));
  });

  it('scalarFromEntropy rejects short input', () => {
    expect(() => scalarFromEntropy(new Uint8Array(8))).toThrow('too short');
  });

  it('mnemonic round-trip: same mnemonic -> same scalar', () => {
    const mnemonic = generateShareMnemonic();
    const s1 = scalarFromMnemonic(mnemonic);
    const s2 = scalarFromMnemonic(mnemonic);

    expect(Buffer.from(s1).toString('hex')).toBe(Buffer.from(s2).toString('hex'));
  });

  it('keyShareFromMnemonic produces valid key pair', () => {
    const mnemonic = generateShareMnemonic();
    const share = keyShareFromMnemonic(mnemonic);

    expect(share.secret).toHaveLength(32);
    expect(share.public).toHaveLength(32);

    // Public should be on the curve
    expect(() => ed25519.ExtendedPoint.fromHex(share.public)).not.toThrow();
  });

  it('scalarFromMnemonic rejects invalid mnemonic', () => {
    expect(() => scalarFromMnemonic('invalid words that are not a mnemonic')).toThrow();
  });

  it('encodePoint/decodePoint round-trip', () => {
    const share = keyShareFromMnemonic(generateShareMnemonic());
    const encoded = encodePoint(share.public);
    const decoded = decodePoint(encoded);

    expect(Buffer.from(decoded).toString('hex'))
      .toBe(Buffer.from(share.public).toString('hex'));
  });

  it('decodePoint rejects wrong length', () => {
    expect(() => decodePoint(new Uint8Array(16))).toThrow('32 bytes');
  });

  it('decodePoint rejects invalid point', () => {
    // High byte > 0x80 with invalid y coordinate — not on the curve
    const invalid = new Uint8Array(32).fill(0xFF);
    invalid[31] = 0xFF;
    expect(() => decodePoint(invalid)).toThrow();
  });
});
