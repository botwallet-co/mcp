// High-level FROST threshold signing flows.
//
// Port of packages/cli-go/cmd/frost_sign.go
//
// Protocol:
//   Round 1: Exchange nonce commitments (R1 <-> R2)
//   Round 2: Compute partial signature z1 = r1 + k*s1, send to server
//   Server:  Aggregates z = z1+z2, assembles full Ed25519 sig, submits to Solana
//
// Before the partial signature is computed, Key 1 checks what it signs: the
// group key must be this wallet's address, and the message must move only
// what the agent agreed to (solana/verify-transaction.ts). On any mismatch
// nothing is signed.

import { BotWalletError, hasCode, type BotWallet } from '../sdk/index.js';
import { base64ToBytes, bytesToBase64 } from '../utils/bytes.js';
import { generateNonce, partialSign } from './core.js';
import { keyShareFromMnemonic, decodePoint } from './encoding.js';
import { bytesEqual, decodeAddress, encodeAddress } from '../solana/message.js';
import {
  TransactionCheckError,
  verifyTransferMessage,
  type ExpectedTransfer,
} from '../solana/verify-transaction.js';

/** What Key 1 may sign for one transaction. */
export interface SigningCheck {
  /**
   * The wallet's address from config.json. When set, the server's group key
   * must be this address. Without one (env-only setups) the message is
   * checked against the group key itself.
   */
  walletAddress?: string;
  /** What the agent agreed to send. */
  transfer: ExpectedTransfer;
}

/**
 * The partial signature reached the server, but no clear answer came back.
 * The transaction may have been sent to Solana.
 */
export class SubmitOutcomeUnknownError extends Error {
  /**
   * The server answered TRANSACTION_FAILED and marked the transfer failed,
   * but the transaction may still have been sent, so that status can't be
   * relied on.
   */
  readonly markedFailed: boolean;

  constructor(cause: unknown, markedFailed = false) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'SubmitOutcomeUnknownError';
    this.markedFailed = markedFailed;
  }
}

// Answers from frost_sign_complete that mean nothing was sent to Solana: the
// server turned the request or the partial signature down before submitting.
// Any other failure (timeouts, lost connections, server errors) may come
// after the transaction was sent.
const NOT_SUBMITTED_CODES = new Set<string>([
  'UNAUTHORIZED',
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'SESSION_EXPIRED',
  'INVALID_TRANSACTION_TYPE',
  'MISSING_PUBLIC_SHARE',
  'INVALID_PARTIAL_SIG',
  // The owner froze the wallet: the call is turned away before it starts
  'WALLET_SUSPENDED',
]);

// Answers from frost_sign_complete that say what became of a transaction that
// was sent: SUBMISSION_UNCONFIRMED (sent to Solana and not confirmed yet, so
// it may still go through) and ALREADY_COMPLETED (sent and confirmed). They
// are passed on as they are, for the caller to report.
const SENT_CODES = new Set<string>(['SUBMISSION_UNCONFIRMED', 'ALREADY_COMPLETED']);

// TRANSACTION_FAILED means nothing was sent only when Solana turned the
// transaction down before taking it (preflight simulation or signature
// checks), or the server says no money moved. Older servers also answer
// TRANSACTION_FAILED, and mark the transfer failed, when the request to Solana
// broke off or its reply was unreadable; such a transaction can still land.
const REJECTED_BEFORE_SENDING = /simulation failed|signature verification fail|no money moved/i;
const ALREADY_LANDED = /already been processed/i;

function rejectedBeforeSending(error: BotWalletError): boolean {
  const said = `${error.message} ${error.howToFix ?? ''}`;
  return REJECTED_BEFORE_SENDING.test(said) && !ALREADY_LANDED.test(said);
}

interface PartialSignature {
  sessionId: string;
  partialSigB64: string;
}

/**
 * FROST round 1 with the server, the checks, and this wallet's partial
 * signature over the message. Nothing is sent to Solana here.
 */
