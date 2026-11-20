// Encodings for values exchanged with the Botwallet API and written to the
// wallet files.

/**
 * Standard base64 (as the server writes it with btoa) to bytes. Throws on
 * anything that isn't valid base64, as atob does, instead of skipping the
 * characters it can't read.
 */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** A time in UTC with whole seconds, as Go's time.RFC3339 writes it (the CLI reads it back). */
export function rfc3339Seconds(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
