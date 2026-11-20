import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ToolDefinition, ToolResult } from '../types.js';
import { READ_ONLY, CANNOT_UNDO, MOVES_MONEY } from '../utils/annotations.js';
import { formatResult, toolError } from '../utils/tool-result.js';
import { errorMessage, invalidAddressError, noSeedError } from '../utils/errors.js';
import { AmountSchema, UsernameSchema, PaginationSchema, stripAtPrefix } from '../utils/schemas.js';
import { isNoAnswer } from '../sdk/index.js';
import { decodeAddress, usdToBaseUnits, SOLANA_ADDRESS_PATTERN } from '../solana/index.js';
import {
  completeTransfer,
  guardRailBlockedError,
  notSentError,
  outcomeUnknownError,
  rememberAgreedTransfer,
  replayedTransfer,
  PAYMENT_FLOW,
  type AgreedTransfer,
  type TransferRef,
} from '../transfers/index.js';
import { apiTool, defineTool } from './define.js';
import { confirmOutcomeUnknownHelp, PAYMENT_FEES, sentPendingHelp } from './descriptions.js';

/**
 * What the agent agreed to pay: its own amount, or for a paylink the amount
 * Botwallet quoted, and the recipient when it gave an address (the server
 * pays a `to` that looks like an address directly, without a username lookup).
 */
function agreedPayment(
  args: { to?: string; amount?: number; payment_request_id?: string },
  result: Record<string, unknown>,
): AgreedTransfer | undefined {
  // The server takes the amount from the paylink when one is given
  const amount = usdToBaseUnits(args.payment_request_id ? result.amount_usdc : args.amount);
  if (amount === null || amount <= 0n) return undefined;
  return {
    amount,
    recipient: !args.payment_request_id && args.to && SOLANA_ADDRESS_PATTERN.test(args.to) ? args.to : undefined,
    quotedFee: usdToBaseUnits(result.fee_usdc) ?? undefined,
  };
}

/** A username argument that is empty once its '@' is removed. */
function usernameRequired(field: string): ToolResult {
  return toolError('VALIDATION_ERROR', `${field} is required`,
    'Give the recipient\'s Botwallet username, e.g. clever-byte-1234.');
}

const lookup = defineTool({
  name: 'botwallet_lookup',
  annotations: READ_ONLY,
  description:
    'Check if a recipient exists before paying. Returns their display name and type (merchant or bot), ' +
    'or found: false if no merchant or bot has that username.',
  inputSchema: z.object({
    username: UsernameSchema.describe('Username to look up, e.g. clever-byte-1234 (a leading @ is accepted)'),
  }),
  async run(args, ctx) {
    const username = stripAtPrefix(args.username);
    if (!username) return usernameRequired('username');
    const result = await ctx.sdk.lookup({ username });
    return formatResult(result);
  },
});

const canIAfford = defineTool({
  name: 'botwallet_can_i_afford',
  annotations: READ_ONLY,
  description:
    'Pre-flight check before paying. Returns two separate answers: ' +
    '(1) `can_afford` — do you have enough balance? ' +
    '(2) `will_auto_approve` — will the payment go through without owner approval? ' +
    'Also shows the fee, total cost, and your balance after payment. ' +
    '`can_afford` is null when the check stopped before the balance was looked at: the recipient was not found ' +
    '(`recipient_found: false`) or can\'t receive payments (`recipient_can_receive: false`), or your owner\'s ' +
    'guard rails block this payment (`blocked: true`, with the reason and `owner_message`). ' +
    'Don\'t ask your owner for funds unless `can_afford` is false. ' +
    `${PAYMENT_FEES} ` +
    'Always call this before botwallet_pay if unsure about your balance.',
  inputSchema: z.object({
    to: UsernameSchema.describe('Recipient username (a leading @ is accepted)'),
    amount: AmountSchema.describe('Amount in USD'),
  }),
  async run(args, ctx) {
    const { amount } = args;
    const to = stripAtPrefix(args.to);
    if (!to) return usernameRequired('to');
    const result = await ctx.sdk.canIAfford({ to, amount });

    if (result.can_pay) {
      return formatResult({
        ...result,
        can_afford: true,
        will_auto_approve: true,
      });
    }

    if (result.reason === 'needs_approval') {
      return formatResult({
        ...result,
        can_afford: true,
        will_auto_approve: false,
        needs_approval: true,
      });
    }

    if (result.reason === 'insufficient_funds') {
      return formatResult({
        ...result,
        can_afford: false,
        will_auto_approve: false,
      });
    }

    // The server checks the recipient and the guard rails before the
    // balance, so in the cases below it is not known whether you can afford it
    if (result.reason === 'recipient_not_found') {
      return formatResult({
        ...result,
        recipient_found: false,
        can_afford: null,
        will_auto_approve: null,
        blocked: false,
        // The server looks up usernames only; botwallet_pay also takes an address
        ...(SOLANA_ADDRESS_PATTERN.test(to)
          ? { note: 'This check works with usernames only. botwallet_pay can pay a Solana address directly.' }
          : {}),
      });
    }

    if (result.reason === 'recipient_inactive' || result.reason === 'recipient_suspended') {
      return formatResult({
        ...result,
        recipient_found: true,
        recipient_can_receive: false,
        can_afford: null,
        will_auto_approve: null,
        blocked: false,
      });
    }

    // The owner's guard rails block this payment (suspended wallet, spending
    // cap, blocked recipient, ...): result.reason names the rule
    return formatResult({
      ...result,
      can_afford: null,
      will_auto_approve: false,
      blocked: true,
    });
  },
});

