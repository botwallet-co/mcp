import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  writeBwlt,
  readBwlt,
  encryptPayload,
  decryptPayload,
} from '../../../src/config/bwlt.js';

function tmpFile(suffix: string): string {
  return path.join(os.tmpdir(), `bwlt-test-${Date.now()}-${suffix}`);
}

const files: string[] = [];
afterEach(() => {
  for (const f of files) {
    try { fs.unlinkSync(f); } catch {}
  }
  files.length = 0;
});

describe('AES-256-GCM encrypt/decrypt', () => {
  it('round-trip', () => {
    const key = new Uint8Array(32);
    key.fill(0xAB);
    const plaintext = new TextEncoder().encode('hello FROST world');

    const { nonce, ciphertext } = encryptPayload(key, plaintext);
    expect(nonce).toHaveLength(12);
    expect(ciphertext.length).toBeGreaterThan(plaintext.length); // includes auth tag

    const decrypted = decryptPayload(key, nonce, ciphertext);
    expect(new TextDecoder().decode(decrypted)).toBe('hello FROST world');
  });

  it('wrong key fails', () => {
    const key1 = new Uint8Array(32).fill(0xAA);
    const key2 = new Uint8Array(32).fill(0xBB);
    const { nonce, ciphertext } = encryptPayload(key1, new Uint8Array([1, 2, 3]));

    expect(() => decryptPayload(key2, nonce, ciphertext)).toThrow();
  });

  it('rejects wrong key length', () => {
    expect(() => encryptPayload(new Uint8Array(16), new Uint8Array(1))).toThrow('32 bytes');
    expect(() => decryptPayload(new Uint8Array(16), new Uint8Array(12), new Uint8Array(32))).toThrow('32 bytes');
  });
});

describe('.bwlt file format', () => {
  it('write and read round-trip', () => {
    const fp = tmpFile('roundtrip.bwlt');
    files.push(fp);

    const exportId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const nonce = new Uint8Array(12).fill(0x42);
    const ciphertext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);

    writeBwlt(fp, exportId, nonce, ciphertext);
    const result = readBwlt(fp);

    expect(result.exportId).toBe(exportId);
    expect(Buffer.from(result.nonce).toString('hex')).toBe(Buffer.from(nonce).toString('hex'));
    expect(Buffer.from(result.ciphertext).toString('hex')).toBe(Buffer.from(ciphertext).toString('hex'));
  });

  it('full encrypt-write-read-decrypt cycle', () => {
    const fp = tmpFile('fullcycle.bwlt');
    files.push(fp);

    const key = new Uint8Array(32);
    key.fill(0xCD);
    const payload = JSON.stringify({ wallet_name: 'test-bot', seed: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' });
    const { nonce, ciphertext } = encryptPayload(key, new TextEncoder().encode(payload));

    const exportId = '12345678-1234-1234-1234-123456789012';
    writeBwlt(fp, exportId, nonce, ciphertext);

    const read = readBwlt(fp);
    expect(read.exportId).toBe(exportId);

    const decrypted = decryptPayload(key, read.nonce, read.ciphertext);
    expect(JSON.parse(new TextDecoder().decode(decrypted))).toEqual(JSON.parse(payload));
  });

  it('rejects wrong export ID length', () => {
    expect(() => writeBwlt('x', 'too-short', new Uint8Array(12), new Uint8Array(20))).toThrow('36 characters');
  });

  it('rejects wrong nonce length', () => {
    expect(() => writeBwlt('x', '12345678-1234-1234-1234-123456789012', new Uint8Array(8), new Uint8Array(20))).toThrow('12 bytes');
  });

  it('readBwlt rejects non-BWLT file', () => {
    const fp = tmpFile('notbwlt');
    files.push(fp);
    // Write data longer than MIN_FILE_SIZE (72 bytes) to trigger magic check, not size check
    const buf = Buffer.alloc(80);
    buf.write('NOT_BWLT_HEADER_with_enough_padding_to_pass_min_size_check_1234567890abcdefghijklmnop');
    fs.writeFileSync(fp, buf);

    expect(() => readBwlt(fp)).toThrow('invalid magic');
  });

  it('readBwlt rejects too-small file', () => {
    const fp = tmpFile('tiny');
    files.push(fp);
    fs.writeFileSync(fp, 'BWLT');

    expect(() => readBwlt(fp)).toThrow('too small');
  });
});
