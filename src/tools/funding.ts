import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { READ_ONLY, CREATES } from '../utils/annotations.js';
import { AmountSchema, PaginationSchema } from '../utils/schemas.js';
import { apiTool } from './define.js';

const getDepositAddress = apiTool({
  name: 'botwallet_get_deposit_address',
  annotations: READ_ONLY,
  description:
    'Get your USDC deposit address on Solana. Anyone can send USDC to this address to fund your wallet. ' +
    'Also returns a funding URL for the owner portal.',
  inputSchema: z.object({}),
  call: sdk => sdk.getDepositAddress(),
});

const requestFunds = apiTool({
  name: 'botwallet_request_funds',
  annotations: CREATES,
  description:
    'Request funds from your human owner. Sends a notification with the amount and reason. ' +
    'Use this when your balance is too low to complete a task.',
  inputSchema: z.object({
    amount: AmountSchema.describe('Amount to request in USD'),
    reason: z.string().min(1).max(500)
      .describe('Why you need the funds (shown to owner)'),
  }),
  call: (sdk, { amount, reason }) => sdk.requestFunds({ amount, reason }),
});

const listFundRequests = apiTool({
  name: 'botwallet_list_fund_requests',
  annotations: READ_ONLY,
  description: 'List your fund requests with status (pending, funded, dismissed). Supports pagination.',
  // Status values must match ListFundRequestsParams['status']: tsc checks it at the call below
  inputSchema: PaginationSchema.extend({
    status: z.enum(['pending', 'funded', 'dismissed', 'all']).optional()
      .describe('Filter by status (default: all)'),
  }),
  call: (sdk, args) => sdk.listFundRequests(args),
});

export const fundingTools: ToolDefinition[] = [
  getDepositAddress,
  requestFunds,
  listFundRequests,
];
