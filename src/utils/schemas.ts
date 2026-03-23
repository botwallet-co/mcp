import { z } from 'zod';

export const PaginationSchema = z.object({
  limit: z.number().int().min(1).max(100).optional()
    .describe('Max results to return (1-100, default 20)'),
  offset: z.number().int().min(0).optional()
    .describe('Number of results to skip (for pagination)'),
});

export const AmountSchema = z.number().positive()
  .describe('Amount in USD (e.g. 1.50)');

export const UsernameSchema = z.string().min(1).max(50)
  .describe('BotWallet username (e.g. @clever-byte-1234)');
