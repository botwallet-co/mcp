// Offline tests for the botwallet://status resource. The SDK is mocked.

import { describe, it, expect, vi } from 'vitest';
import { getWalletStatus } from '../../../src/resources/index.js';
import { BotWalletError, NetworkError, UnauthorizedError } from '../../../src/sdk/index.js';
import type { BotWallet } from '../../../src/sdk/index.js';
import type { ConfigContext } from '../../../src/types.js';

const CONFIG: ConfigContext = { walletName: undefined, hasConfig: false, hasSeed: false };
const DEPOSIT = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const CLAIM_URL = 'https://app.example.test/claim/0b7c6c1e-0000-4000-8000-000000000001';

function mockSdk(info: () => Promise<unknown>, balance: () => Promise<unknown>) {
  return { info: vi.fn(info), balance: vi.fn(balance) } as unknown as BotWallet;
}

const baseInfo = {
  wallet_id: '0b7c6c1e-0000-4000-8000-000000000001',
  username: 'research-bot',
  name: 'Research Bot',
  deposit_address: DEPOSIT,
  funding_url: 'https://app.example.test/fund/research-bot',
};

// What the server answers for balance until a human owner claims the wallet
const notClaimed = () => Promise.reject(new BotWalletError(
  'WALLET_NOT_CLAIMED' as never,
  'This wallet has not been claimed by a human owner yet',
  'Ask your human owner to claim this wallet before you can use it',
  { claim_url: CLAIM_URL, claim_code: 'K7P2QX' },
));

describe('botwallet://status', () => {
  it('for an unclaimed wallet, shows the claim link and code instead of only an error', async () => {
    const sdk = mockSdk(async () => ({
      ...baseInfo,
      status: 'unclaimed',
      is_claimed: false,
      balance: 0,
      balance_cached_at: '2026-10-04T10:00:00Z',
      claim_url: CLAIM_URL,
      claim_code: 'K7P2QX',
      claim_expires_at: '2026-10-06T10:00:00Z',
      claim_instructions: 'Share the claim_url with your human owner. They need code K7P2QX to claim this wallet.',
    }), notClaimed);

    const text = await getWalletStatus(sdk, CONFIG);

    expect(text).not.toContain('unavailable:');
    expect(text).toContain('Owner: unclaimed');
    expect(text).toContain(`Deposit Address: ${DEPOSIT}`);
    expect(text).toContain(`Claim URL: ${CLAIM_URL}`);
    expect(text).toContain('Claim Code: K7P2QX (expires 2026-10-06T10:00:00Z)');
    expect(text).toContain('They need code K7P2QX');
    expect(text).toContain('Balance: $0.00 USDC (last known at 2026-10-04T10:00:00Z; the live balance needs a claimed wallet)');
  });

  it('for an abandoned wallet, says it has no owner and points to botwallet_update_owner', async () => {
    const sdk = mockSdk(async () => ({
      ...baseInfo,
      status: 'abandoned',
      // The server sets is_claimed for every status but unclaimed
      is_claimed: true,
      balance: 12.5,
      abandoned: true,
      claim_url: CLAIM_URL,
      claim_code: 'K7P2QX',
    }), () => Promise.reject(new BotWalletError(
      'WALLET_ABANDONED' as never, 'This wallet has been abandoned by its previous owner',
    )));

    const text = await getWalletStatus(sdk, CONFIG);

    expect(text).toContain('Owner: none (abandoned)');
    expect(text).not.toContain('Owner: claimed');
    expect(text).toContain(`Claim URL: ${CLAIM_URL}`);
    expect(text).toContain('Claim Code: K7P2QX');
    expect(text).not.toContain('expires');
    expect(text).toContain('botwallet_update_owner');
    expect(text).toContain('Balance: $12.50 USDC (last known;');
  });

  it('for a claimed wallet, shows the live balance and budget and no claim details', async () => {
    const sdk = mockSdk(async () => ({ ...baseInfo, status: 'active', is_claimed: true, balance: 40 }), async () => ({
      balance: 42.1,
      budget: 50,
      budget_period: 'daily',
      spent_this_period: 10,
      remaining_budget: 40,
      low_balance: false,
    }));

    const text = await getWalletStatus(sdk, CONFIG);

    expect(text).toContain('Owner: claimed');
    expect(text).toContain('Balance: $42.10 USDC\n');
    expect(text).toContain('Budget: $50.00/daily | Spent: $10.00 | Remaining: $40.00');
    expect(text).not.toContain('Claim');
    expect(text).toContain('Local Key Share: not configured');
  });

  it('when only the balance fails, keeps the wallet details and never shows a made-up $0.00', async () => {
    const sdk = mockSdk(
      async () => ({ ...baseInfo, status: 'active', is_claimed: true }),
      () => Promise.reject(new NetworkError('fetch failed')),
    );

    const text = await getWalletStatus(sdk, CONFIG);

    expect(text).toContain('Balance: unknown (live balance unavailable: fetch failed)');
    expect(text).not.toContain('$0.00');
    expect(text).toContain(`Deposit Address: ${DEPOSIT}`);
  });

  it('when the wallet info fails, says the status is unavailable, why, and what to do', async () => {
    const error = new UnauthorizedError('Invalid API key');
    const sdk = mockSdk(() => Promise.reject(error), notClaimed);

    const text = await getWalletStatus(sdk, CONFIG);

    expect(text).toBe(`Wallet status unavailable: Invalid API key\nNext Step: ${error.howToFix}`);
  });

  it('leaves out the next step when the error has none', async () => {
    const sdk = mockSdk(() => Promise.reject(new Error('socket hang up')), notClaimed);

    const text = await getWalletStatus(sdk, CONFIG);

    expect(text).toBe('Wallet status unavailable: socket hang up');
  });
});