const pay = defineTool({
  name: 'botwallet_pay',
  annotations: MOVES_MONEY,
  description:
    'Make a payment to a merchant or bot. Specify `to` + `amount` for direct payments, ' +
    'or `payment_request_id` to pay a specific paylink. ' +
    'If the payment is within your guard rails, it completes immediately via FROST threshold signing ' +
    'and returns `paid: true` with your new balance. ' +
    'If it requires owner approval, returns `needs_approval: true` with a `transaction_id` and `approval_url`. ' +
    'Approval flow: (1) Send the `approval_url` to your human owner (approving alone does not send the payment) and store the `transaction_id`, ' +
    '(2) Poll `botwallet_approval_status` or `botwallet_events` until status is "approved", ' +
    '(3) Call `botwallet_confirm_payment` with the `transaction_id`. ' +
    'If a guard rail blocks the payment, returns an error with the reason. ' +
    'Before Key 1 signs, the transaction is checked: it must pay the agreed amount plus at most the quoted fee. ' +
    'Every response includes an `idempotency_key`. If a call fails or times out, follow its `how_to_fix` instead of ' +
    'calling botwallet_pay again: to retry the same payment, pass the same `idempotency_key`, and Botwallet returns ' +
    'that payment instead of paying twice. An error with code OUTCOME_UNKNOWN means the payment may have gone through: ' +
    'check the tool its `check_tool` names (usually botwallet_list_payments with its `transaction_id`) first. ' +
    `${sentPendingHelp('payment', 'do not pay again')} ` +
    `${PAYMENT_FEES} ` +
    'Always call botwallet_can_i_afford first if unsure about your balance.',
  inputSchema: z.object({
    to: UsernameSchema.optional()
      .describe('Recipient username (a leading @ is accepted) or Solana address (required unless using payment_request_id)'),
    amount: AmountSchema.optional().describe('Amount in USD (required unless using payment_request_id)'),
    payment_request_id: z.string().optional()
      .describe('Pay a specific paylink by ID (alternative to to+amount)'),
    note: z.string().max(500).optional()
      .describe('Note visible to recipient'),
    reference: z.string().max(100).optional()
      .describe('Your internal reference for tracking'),
    idempotency_key: z.string().optional()
      .describe('To retry a payment, pass the idempotency_key from its earlier response, with the same arguments. ' +
        'If omitted, a new key is made, so the call is a new payment.'),
  }),
  async run(args, ctx) {
    const { amount, payment_request_id, note, reference, idempotency_key } = args;
    // The same value goes to the server and to the recipient check before signing
    const rawTo = args.to;
    const to = rawTo === undefined ? undefined : stripAtPrefix(rawTo);
    if (to === '') return usernameRequired('to');
    if (to !== undefined && SOLANA_ADDRESS_PATTERN.test(to) && !decodeAddress(to)) return invalidAddressError();

    // Key 1 signs every payment. Check for it before anything is created on the
    // server, so a missing key share never leaves a payment behind that counts
    // against the spending limit.
    if (!ctx.config.hasSeed || !ctx.config.walletName) {
      return noSeedError('make a payment (FROST signing)', ctx.config.walletName);
    }

    const idemKey = idempotency_key || randomUUID();
    // Read as untyped: every field is checked before it is relied on
    let result: Record<string, unknown>;
    try {
      result = await ctx.sdk.pay({ to, amount, payment_request_id, note, reference }, idemKey);
    } catch (e) {
      if (!isNoAnswer(e)) throw e;
      // Key 1 signs only after the payment exists, so nothing was sent
      return outcomeUnknownError(
        `No answer from Botwallet (${errorMessage(e)}), so it isn't known whether the payment was created. ` +
        'Nothing was signed, so no money moved.',
        `Call botwallet_pay again with the same arguments and idempotency_key "${idemKey}": ` +
        'Botwallet then returns the payment it already created instead of making a second one.',
        { idempotency_key: idemKey },
      );
    }

    const txId = typeof result.transaction_id === 'string' && result.transaction_id ? result.transaction_id : undefined;
    const ref: TransferRef = txId ? { transaction_id: txId, idempotency_key: idemKey } : { idempotency_key: idemKey };

    // Same idempotency_key as an earlier call: report what became of that payment
    if (result.idempotent && txId) {
      const replay = replayedTransfer(PAYMENT_FLOW, result.status, txId, ref, {
        to: result.to,
        amount_usdc: result.amount_usdc,
        fee_usdc: result.fee_usdc,
      });
      if (replay) return replay;
    }

    if (txId) {
      const agreed = agreedPayment({ to, amount, payment_request_id }, result);
      if (agreed) rememberAgreedTransfer(txId, agreed);
    }

    // Awaiting owner approval — return structured response (not an error)
    if (result.status === 'awaiting_approval') {
      return formatResult({
        needs_approval: true,
        transaction_id: result.transaction_id,
        idempotency_key: idemKey,
        approval_id: result.approval_id,
        approval_url: result.approval_url,
        message: result.message,
        approval_reason: result.approval_reason,
        guard_rail: result.guard_rail,
        amount_usdc: result.amount_usdc,
        fee_usdc: result.fee_usdc,
        total_usdc: result.total_usdc,
        to: result.to,
        note,
        next_step: 'Send the approval_url to your human owner and tell them that approving does not send the payment by itself. ' +
          'Once they approve, call botwallet_confirm_payment with the transaction_id to complete it. Approvals expire after 24 hours.',
        confirm_tool: 'botwallet_confirm_payment',
        confirm_args: { transaction_id: result.transaction_id },
        check_tool: 'botwallet_approval_status',
        check_args: { approval_id: result.approval_id },
        expires_at: result.expires_at,
      });
    }

    // Blocked by the owner's guard rails — surface the server's reason
    if (result.status === 'rejected' || result.status === 'blocked') {
      return guardRailBlockedError(result, 'payment');
    }

    // Already completed (custodial or server-signed)
    if (result.paid) {
      return formatResult({ ...result, idempotency_key: idemKey });
    }

    // Ready to sign (pre-approved, or approved by the owner since an earlier
    // call with this key): confirm -> check -> FROST sign -> submit
    if ((result.status === 'pre_approved' || result.status === 'approved') && txId) {
      return await completeTransfer(ctx, PAYMENT_FLOW, txId, ref,
        result.status === 'pre_approved' ? { auto_approved: true } : {});
    }

    return notSentError(new Error(
      `Unexpected payment response from server (status: ${String(result.status)}). ` +
      'Check status with botwallet_list_payments or botwallet_events.'
    ), ref);
  },
});