async function checkedPartialSign(
  sdk: BotWallet,
  mnemonic: string,
  transactionId: string,
  messageBase64: string,
  check: SigningCheck,
): Promise<PartialSignature> {
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

  // Only sign for this wallet's own address
  if (check.walletAddress !== undefined) {
    const local = decodeAddress(check.walletAddress);
    if (!local || !bytesEqual(local, groupKeyBytes)) {
      throw new TransactionCheckError(
        `the server asked to sign for wallet address ${encodeAddress(groupKeyBytes)}, ` +
        `but Key 1 here belongs to ${check.walletAddress}`,
        'WALLET_MISMATCH',
      );
    }
  }

  // The server signs the message it stored at confirm time. If that isn't the
  // one checked here, the signatures can't match; stop before signing.
  const storedMessage = signInitResult.message_to_sign;
  if (typeof storedMessage === 'string' && !bytesEqual(base64ToBytes(storedMessage), messageBytes)) {
    throw new TransactionCheckError('the transaction to sign changed after it was prepared');
  }

  // Only sign the transfer the agent agreed to
  verifyTransferMessage(messageBytes, groupKeyBytes, check.transfer);

  // Round 2: Compute partial signature z1 = r1 + k*s1
  const result = partialSign(
    messageBytes,
    keyShare.secret,
    nonce,
    serverNonceBytes,
    groupKeyBytes,
  );

  return { sessionId: session_id, partialSigB64: bytesToBase64(result.partialSig) };
}

/**
 * Perform the full FROST threshold signing flow for payments/withdrawals.
 * Loads the local key share, exchanges nonces with server, checks the
 * transaction, computes the partial sig and sends it for submission.
 *
 * Throws TransactionCheckError when Key 1 refuses to sign,
 * SubmitOutcomeUnknownError when the transaction may have been sent but the
 * result is not known, and a BotWalletError with a code in SENT_CODES when the
 * server says it was sent (confirmed or not yet). Any other error means
 * nothing was sent.
 *
 * @param sdk - BotWallet SDK client (authenticated)
 * @param mnemonic - 12-word mnemonic for the local key share (S1)
 * @param transactionId - The transaction being signed
 * @param messageBase64 - Base64-encoded Solana transaction message
 * @param check - What Key 1 may sign for this transaction
 * @returns Server's response from frost_sign_complete (contains tx result)
 */
export async function frostSignAndSubmit(
  sdk: BotWallet,
  mnemonic: string,
  transactionId: string,
  messageBase64: string,
  check: SigningCheck,
): Promise<Record<string, unknown>> {
  const { sessionId, partialSigB64 } = await checkedPartialSign(sdk, mnemonic, transactionId, messageBase64, check);

  // Send partial sig to server for aggregation and on-chain submission
  try {
    const submitResult = await sdk.frostSignComplete({
      session_id: sessionId,
      partial_sig: partialSigB64,
    });
    return submitResult;
  } catch (e) {
    if (e instanceof BotWalletError && (NOT_SUBMITTED_CODES.has(e.code) || SENT_CODES.has(e.code))) throw e;
    if (hasCode(e, 'TRANSACTION_FAILED')) {
      if (rejectedBeforeSending(e)) throw e;
      throw new SubmitOutcomeUnknownError(e, true);
    }
    throw new SubmitOutcomeUnknownError(e);
  }
}

/**
 * Perform FROST threshold signing for x402 payments.
 * Unlike frostSignAndSubmit, the server does NOT submit the tx to Solana.
 * Instead, it returns the signed transaction bytes for the X-Payment header,
 * so a failure here never means money moved.
 */
export async function frostSignForX402(
  sdk: BotWallet,
  mnemonic: string,
  transactionId: string,
  messageBase64: string,
  check: SigningCheck,
): Promise<Record<string, unknown>> {
  const { sessionId, partialSigB64 } = await checkedPartialSign(sdk, mnemonic, transactionId, messageBase64, check);

  // Round 2: x402_sign_complete returns signed tx, does NOT submit to Solana
  const signResult = await sdk.x402SignComplete({
    session_id: sessionId,
    partial_sig: partialSigB64,
  });

  return signResult;
}
