import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { formatResult } from '../utils/format.js';
import { formatToolError, noSeedError } from '../utils/errors.js';
import { AmountSchema } from '../utils/schemas.js';
import { frostSignAndSubmit } from '../frost/index.js';
import { loadSeed } from '../config/index.js';

const withdraw: ToolDefinition = {
  name: 'botwallet_withdraw',
  description:
    'Withdraw USDC to an external Solana address. ' +
    'If the withdrawal is pre-approved, it completes immediately via FROST threshold signing. ' +
    'If it requires owner approval, returns `needs_approval: true` — check botwallet_events for the result, ' +
    'then call botwallet_confirm_withdrawal.',
  inputSchema: z.object({
    amount: AmountSchema.describe('Amount to withdraw in USD'),
    to_address: z.string().min(32).max(44)
      .describe('Solana wallet address to send USDC to'),
    reason: z.string().min(1).max(500)
      .describe('Why you are withdrawing (shown to owner for approval)'),
    idempotency_key: z.string().optional()
      .describe('Unique key to prevent duplicate withdrawals on retry. Auto-generated if omitted.'),
  }),
  async handler(args, ctx) {
    try {
      const { amount, to_address, reason, idempotency_key } = args as {
        amount: number; to_address: string; reason: string; idempotency_key?: string;
      };
      const idemKey = idempotency_key || randomUUID();
      const withdrawResult = await ctx.sdk.withdraw({ amount, to_address, reason }, idemKey);

      // Needs approval
      if ('status' in withdrawResult && withdrawResult.status === 'pending_approval') {
        return formatResult({
          needs_approval: true,
          approval_id: withdrawResult.approval_id,
          amount: withdrawResult.amount,
          to_address: withdrawResult.to_address,
          reason: withdrawResult.reason,
          message: withdrawResult.message,
          approval_url: withdrawResult.approval_url,
          next_steps: 'Check botwallet_events for approval result, then call botwallet_confirm_withdrawal.',
        });
      }

      // Pre-approved with transaction_id: confirm → get Solana tx → FROST sign
      const result = withdrawResult as Record<string, unknown>;
      if (result.transaction_id) {
        if (!ctx.config.hasSeed || !ctx.config.walletName) {
          return noSeedError('complete withdrawal (FROST signing)');
        }

        const txId = result.transaction_id as string;
        const confirmResult = await ctx.sdk.confirmWithdrawal({
          withdrawal_id: txId,
        });
        if (!confirmResult.message) {
          return formatToolError(new Error(
            'Withdrawal may have expired or already been completed. Check status with botwallet_get_withdrawal.'
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
          withdrawn: true,
          ...signResult,
        });
      }

      return formatToolError(new Error(
        'Unexpected withdrawal response from server. Check status with botwallet_get_withdrawal or botwallet_events.'
      ));
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const confirmWithdrawal: ToolDefinition = {
  name: 'botwallet_confirm_withdrawal',
  description:
    'Complete a withdrawal that was previously approved by the owner. ' +
    'Performs FROST threshold signing to authorize the on-chain transaction.',
  inputSchema: z.object({
    transaction_id: z.string().describe('Transaction ID from the withdrawal or approval event'),
  }),
  async handler(args, ctx) {
    try {
      if (!ctx.config.hasSeed || !ctx.config.walletName) {
        return noSeedError('confirm withdrawal (FROST signing)');
      }

      const { transaction_id } = args as { transaction_id: string };

      const confirmResult = await ctx.sdk.confirmWithdrawal({ withdrawal_id: transaction_id });
      if (!confirmResult.message) {
        return formatToolError(new Error(
          'Withdrawal may have expired or already been completed. Check status with botwallet_get_withdrawal.'
        ));
      }

      const mnemonic = loadSeed(ctx.config.walletName);
      const signResult = await frostSignAndSubmit(
        ctx.sdk,
        mnemonic,
        transaction_id,
        confirmResult.message,
      );

      return formatResult({
        withdrawn: true,
        ...signResult,
      });
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const getWithdrawal: ToolDefinition = {
  name: 'botwallet_get_withdrawal',
  description: 'Check the status of a withdrawal by ID. Shows amount, fees, and current status. When completed, includes the Solana transaction hash.',
  inputSchema: z.object({
    withdrawal_id: z.string().describe('Withdrawal ID to look up'),
  }),
  async handler(args, ctx) {
    try {
      const { withdrawal_id } = args as { withdrawal_id: string };
      const result = await ctx.sdk.getWithdrawal({ withdrawal_id });
      return formatResult(result);
    } catch (e) {
      return formatToolError(e);
    }
  },
};

export const withdrawalTools: ToolDefinition[] = [
  withdraw,
  confirmWithdrawal,
  getWithdrawal,
];
