// Finishing a payment or withdrawal: the server builds the transaction, Key 1
// checks and co-signs it, and the server submits it to Solana. Shared by
// botwallet_pay, botwallet_confirm_payment, botwallet_withdraw and
// botwallet_confirm_withdrawal.
//
// Every failure says whether money may have moved:
//   - Until Key 1's partial signature reaches the server, nothing was sent.
//   - After that, a lost or unclear answer means the transfer may have gone
//     through, so the agent is told to check its status, not to pay again.
// A transfer the server sent that Solana hasn't confirmed yet
// (SUBMISSION_UNCONFIRMED) is not a failure: it is reported as pending, with
// its Solana signature and the tool that shows how it ends.

import type { ToolContext, ToolResult } from '../types.js';
import {
  BotWalletError,
  hasCode,
  isAlreadyCompleted,
  isFrozenWallet,
  isListedAsFailed,
  isNoAnswer,
  isOwnerSigning,
  isPendingStatusError,
  isSentUnconfirmed,
  type BotWallet,
} from '../sdk/index.js';
import { formatResult } from '../utils/tool-result.js';
import { noSeedError } from '../utils/errors.js';
import { frostSignAndSubmit, SubmitOutcomeUnknownError, type SigningCheck } from '../frost/index.js';
import { TransactionCheckError, type TransferKind } from '../solana/index.js';
import { loadSeed } from '../config/index.js';
import {
  alreadySigningError,
  notSentError,
  outcomeUnknownError,
  signingRefusedError,
  transferError,
  unreadableConfigError,
  type TransferRef,
} from './results.js';
import { agreedTransferFor, forgetAgreedTransfer } from './agreed-transfers.js';
import { expectedTransfer, localWalletAddress } from './signing-check.js';
import { withSigningLock, SigningInProgressError } from './signing-lock.js';

export interface TransferFlow {
  kind: Exclude<TransferKind, 'x402'>;
  noun: string;
  /** confirm_payment / confirm_withdrawal: builds the transaction to sign. */
  confirm(sdk: BotWallet, id: string): Promise<Record<string, unknown>>;
  /** The tool that finishes this transfer later. */
  confirmTool: string;
  /** The tool that starts a new one (which must not be used to retry). */
  startTool: string;
  /** The tool and arguments that show this transfer's status. */
  checkTool: string;
  checkArgs(id: string): Record<string, string>;
  /** The result after the server submitted the transfer. */
  done(result: Record<string, unknown>, ref: TransferRef, extra: Record<string, unknown>): Record<string, unknown>;
  /** The result when the server says this transfer was completed earlier. */
  alreadyDone(ref: TransferRef): Record<string, unknown>;
}

export const PAYMENT_FLOW: TransferFlow = {
  kind: 'payment',
  noun: 'payment',
  confirm: (sdk, id) => sdk.confirmPayment({ transaction_id: id }),
  confirmTool: 'botwallet_confirm_payment',
  startTool: 'botwallet_pay',
  checkTool: 'botwallet_list_payments',
  checkArgs: id => ({ transaction_id: id }),
  done: (result, ref, extra) => ({ paid: true, ...extra, ...result, ...ref }),
  alreadyDone: ref => ({
    paid: true,
    already_completed: true,
    ...ref,
    message: 'This payment was completed earlier. Nothing new was sent.',
  }),
};

export const WITHDRAWAL_FLOW: TransferFlow = {
  kind: 'withdrawal',
  noun: 'withdrawal',
  confirm: (sdk, id) => sdk.confirmWithdrawal({ withdrawal_id: id }),
  confirmTool: 'botwallet_confirm_withdrawal',
  startTool: 'botwallet_withdraw',
  checkTool: 'botwallet_get_withdrawal',
  checkArgs: id => ({ withdrawal_id: id }),
  done: (result, ref, extra) => {
    const { paid: _paid, ...rest } = result;
    return { withdrawn: true, ...extra, ...rest, ...ref };
  },
  alreadyDone: ref => ({
    withdrawn: true,
    already_completed: true,
    ...ref,
    message: 'This withdrawal was completed earlier. Nothing new was sent.',
  }),
};

/**
 * The server sent this transfer to Solana and Solana hasn't confirmed it yet.
 * It may still go through, so this is not an error: the agent must not send
 * it again, and checks its status in a minute, when it shows completed or
 * failed.
 */
function sentUnconfirmed(flow: TransferFlow, id: string, ref: TransferRef, error: BotWalletError): ToolResult {
  const details = error.details ?? {};
  const text = (key: string) => (typeof details[key] === 'string' && details[key] ? details[key] as string : undefined);
  return formatResult({
    status: 'pending',
    sent: true,
    ...ref,
    solana_signature: text('solana_signature'),
    explorer_url: text('explorer_url'),
    message: error.message ||
      `This ${flow.noun} was sent to Solana but is not confirmed yet, so it may still go through.`,
    next_step: `Do not call ${flow.startTool} again for it. In about a minute, check ${flow.checkTool}: ` +
      '"completed" means it went through, "failed" means it did not and no money moved.',
    check_tool: flow.checkTool,
    check_args: flow.checkArgs(id),
  });
}

