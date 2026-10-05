import { z } from 'zod';

export const PaginationSchema = z.object({
  limit: z.number().int().min(1).max(100).optional()
    .describe('Max results to return (1-100, default 20)'),
  offset: z.number().int().min(0).optional()
    .describe('Number of results to skip (for pagination)'),
});

export const AmountSchema = z.number().positive()
  .describe('Amount in USD (e.g. 1.50)');

export const UsernameSchema = z.string().trim().min(1).max(50)
  .describe('Botwallet username, e.g. clever-byte-1234 (a leading @ is accepted)');

/**
 * Drop one leading '@' from a username, as the CLI does before every call
 * (stripAtPrefix in packages/cli-go/cmd/root.go). Usernames never start
 * with '@' and Solana addresses can't contain it, so an address is unchanged.
 * Case is left alone: Solana addresses are case-sensitive.
 */
export function stripAtPrefix(value: string): string {
  return value.trim().replace(/^@/, '');
}
