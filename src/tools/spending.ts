import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { formatResult } from '../utils/format.js';
import { formatToolError, noSeedError } from '../utils/errors.js';
import { AmountSchema, UsernameSchema, PaginationSchema } from '../utils/schemas.js';
import { frostSignAndSubmit } from '../frost/index.js';
import { loadSeed } from '../config/index.js';

const lookup: ToolDefinition = {
  name: 'botwallet_lookup',
  description:
    'Check if a recipient exists before paying. Returns their display name and type (merchant or bot). ' +
    'If not found, suggests similar usernames.',
  inputSchema: z.object({
    username: UsernameSchema.describe('Username to look up (e.g. "@clever-byte-1234")'),
  }),
  async handler(args, ctx) {
    try {
      const { username } = args as { username: string };
      const result = await ctx.sdk.lookup({ username });
      return formatResult(result);
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const canIAfford: ToolDefinition = {
  name: 'botwallet_can_i_afford',
  description:
    'Pre-flight check before paying. Returns two separate answers: ' +
    '(1) `can_afford` — do you have enough balance? ' +
    '(2) `will_auto_approve` — will the payment go through without owner approval? ' +
    'Also shows the fee, total cost, and your balance after payment. ' +
    'Fees: $0.01 minimum or 1% of the transaction amount, whichever is greater. ' +
    'Always call this before botwallet_pay if unsure about your balance.',
  inputSchema: z.object({
    to: UsernameSchema.describe('Recipient username'),
    amount: AmountSchema.describe('Amount in USD'),
  }),
  async handler(args, ctx) {
    try {
      const { to, amount } = args as { to: string; amount: number };
      const apiResult = await ctx.sdk.canIAfford({ to, amount });
      const result = apiResult as unknown as Record<string, unknown>;

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

      // Other guard rail blocks (blacklist, disabled, etc.)
      return formatResult({
        ...result,
        can_afford: false,
        will_auto_approve: false,
        blocked: true,
      });
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const pay: ToolDefinition = {
  name: 'botwallet_pay',
  description:
    'Make a payment to a merchant or bot. Specify `to` + `amount` for direct payments, ' +
    'or `payment_request_id` to pay a specific paylink. ' +
    'If the payment is within your guard rails, it completes immediately via FROST threshold signing ' +
    'and returns `paid: true` with your new balance. ' +
    'If it requires owner approval, returns `needs_approval: true` with a `transaction_id` and `approval_url`. ' +
    'Approval flow: (1) Store the `transaction_id`, (2) Poll `botwallet_approval_status` or `botwallet_events` until status is "approved", ' +
    '(3) Call `botwallet_confirm_payment` with the `transaction_id`. ' +
    'Fees: $0.01 minimum or 1% of the transaction amount, whichever is greater. ' +
    'Always call botwallet_can_i_afford first if unsure about your balance.',
  inputSchema: z.object({
    to: UsernameSchema.optional().describe('Recipient username (required unless using payment_request_id)'),
    amount: AmountSchema.optional().describe('Amount in USD (required unless using payment_request_id)'),
    payment_request_id: z.string().optional()
      .describe('Pay a specific paylink by ID (alternative to to+amount)'),
    note: z.string().max(500).optional()
      .describe('Note visible to recipient'),
    reference: z.string().max(100).optional()
      .describe('Your internal reference for tracking'),
    idempotency_key: z.string().optional()
      .describe('Unique key to prevent duplicate payments on retry. Auto-generated if omitted.'),
  }),
  async handler(args, ctx) {
    try {
      const { to, amount, payment_request_id, note, reference, idempotency_key } = args as {
        to?: string; amount?: number; payment_request_id?: string;
        note?: string; reference?: string; idempotency_key?: string;
      };

      const idemKey = idempotency_key || randomUUID();
      const payResult = await ctx.sdk.pay({ to, amount, payment_request_id, note, reference }, idemKey);
      const result = payResult as unknown as Record<string, unknown>;

      // Awaiting owner approval — return structured response (not an error)
      if (result.status === 'awaiting_approval') {
        return formatResult({
          needs_approval: true,
          transaction_id: result.transaction_id,
          approval_id: result.approval_id,
          approval_url: result.approval_url,
          amount_usdc: result.amount_usdc,
          fee_usdc: result.fee_usdc,
          total_usdc: result.total_usdc,
          to: result.to,
          note,
          next_step: 'Wait for owner approval, then call botwallet_confirm_payment with the transaction_id',
          confirm_tool: 'botwallet_confirm_payment',
          confirm_args: { transaction_id: result.transaction_id },
          check_tool: 'botwallet_approval_status',
          check_args: { approval_id: result.approval_id },
          expires_at: result.expires_at,
        });
      }

      // Already completed (custodial or server-signed)
      if (result.paid) {
        return formatResult(result);
      }

      // Pre-approved with transaction_id: confirm -> FROST sign -> submit
      if (result.status === 'pre_approved' && result.transaction_id) {
        if (!ctx.config.hasSeed || !ctx.config.walletName) {
          return noSeedError('complete payment (FROST signing)');
        }

        const txId = result.transaction_id as string;
        const confirmResult = await ctx.sdk.confirmPayment({
          transaction_id: txId,
        });
        if (!confirmResult.message) {
          return formatToolError(new Error(
            'Transaction may have expired or already been completed. Check status with botwallet_list_payments.'
          ));
        }

        const mnemonic = loadSeed(ctx.config.walletName);
        const signResult = await frostSignAndSubmit(
          ctx.sdk,
          mnemonic,
          txId,
          confirmResult.message,
        );

        return formatResult({
          paid: true,
          auto_approved: true,
          ...signResult,
        });
      }

      return formatToolError(new Error(
        'Unexpected payment response from server. Check status with botwallet_list_payments or botwallet_events.'
      ));
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const confirmPayment: ToolDefinition = {
  name: 'botwallet_confirm_payment',
  description:
    'Complete a payment that was previously approved by the owner. ' +
    'Call this after the owner approves via botwallet_events or the approval URL. ' +
    'Performs FROST threshold signing to authorize the on-chain transaction.',
  inputSchema: z.object({
    transaction_id: z.string().describe('Transaction ID from the original payment or approval event'),
  }),
  async handler(args, ctx) {
    try {
      if (!ctx.config.hasSeed || !ctx.config.walletName) {
        return noSeedError('confirm payment (FROST signing)');
      }

      const { transaction_id } = args as { transaction_id: string };

      const confirmResult = await ctx.sdk.confirmPayment({ transaction_id });
      if (!confirmResult.message) {
        return formatToolError(new Error(
          'Transaction may have expired or already been completed. Check status with botwallet_list_payments.'
        ));
      }

      // FROST sign
      const mnemonic = loadSeed(ctx.config.walletName);
      const signResult = await frostSignAndSubmit(
        ctx.sdk,
        mnemonic,
        transaction_id,
        confirmResult.message,
      );

      return formatResult({
        paid: true,
        ...signResult,
      });
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const listPayments: ToolDefinition = {
  name: 'botwallet_list_payments',
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
  async handler(args, ctx) {
    try {
      const result = await ctx.sdk.listPayments(args as Record<string, unknown>);
      return formatResult(result);
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const cancelPayment: ToolDefinition = {
  name: 'botwallet_cancel_payment',
  description: 'Cancel a pending or pre-approved payment that has not yet been signed.',
  inputSchema: z.object({
    transaction_id: z.string().describe('Transaction ID of the payment to cancel'),
  }),
  async handler(args, ctx) {
    try {
      const { transaction_id } = args as { transaction_id: string };
      const result = await ctx.sdk.cancelPayment({ transaction_id });
      return formatResult(result);
    } catch (e) {
      return formatToolError(e);
    }
  },
};

export const spendingTools: ToolDefinition[] = [
  lookup,
  canIAfford,
  pay,
  confirmPayment,
  listPayments,
  cancelPayment,
];