/**
 * The server turns a frozen wallet's confirm and signing calls away before
 * anything changes, so confirming the same transfer finishes it once the
 * owner unfreezes the wallet.
 */
function frozenWalletError(flow: TransferFlow, error: unknown, ref: TransferRef): ToolResult {
  return notSentError(error, ref,
    `Nothing was sent. Ask your owner to unfreeze this wallet in the Botwallet dashboard, then call ${flow.confirmTool} ` +
    `with this transaction_id to finish the ${flow.noun}. Do not call ${flow.startTool} again for it.`);
}

/** A transfer the owner started on the signing page: only the owner finishes it, there. */
function ownerSigningError(flow: TransferFlow, id: string, error: unknown, ref: TransferRef): ToolResult {
  return transferError(error, ref,
    `Leave it to your owner: they started this ${flow.noun} on the signing page and finish it there. Do not confirm ` +
    `or cancel it, and do not call ${flow.startTool} for it. To see where it stands, call ${flow.checkTool}.`,
    { check_tool: flow.checkTool, check_args: flow.checkArgs(id) });
}

/** The transfer is already being sent, or an earlier attempt was interrupted. */
export function inProgressError(flow: TransferFlow, id: string, ref: TransferRef): ToolResult {
  return outcomeUnknownError(
    `This ${flow.noun} is already being sent, or an earlier attempt to send it was interrupted. It may have gone through.`,
    `Do not call ${flow.startTool} again for it. Check ${flow.checkTool}: "completed" means it went through. ` +
    'If it stays "pending", tell your owner.',
    ref,
    { check_tool: flow.checkTool, check_args: flow.checkArgs(id) },
  );
}

/**
 * Botwallet lists this transfer as failed, so nothing more will be sent for
 * it. Older servers also mark a transfer failed when the request to Solana
 * broke off after sending it, so the agent checks the balance before paying
 * again. `retry` says how to make the transfer again.
 */
function listedAsFailed(flow: TransferFlow, error: unknown, ref: TransferRef, retry: string): ToolResult {
  return transferError(error, ref,
    `Botwallet lists this ${flow.noun} as failed, so nothing more will be sent for it. If it failed while it was ` +
    'being sent, it may still have gone through: wait about two minutes, then check botwallet_balance before you ' +
    `make it again. ${retry}`);
}

/**
 * The answer to a repeated request (same idempotency_key) for a transfer that
 * is done or under way. Undefined for the states the caller handles like a new
 * request: waiting for approval, ready to sign, or blocked.
 */
export function replayedTransfer(
  flow: TransferFlow,
  status: unknown,
  id: string,
  ref: TransferRef,
  details: Record<string, unknown> = {},
): ToolResult | undefined {
  switch (status) {
    case 'completed':
      return formatResult({ ...flow.alreadyDone(ref), ...details });
    case 'pending':
      return inProgressError(flow, id, ref);
    case 'failed':
      return listedAsFailed(
        flow,
        new BotWalletError(
          `${flow.kind.toUpperCase()}_FAILED`,
          `The ${flow.noun} made with this idempotency_key failed.`,
        ),
        ref,
        `To make it again, call ${flow.startTool} without this idempotency_key; that starts a new one.`,
      );
    case 'expired':
    case 'cancelled':
    case 'denied':
      return notSentError(
        new BotWalletError(
          `${flow.kind.toUpperCase()}_${String(status).toUpperCase()}`,
          `The ${flow.noun} made with this idempotency_key is ${String(status)}. Nothing more will be sent for it.`,
        ),
        ref,
        `To make this ${flow.noun}, call ${flow.startTool} again without this idempotency_key; that starts a new one.`,
      );
    default:
      return undefined;
  }
}

/**
 * Confirm, check, sign and submit one payment or withdrawal. `ref` holds the
 * ids added to every result so the agent can find the transfer again;
 * `extra` adds fields to the success result.
 */
export async function completeTransfer(
  ctx: ToolContext,
  flow: TransferFlow,
  id: string,
  ref: TransferRef,
  extra: Record<string, unknown> = {},
): Promise<ToolResult> {
  try {
    return await withSigningLock(id, () => confirmAndSign(ctx, flow, id, ref, extra));
  } catch (e) {
    if (e instanceof SigningInProgressError) {
      return alreadySigningError(
        flow.noun,
        `Wait for that request to finish, then check ${flow.checkTool}. Do not call ${flow.startTool} again for it.`,
        ref,
        { check_tool: flow.checkTool, check_args: flow.checkArgs(id) },
      );
    }
    throw e;
  }
}

