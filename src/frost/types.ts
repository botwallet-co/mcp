// FROST 2-of-2 threshold signature types for Ed25519.
//
// SECURITY NOTE:
//   - Fields named "secret" hold SECRET material — NEVER log, serialize, or transmit.
//   - Fields named "public" / "commitment" hold PUBLIC material — safe to share.

export interface KeyShare {
  /** 32-byte key share scalar (SECRET — never leaves local memory) */
  secret: Uint8Array;
  /** 32-byte compressed Ed25519 point (safe to share) */
  public: Uint8Array;
}

export interface SigningNonce {
  /** 32-byte ephemeral nonce scalar (use once, then discard) */
  secret: Uint8Array;
  /** 32-byte nonce commitment point (safe to send) */
  commitment: Uint8Array;
}

export interface PartialSignResult {
  /** 32-byte partial signature scalar (safe to send to server) */
  partialSig: Uint8Array;
  /** 32-byte combined nonce point R = R1 + R2 */
  groupNonce: Uint8Array;
  /** 32-byte challenge scalar k = H(R || A || M) */
  challenge: Uint8Array;
}