const confirmPayment = defineTool({
  name: 'botwallet_confirm_payment',
  annotations: MOVES_MONEY,
  description:
    'Complete a payment that was previously approved by the owner. ' +
    'Call this after the owner approves via botwallet_events or the approval URL. ' +
    'Performs FROST threshold signing to authorize the on-chain transaction, after checking that it pays ' +
    'the agreed amount plus at most the quoted fee. The amount and recipient are checked against what the agent asked ' +
    'for only if this MCP server started the payment and has not restarted since; otherwise against the ones Botwallet ' +
    'recorded, with the fee still capped. ' +
    `${confirmOutcomeUnknownHelp('payment', 'botwallet_list_payments with the transaction_id')} ` +
    sentPendingHelp('payment', 'do not pay again'),
  inputSchema: z.object({
    transaction_id: z.string().describe('Transaction ID from the original payment or approval event'),
  }),
  async run(args, ctx) {
    if (!ctx.config.hasSeed || !ctx.config.walletName) {
      return noSeedError('confirm payment (FROST signing)', ctx.config.walletName);
    }

    const { transaction_id } = args;
    return await completeTransfer(ctx, PAYMENT_FLOW, transaction_id, { transaction_id });
  },
});

const listPayments = apiTool({
  name: 'botwallet_list_payments',
  annotations: READ_ONLY,
  description:
    'List outgoing payment intents and their lifecycle status (pending, pre_approved, approved, completed, cancelled, expired). ' +
    'Use this to track specific payments you initiated. ' +
    'For a full ledger of all money movements (in and out), use botwallet_transactions instead.',
  inputSchema: PaginationSchema.extend({
    transaction_id: z.string().optional()
      .describe('Filter by specific transaction ID'),
    status: z.enum(['pending', 'pre_approved', 'approved', 'completed', 'cancelled', 'expired', 'all']).optional()
      .describe('Filter by payment status (default: actionable — pending, pre_approved, approved)'),
  }),
  // Cancelling a payment marks it expired, and the API has no 'cancelled'
  // status (it fails on one), so 'cancelled' lists expired payments, as in the CLI
  call: (sdk, args) => sdk.listPayments(args.status === 'cancelled' ? { ...args, status: 'expired' } : args),
});

const cancelPayment = apiTool({
  name: 'botwallet_cancel_payment',
  annotations: CANNOT_UNDO,
  description:
    'Cancel a payment that has not been sent yet: one that is pre-approved, waiting for owner approval, or approved. ' +
    'A payment that is already being sent (status "pending") can\'t be cancelled.',
  inputSchema: z.object({
    transaction_id: z.string().describe('Transaction ID of the payment to cancel'),
  }),
  call: (sdk, { transaction_id }) => sdk.cancelPayment({ transaction_id }),
});

export const spendingTools: ToolDefinition[] = [
  lookup,
  canIAfford,
  pay,
  confirmPayment,
  listPayments,
  cancelPayment,
];
