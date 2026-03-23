// High-level FROST threshold signing flows.
//
// Port of packages/cli-go/cmd/frost_sign.go
//
// Protocol:
//   Round 1: Exchange nonce commitments (R1 <-> R2)
//   Round 2: Compute partial signature z1 = r1 + k*s1, send to server
//   Server:  Aggregates z = z1+z2, assembles full Ed25519 sig, submits to Solana

import type { BotWallet } from '../sdk/index.js';
import { generateNonce, partialSign } from './core.js';
import { keyShareFromMnemonic, decodePoint } from './encoding.js';

/**
 * Perform the full FROST threshold signing flow for payments/withdrawals.
 * Loads the local key share, exchanges nonces with server, computes partial sig.
 *
 * @param sdk - BotWallet SDK client (authenticated)
 * @param mnemonic - 12-word mnemonic for the local key share (S1)
 * @param transactionId - The transaction being signed
 * @param messageBase64 - Base64-encoded Solana transaction message
 * @returns Server's response from frost_sign_complete (contains tx result)
 */
export async function frostSignAndSubmit(
  sdk: BotWallet,
  mnemonic: string,
  transactionId: string,
  messageBase64: string,
): Promise<Record<string, unknown>> {
  const messageBytes = base64ToBytes(messageBase64);
  const keyShare = keyShareFromMnemonic(mnemonic);

  // Round 1: Generate nonce, exchange commitments with server
  const nonce = generateNonce();
  const nonceCommitmentB64 = bytesToBase64(nonce.commitment);

  const signInitResult = await sdk.frostSignInit({
    transaction_id: transactionId,
    nonce_commitment: nonceCommitmentB64,
  });

  const { session_id, server_nonce_commitment, group_key } = signInitResult;
  if (!session_id || !server_nonce_commitment) {
    throw new Error('Server returned invalid signing session');
  }
  if (!group_key) {
    throw new Error('Server did not return group key for signing');
  }

  const serverNonceBytes = decodePoint(base64ToBytes(server_nonce_commitment));
  const groupKeyBytes = decodePoint(base64ToBytes(group_key));

  // Round 2: Compute partial signature z1 = r1 + k*s1
  const result = partialSign(
    messageBytes,
    keyShare.secret,
    nonce,
    serverNonceBytes,
    groupKeyBytes,
  );

  const partialSigB64 = bytesToBase64(result.partialSig);

  // Send partial sig to server for aggregation and on-chain submission
  const submitResult = await sdk.frostSignComplete({
    session_id,
    partial_sig: partialSigB64,
  });

  return submitResult as unknown as Record<string, unknown>;
}

/**
 * Perform FROST threshold signing for x402 payments.
 * Unlike frostSignAndSubmit, the server does NOT submit the tx to Solana.
 * Instead, it returns the signed transaction bytes for the X-Payment header.
 */
export async function frostSignForX402(
  sdk: BotWallet,
  mnemonic: string,
  transactionId: string,
  messageBase64: string,
): Promise<Record<string, unknown>> {
  const messageBytes = base64ToBytes(messageBase64);
  const keyShare = keyShareFromMnemonic(mnemonic);

  const nonce = generateNonce();
  const nonceCommitmentB64 = bytesToBase64(nonce.commitment);

  // Round 1: same as regular FROST
  const signInitResult = await sdk.frostSignInit({
    transaction_id: transactionId,
    nonce_commitment: nonceCommitmentB64,
  });

  const { session_id, server_nonce_commitment, group_key } = signInitResult;
  if (!session_id || !server_nonce_commitment || !group_key) {
    throw new Error('Server returned invalid signing session');
  }

  const serverNonceBytes = decodePoint(base64ToBytes(server_nonce_commitment));
  const groupKeyBytes = decodePoint(base64ToBytes(group_key));

  const result = partialSign(
    messageBytes,
    keyShare.secret,
    nonce,
    serverNonceBytes,
    groupKeyBytes,
  );

  // Round 2: x402_sign_complete returns signed tx, does NOT submit to Solana
  const signResult = await sdk.x402SignComplete({
    session_id,
    partial_sig: bytesToBase64(result.partialSig),
  });

  return signResult as unknown as Record<string, unknown>;
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