async function confirmAndSign(
  ctx: ToolContext,
  flow: TransferFlow,
  id: string,
  ref: TransferRef,
  extra: Record<string, unknown>,
): Promise<ToolResult> {
  const walletName = ctx.config.walletName;
  if (!ctx.config.hasSeed || !walletName) {
    return noSeedError(`complete ${flow.noun} (FROST signing)`, walletName);
  }
  // Load Key 1 first, so a broken seed file stops before the server prepares anything
  let mnemonic: string;
  try {
    mnemonic = loadSeed(walletName);
  } catch (e) {
    return notSentError(e, ref);
  }
  // The same for the address Key 1 may sign for
  let walletAddress: string | undefined;
  try {
    walletAddress = localWalletAddress(walletName);
  } catch (e) {
    return unreadableConfigError(e, ref,
      `Then call ${flow.confirmTool} again with this transaction_id; do not call ${flow.startTool} again for it.`);
  }

  // 1. The server builds the transaction. Nothing is signed yet.
  let confirm: Record<string, unknown>;
  try {
    confirm = await flow.confirm(ctx.sdk, id);
  } catch (e) {
    if (isAlreadyCompleted(e)) return formatResult(flow.alreadyDone(ref));
    // Sent earlier and not confirmed yet
    if (isSentUnconfirmed(e)) return sentUnconfirmed(flow, id, ref, e);
    if (isPendingStatusError(e)) return inProgressError(flow, id, ref);
    if (isListedAsFailed(e)) {
      return listedAsFailed(flow, e, ref, `To make it again, call ${flow.startTool}; that starts a new ${flow.noun}.`);
    }
    if (isFrozenWallet(e)) return frozenWalletError(flow, e, ref);
    if (isOwnerSigning(e)) return ownerSigningError(flow, id, e, ref);
    return notSentError(e, ref, isNoAnswer(e)
      ? `Nothing was sent. To try again, call ${flow.confirmTool} with this transaction_id; ` +
        `do not call ${flow.startTool} again for it.`
      : undefined);
  }

  const message = typeof confirm.message === 'string' ? confirm.message : '';
  if (!message) {
    return notSentError(
      new Error(`The server did not return the ${flow.noun} to sign. It may have expired or already been completed.`),
      ref,
      `Check ${flow.checkTool} before doing anything else.`,
    );
  }

  // 2. Key 1 checks the transaction and co-signs; the server submits it
  try {
    const check: SigningCheck = {
      walletAddress,
      transfer: expectedTransfer(flow.kind, confirm, agreedTransferFor(id)),
    };
    const result = await frostSignAndSubmit(ctx.sdk, mnemonic, id, message, check);
    forgetAgreedTransfer(id);
    return formatResult(flow.done(result, ref, extra));
  } catch (e) {
    // Sent, by this round or one before it: not confirmed yet, or confirmed
    if (isSentUnconfirmed(e)) return sentUnconfirmed(flow, id, ref, e);
    if (isAlreadyCompleted(e)) {
      forgetAgreedTransfer(id);
      return formatResult(flow.alreadyDone(ref));
    }
    if (e instanceof SubmitOutcomeUnknownError && e.markedFailed) {
      return outcomeUnknownError(
        `Botwallet reports that sending this ${flow.noun} failed (${e.message}), but the failure may have come after ` +
        'Solana received it, so it may still go through.',
        `Do not call ${flow.startTool} again yet. A transaction Solana did not take can't go through after about two ` +
        `minutes. Wait that long, then check botwallet_balance: if the amount has left the wallet, the ${flow.noun} ` +
        `went through, even if ${flow.checkTool} lists it as failed.`,
        ref,
        { check_tool: 'botwallet_balance', check_args: {} },
      );
    }
    if (e instanceof SubmitOutcomeUnknownError) {
      return outcomeUnknownError(
        `No clear answer came back after Key 1 signed this ${flow.noun} (${e.message}). It may have been sent.`,
        `Do not call ${flow.startTool} again for it. Check ${flow.checkTool}: "completed" means it went through, ` +
        '"pending" means it is still being processed (check again in a minute), "failed" means nothing was sent.',
        ref,
        { check_tool: flow.checkTool, check_args: flow.checkArgs(id) },
      );
    }
    if (e instanceof TransactionCheckError) return signingRefusedError(e, ref, flow.noun);
    // Solana turned the transaction down before taking it: the server marked it failed and says what to do
    if (hasCode(e, 'TRANSACTION_FAILED')) return notSentError(e, ref);
    // Turned away before anything was signed: frozen meanwhile, or the owner's own transfer
    if (isFrozenWallet(e)) return frozenWalletError(flow, e, ref);
    if (isOwnerSigning(e)) return ownerSigningError(flow, id, e, ref);
    // Nothing reached Solana, but the server now lists the transfer as pending
    return notSentError(e, ref,
      `Nothing was sent. Botwallet now lists this ${flow.noun} as pending, and it can't be finished or cancelled ` +
      `from here. Tell your owner before you try this ${flow.noun} again.`);
  }
}
