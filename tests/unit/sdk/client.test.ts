// Offline tests for how the SDK client turns API errors into errors for the
// agent. fetch is stubbed; nothing goes over the network.

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  BotWallet, BotWalletError, GuardRailError, RecipientNotFoundError, UnauthorizedError,
} from '../../../src/sdk/index.js';
import { formatToolError } from '../../../src/utils/errors.js';
import { MCP_VERSION } from '../../../src/utils/version.js';

function stubApiError(error: Record<string, unknown>, status = 400) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ success: false, error }),
    { status, headers: { 'Content-Type': 'application/json' } },
  )));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('requests', () => {
  it('say they come from this MCP version, as the CLI sends Botwallet-CLI/<version>', async () => {
    const fetchMock = vi.fn(async () => Response.json({ success: true, data: { ok: true } }));
    vi.stubGlobal('fetch', fetchMock);
    const sdk = new BotWallet({ baseUrl: 'https://api.example.test/v1' });

    await sdk.ping();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.test/v1/bot');
    expect(new Headers(init.headers).get('user-agent')).toBe(`BotWallet-MCP/${MCP_VERSION}`);
  });
});

describe('missing or rejected API key', () => {
  it('without a key, points to the existing wallets before registering, in tool names', async () => {
    vi.stubEnv('BOTWALLET_API_KEY', '');
    vi.stubEnv('BW_API_KEY', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const sdk = new BotWallet({ baseUrl: 'https://api.example.test/v1' });

    const error = await sdk.info().catch(e => e);

    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(error.message).toContain('API key');
    expect(error.howToFix).toContain('botwallet_wallet_use');
    expect(error.howToFix).toContain('do not register a new one');
    expect(`${error.message} ${error.howToFix}`).not.toMatch(/register\(\)|new BotWallet/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a rejected key gets advice for the agent, not the HTTP header hint', async () => {
    stubApiError({
      code: 'UNAUTHORIZED', message: 'Invalid API key', how_to_fix: 'Include header: Authorization: Bearer <api_key>',
    }, 401);
    const sdk = new BotWallet({ apiKey: 'bw_bot_fixture-not-a-real-key', baseUrl: 'https://api.example.test/v1' });

    const error = await sdk.info().catch(e => e);

    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(error.message).toBe('Invalid API key');
    expect(error.howToFix).toContain('BOTWALLET_API_KEY');
    expect(error.howToFix).not.toContain('Authorization');
    expect(error.howToFix).toContain('only if your human wants a brand-new wallet');
  });
});

describe('RECIPIENT_NOT_FOUND', () => {
  it('keeps the server\'s message and how_to_fix, which name the username', async () => {
    stubApiError({
      code: 'RECIPIENT_NOT_FOUND',
      message: 'No merchant or agent found with username \'acme-bot\'',
      how_to_fix: 'Use lookup to verify or provide a Solana address',
    }, 404);
    const sdk = new BotWallet({ apiKey: 'bw_bot_fixture-not-a-real-key', baseUrl: 'https://api.example.test/v1' });

    const error = await sdk.pay({ to: 'acme-bot', amount: 5 }).catch(e => e);

    expect(error).toBeInstanceOf(RecipientNotFoundError);
    expect(error.code).toBe('RECIPIENT_NOT_FOUND');
    expect(error.message).toBe('No merchant or agent found with username \'acme-bot\'');
    expect(error.howToFix).toBe('Use lookup to verify or provide a Solana address');
    expect(error.message).not.toContain('unknown');
  });

  it('without a server hint, points to botwallet_lookup', () => {
    const error = new RecipientNotFoundError('acme-bot');
    expect(error.message).toContain('acme-bot');
    expect(error.howToFix).toContain('botwallet_lookup');
  });

  it('without a username, never says \'unknown\'', () => {
    const error = new RecipientNotFoundError();
    expect(error.message).not.toContain('unknown');
  });
});

describe('codes newer servers send', () => {
  const sdk = () => new BotWallet({ apiKey: 'bw_bot_fixture-not-a-real-key', baseUrl: 'https://api.example.test/v1' });

  it.each([
    ['WALLET_SUSPENDED', 403, /unfreeze it in the Botwallet dashboard/],
    ['IDEMPOTENCY_KEY_CONFLICT', 409, /same arguments and idempotency_key.*leave idempotency_key out/s],
    ['DEPRECATED', 410, /update @botwallet\/mcp/],
    ['SIGNING_IN_PROGRESS', 409, /do not pay again.*botwallet_list_payments/s],
    ['SUBMISSION_UNCONFIRMED', 202, /do not pay again.*botwallet_list_payments/s],
  ])('%s without a how_to_fix gets a next step for the agent', async (code, status, expected) => {
    stubApiError({ code, message: 'Refused' }, status);
    const error = await sdk().confirmPayment({ transaction_id: 'tx-1' }).catch(e => e);
    expect(error).toBeInstanceOf(BotWalletError);
    expect(error.code).toBe(code);
    expect(error.message).toBe('Refused');
    expect(error.howToFix).toMatch(expected);
  });

  it('keep the server\'s own how_to_fix', async () => {
    stubApiError({
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      message: 'This idempotency key was already used for a different kind of request.',
      how_to_fix: 'Use a new, unique idempotency key (for example a UUID) for each payment, withdrawal or paid API call.',
    }, 409);
    const error = await sdk().pay({ to: 'shop', amount: 5 }, 'key-1').catch(e => e);
    expect(error.howToFix).toBe('Use a new, unique idempotency key (for example a UUID) for each payment, withdrawal or paid API call.');
  });

  it('a frozen wallet is a guard-rail block', async () => {
    stubApiError({
      code: 'WALLET_SUSPENDED',
      message: 'This wallet is frozen by its owner, so it can\'t send money.',
      guard_rail: { key: 'wallet_suspended', current_value: 'Frozen' },
    }, 403);
    const error = await sdk().confirmPayment({ transaction_id: 'tx-1' }).catch(e => e);
    expect(error).toBeInstanceOf(GuardRailError);
    expect(error.howToFix).toMatch(/unfreeze/);
  });
});

describe('SUBMISSION_UNCONFIRMED', () => {
  it('keeps the Solana signature and explorer link of a transfer sent but not confirmed yet', async () => {
    stubApiError({
      code: 'SUBMISSION_UNCONFIRMED',
      message: 'This payment was sent to Solana but is not confirmed yet, so it may still go through. Do not pay again.',
      how_to_fix: 'Check its status in about a minute with: botwallet pay list --id tx-9. It will show completed or failed.',
      transaction_id: 'tx-9',
      status: 'pending',
      solana_signature: 'sig-9',
      explorer_url: 'https://solscan.io/tx/sig-9',
      check_command: 'botwallet pay list --id tx-9',
    }, 202);
    const sdk = new BotWallet({ apiKey: 'bw_bot_fixture-not-a-real-key', baseUrl: 'https://api.example.test/v1' });

    const error = await sdk.frostSignComplete({ session_id: 's-1', partial_sig: 'AAAA' }).catch(e => e);

    expect(error).toBeInstanceOf(BotWalletError);
    expect(error.code).toBe('SUBMISSION_UNCONFIRMED');
    expect(error.details).toMatchObject({
      transaction_id: 'tx-9', solana_signature: 'sig-9', explorer_url: 'https://solscan.io/tx/sig-9',
    });
  });
});

describe('guard-rail blocks', () => {
  const sdk = () => new BotWallet({ apiKey: 'bw_bot_fixture-not-a-real-key', baseUrl: 'https://api.example.test/v1' });
  // What the withdraw handler sends when the amount is over the owner's limit
  const maxWithdrawal = {
    code: 'MAX_WITHDRAWAL',
    message: 'This withdrawal was blocked because $500.00 exceeds the max withdrawal of $100.00.',
    how_to_fix: 'Ask your wallet owner to update the Guard Rails settings on their dashboard.',
    guard_rail: { name: 'Max Withdrawal', key: 'max_withdrawal', current_value: '$100.00' },
    max_withdrawal: 100,
    requested: 500,
  };

  it('keep the server\'s how_to_fix and details', async () => {
    stubApiError(maxWithdrawal);

    const error = await sdk().withdraw({ amount: 500, to_address: 'So11111111111111111111111111111111111111112' })
      .catch(e => e);

    expect(error).toBeInstanceOf(GuardRailError);
    expect(error.code).toBe('MAX_WITHDRAWAL');
    expect(error.guardRail).toBe('max_withdrawal');
    expect(error.message).toBe(maxWithdrawal.message);
    expect(error.howToFix).toBe(maxWithdrawal.how_to_fix);
    expect(error.details).toMatchObject({ max_withdrawal: 100, requested: 500, guard_rail: { key: 'max_withdrawal' } });

    const out = JSON.parse(formatToolError(error).content[0].text);
    expect(out.how_to_fix).toBe(maxWithdrawal.how_to_fix);
  });

  it.each(['WALLET_SUSPENDED', 'ALLOW_WITHDRAWAL_REQUESTS', 'ALLOW_PAYLINKS', 'MAX_PAYLINK_AMOUNT'])(
    'recognise the current code %s',
    async (code) => {
      stubApiError({ code, message: 'Blocked', how_to_fix: 'Ask your wallet owner.' });
      const error = await sdk().createPaymentRequest({ amount: 5, description: 'Test' }).catch(e => e);
      expect(error).toBeInstanceOf(GuardRailError);
      expect(error.howToFix).toBe('Ask your wallet owner.');
    },
  );

  it('recognise a rule this version does not know, by its guard_rail object', async () => {
    stubApiError({ ...maxWithdrawal, code: 'MAX_SOMETHING_NEW', guard_rail: { key: 'max_something_new' } });
    const error = await sdk().withdraw({ amount: 5, to_address: 'So11111111111111111111111111111111111111112' })
      .catch(e => e);
    expect(error).toBeInstanceOf(GuardRailError);
    expect(error.code).toBe('MAX_SOMETHING_NEW');
    expect(error.howToFix).toBe(maxWithdrawal.how_to_fix);
  });

  it('leave other errors as they are', async () => {
    stubApiError({ code: 'VALIDATION_ERROR', message: 'amount must be greater than 0', how_to_fix: 'Send a positive amount.' });
    const error = await sdk().withdraw({ amount: 0, to_address: 'So11111111111111111111111111111111111111112' })
      .catch(e => e);
    expect(error).toBeInstanceOf(BotWalletError);
    expect(error).not.toBeInstanceOf(GuardRailError);
    expect(error.howToFix).toBe('Send a positive amount.');
  });
});
