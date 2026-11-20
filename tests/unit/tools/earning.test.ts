// Offline tests for botwallet_create_paylink: the amount of an itemized
// invoice. The SDK is mocked.

import { describe, it, expect, vi } from 'vitest';
import { earningTools } from '../../../src/tools/earning.js';
import { parseResult, toolContext } from '../../helpers/harness.js';

const createPaylink = earningTools.find(t => t.name === 'botwallet_create_paylink')!;

function fakeSdk() {
  return {
    createPaymentRequest: vi.fn(async (p: Record<string, unknown>) => ({
      request_id: 'pr-1', payment_url: 'https://example.test/pay/pr-1', amount: p.amount,
    })),
  };
}

const ITEMS = [
  { description: 'Strategy call', unit_price_cents: 1500, quantity: 2, total_cents: 3000 },
  { description: 'Follow-up report', unit_price_cents: 2050, quantity: 1, total_cents: 2050 },
];

describe('botwallet_create_paylink', () => {
  it('without an amount, asks for the total of the line items', async () => {
    const sdk = fakeSdk();
    const out = parseResult(await createPaylink.handler({ description: 'Consulting', items: ITEMS }, toolContext(sdk)));

    expect(sdk.createPaymentRequest).toHaveBeenCalledWith(expect.objectContaining({
      amount: 50.5, description: 'Consulting', line_items: ITEMS,
    }));
    expect(out).toMatchObject({ request_id: 'pr-1', amount: 50.5 });
  });

  it('keeps an amount given with the line items', async () => {
    const sdk = fakeSdk();
    await createPaylink.handler({ description: 'Consulting', amount: 45, items: ITEMS }, toolContext(sdk));

    expect(sdk.createPaymentRequest).toHaveBeenCalledWith(expect.objectContaining({ amount: 45, line_items: ITEMS }));
  });

  it('passes a plain amount on without line items', async () => {
    const sdk = fakeSdk();
    await createPaylink.handler({ description: 'Tip', amount: 5, reference: 'ref-9' }, toolContext(sdk));

    expect(sdk.createPaymentRequest).toHaveBeenCalledWith({
      amount: 5, description: 'Tip', reference: 'ref-9', expires_in: undefined, reveal_owner: undefined, line_items: undefined,
    });
  });

  it('refuses a paylink with neither an amount nor line items, without calling Botwallet', async () => {
    for (const args of [{ description: 'Nothing' }, { description: 'Nothing', items: [] }]) {
      const sdk = fakeSdk();
      const result = await createPaylink.handler(args, toolContext(sdk));

      expect(result.isError).toBe(true);
      expect(parseResult(result).message).toContain('Either amount or items must be provided');
      expect(sdk.createPaymentRequest).not.toHaveBeenCalled();
    }
  });
});
