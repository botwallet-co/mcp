import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { READ_ONLY, MOVES_MONEY } from '../utils/annotations.js';
import { formatResult } from '../utils/format.js';
import {
  formatToolError,
  isNoAnswer,
  noSeedError,
  notSentError,
  outcomeUnknownError,
  type TransferRef,
} from '../utils/errors.js';
import { AmountSchema } from '../utils/schemas.js';
import { usdToBaseUnits } from '../solana/index.js';
import { rememberAgreedTransfer } from '../utils/agreed-transfers.js';
import { completeTransfer, replayedTransfer, WITHDRAWAL_FLOW } from './complete-transfer.js';

const withdraw: ToolDefinition = {
  name: 'botwallet_withdraw',
  annotations: MOVES_MONEY,
  description:
    'Request a withdrawal of USDC to an external Solana address. ' +
    'Every withdrawal needs your human owner\'s approval: this returns `needs_approval: true` with a `transaction_id` and an `approval_url`. ' +
    'Approval flow: (1) Send the `approval_url` to your human owner (approving alone does not move the money) and store the `transaction_id`, ' +
    '(2) Poll `botwallet_approval_status` or `botwallet_events` until status is "approved" (approvals expire after 24 hours), ' +
    '(3) Call `botwallet_confirm_withdrawal` with the `transaction_id` to co-sign and send it. ' +
    'If this call fails or times out, follow its `how_to_fix`: to retry the same request, pass the same `idempotency_key`. ' +
    'Fees: 3% of the amount (1% platform fee, minimum $0.01, plus a 2% withdrawal surcharge), ' +
    'plus a one-time $0.25 account setup fee if the destination address has never held USDC.',
  inputSchema: z.object({
    amount: AmountSchema.describe('Amount to withdraw in USD'),
    to_address: z.string().min(32).max(44)
      .describe('Solana wallet address to send USDC to'),
    reason: z.string().min(1).max(500)
      .describe('Why you are withdrawing (shown to owner for approval)'),
    idempotency_key: z.string().optional()
      .describe('To retry a withdrawal request, pass the idempotency_key from its earlier response, with the same arguments. ' +
        'If omitted, a new key is made, so the call is a new request.'),
  }),
  async handler(args, ctx) {
    try {
      const { amount, to_address, reason, idempotency_key } = args as {
        amount: number; to_address: string; reason: string; idempotency_key?: string;
      };

      // Key 1 signs the withdrawal once it is approved. Check for it before
      // asking the owner to approve one that could never be sent.
      if (!ctx.config.hasSeed || !ctx.config.walletName) {
        return noSeedError('withdraw (FROST signing)', ctx.config.walletName);
      }

      const idemKey = idempotency_key || randomUUID();
      let result: Record<string, unknown>;
      try {
        const withdrawResult = await ctx.sdk.withdraw({ amount, to_address, reason }, idemKey);
        result = withdrawResult as unknown as Record<string, unknown>;
      } catch (e) {
        if (!isNoAnswer(e)) throw e;
        // Key 1 signs only after the owner approves, so nothing was sent
        return outcomeUnknownError(
          `No answer from Botwallet (${(e as Error).message}), so it isn't known whether the withdrawal request was created. ` +
          'Nothing was signed, so no money moved.',
          `Call botwallet_withdraw again with the same arguments and idempotency_key "${idemKey}": ` +
          'Botwallet then returns the request it already created instead of making a second one.',
          { idempotency_key: idemKey },
        );
      }

      const rawId = result.withdrawal_id || result.transaction_id;
      const txId = typeof rawId === 'string' && rawId ? rawId : undefined;
      const ref: TransferRef = txId
        ? { transaction_id: txId, withdrawal_id: txId, idempotency_key: idemKey }
        : { idempotency_key: idemKey };

      // Same idempotency_key as an earlier call: report what became of that withdrawal
      if (result.idempotent && txId) {
        const replay = replayedTransfer(WITHDRAWAL_FLOW, result.status, txId, ref, {
          to_address: result.to_address,
          amount_usdc: result.amount_usdc,
        });
        if (replay) return replay;
      }

      // Key 1 later signs only this amount, to this address, for at most the quoted fee
      const agreedAmount = usdToBaseUnits(amount);
      if (txId && agreedAmount !== null && agreedAmount > 0n) {
        rememberAgreedTransfer(txId, {
          amount: agreedAmount,
          recipient: to_address,
          quotedFee: usdToBaseUnits(result.network_fee_usdc) ?? undefined,
        });
      }

      // Awaiting owner approval — return structured response (not an error)
      if (result.status === 'awaiting_approval') {
        return formatResult({
          needs_approval: true,
          transaction_id: result.withdrawal_id,
          withdrawal_id: result.withdrawal_id,
          idempotency_key: idemKey,
          approval_id: result.approval_id,
          approval_url: result.approval_url,
          amount_usdc: result.amount_usdc,
          network_fee_usdc: result.network_fee_usdc,
          fee_breakdown: result.fee_breakdown,
          you_receive_usdc: result.you_receive_usdc,
          to_address: result.to_address,
          reason: result.reason,
          message: result.message,
          next_step: 'Send the approval_url to your human owner and tell them that approving does not send the withdrawal by itself. ' +
            'Once they approve, call botwallet_confirm_withdrawal with the transaction_id to complete it. Approvals expire after 24 hours.',
          confirm_tool: 'botwallet_confirm_withdrawal',
          confirm_args: { transaction_id: result.withdrawal_id },
          check_tool: 'botwallet_approval_status',
          check_args: { approval_id: result.approval_id },
        });
      }

      // Approved (or pre-approved): confirm -> check -> FROST sign -> submit
      if ((result.status === 'approved' || result.status === 'pre_approved') && txId) {
        return await completeTransfer(ctx, WITHDRAWAL_FLOW, txId, ref);
      }

      return notSentError(new Error(
        'Unexpected withdrawal response from server. Check status with botwallet_get_withdrawal or botwallet_events.'
      ), ref);
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const confirmWithdrawal: ToolDefinition = {
  name: 'botwallet_confirm_withdrawal',
  annotations: MOVES_MONEY,
  description:
    'Complete a withdrawal that was previously approved by the owner. ' +
    'Performs FROST threshold signing to authorize the on-chain transaction, after checking that it sends ' +
    'the approved amount to the approved address plus at most the quoted fee. The amount and address are checked ' +
    'against what the agent asked for only if this MCP server started the withdrawal and has not restarted since; ' +
    'otherwise against the ones Botwallet recorded, with the fee still capped. ' +
    'An error with code OUTCOME_UNKNOWN means the withdrawal may have gone through: check the tool its `check_tool` ' +
    'names (usually botwallet_get_withdrawal) before doing anything else. ' +
    'A result with `status: "pending"` and `sent: true` means the withdrawal was sent and Solana has not confirmed it yet: ' +
    'do not request it again; check `check_tool` in about a minute.',
  inputSchema: z.object({
    transaction_id: z.string().describe('Transaction ID from the withdrawal or approval event'),
  }),
  async handler(args, ctx) {
    try {
      if (!ctx.config.hasSeed || !ctx.config.walletName) {
        return noSeedError('confirm withdrawal (FROST signing)', ctx.config.walletName);
      }

      const { transaction_id } = args as { transaction_id: string };
      return await completeTransfer(ctx, WITHDRAWAL_FLOW, transaction_id, {
        transaction_id,
        withdrawal_id: transaction_id,
      });
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const getWithdrawal: ToolDefinition = {
  name: 'botwallet_get_withdrawal',
  annotations: READ_ONLY,
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
