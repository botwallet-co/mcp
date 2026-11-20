// Offline tests for the tools that move money: botwallet_pay,
// botwallet_confirm_payment, botwallet_withdraw, botwallet_confirm_withdrawal
// and botwallet_x402_pay_and_fetch. The SDK is mocked; FROST signing runs for
// real against a fake server holding Key 2 (tests/helpers/fake-signer.ts), and
// the server's transactions are built like buildPaymentTransaction builds them.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { base58 } from '@scure/base';

const testHome = path.join(os.tmpdir(), `bw-payments-test-${Date.now()}`);
vi.mock('node:os', async () => (await import('../../helpers/temp-home.js')).osWithHome(() => testHome));
// Every API host in these tests has a public address; no real DNS lookups
vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '93.184.215.14', family: 4 }],
}));

import { spendingTools } from '../../../src/tools/spending.js';
import { withdrawalTools } from '../../../src/tools/withdrawals.js';
import { x402Tools } from '../../../src/tools/x402.js';
import { BotWalletError, GuardRailError, NetworkError, TimeoutError } from '../../../src/sdk/index.js';
import type { ConfigContext } from '../../../src/types.js';
import { addWallet, seedFileValue } from '../../../src/config/config.js';
import { saveSeed } from '../../../src/config/seeds.js';
import { FakeSigner } from '../../helpers/fake-signer.js';
import { localWallet, parseResult, TEST_MNEMONIC, toolContext } from '../../helpers/harness.js';
import { buildServerTransfer, serverX402Fees, testAddress, USDC_MAINNET } from '../../helpers/solana-messages.js';

const tool = (name: string) =>
  [...spendingTools, ...withdrawalTools, ...x402Tools].find(t => t.name === name)!;
const pay = tool('botwallet_pay');
const confirmPayment = tool('botwallet_confirm_payment');
const withdraw = tool('botwallet_withdraw');
const confirmWithdrawal = tool('botwallet_confirm_withdrawal');
const x402Fetch = tool('botwallet_x402_fetch');
const x402PayAndFetch = tool('botwallet_x402_pay_and_fetch');

const WALLET_NAME = 'agent';
const FEE_PAYER = testAddress('fee-payer');
const FEE_COLLECTION = testAddress('fee-collection');
const RECIPIENT = testAddress('recipient');
const ATTACKER = testAddress('attacker');
const MERCHANT = testAddress('merchant');

let signer: FakeSigner;

beforeAll(() => {
  signer = new FakeSigner(TEST_MNEMONIC);
  saveSeed(WALLET_NAME, TEST_MNEMONIC);
  addWallet(WALLET_NAME, {
    username: 'agent-bot',
    api_key: 'bw_bot_fixture-not-a-real-key',
    public_key: signer.walletAddress,
    seed_file: seedFileValue(WALLET_NAME),
    created_at: '2026-10-04T12:00:00Z',
  });
});

afterAll(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

let nextId = 0;
const newId = (prefix: string) => `${prefix}-${++nextId}`;

interface ServerTransfer {
  amount?: bigint;
  fee?: bigint;
  toWallet?: string;
  /** What the server says in its response, when it differs from the message. */
  declaredAmountUsd?: number;
  declaredTo?: string;
}

/** A confirm_payment / confirm_withdrawal / x402_confirm answer with the transaction to sign. */
function confirmAnswer(id: string, t: ServerTransfer = {}): Record<string, unknown> {
  const amount = t.amount ?? 5_000_000n;
  const fee = t.fee ?? 50_000n;
  const toWallet = t.toWallet ?? RECIPIENT;
  const message = signer.storeMessage(id, buildServerTransfer({
    feePayer: FEE_PAYER,
    wallet: signer.walletAddress,
    toWallet,
    feeCollection: FEE_COLLECTION,
    amount,
    fee,
  }));
  return {
    transaction_id: id,
    status: 'ready_to_sign',
    message,
    network: 'mainnet-beta',
    amount_usdc: t.declaredAmountUsd ?? Number(amount) / 1e6,
    fee_usdc: Number(fee) / 1e6,
    to_address: t.declaredTo ?? toWallet,
  };
}

function fakeSdk() {
  return {
    pay: vi.fn(),
    confirmPayment: vi.fn(),
    withdraw: vi.fn(),
    confirmWithdrawal: vi.fn(),
    x402Prepare: vi.fn(),
    x402Confirm: vi.fn(),
    x402Settle: vi.fn(async () => ({ settled: true })),
    ...signer.sdkMethods(),
  };
}

const makeCtx = (sdk: ReturnType<typeof fakeSdk>, config: Partial<ConfigContext> = {}) =>
  toolContext(sdk, { ...localWallet(WALLET_NAME), ...config });

function preApproved(id: string, extra: Record<string, unknown> = {}) {
  return { status: 'pre_approved', transaction_id: id, amount_usdc: 5, fee_usdc: 0.05, network: 'mainnet-beta', ...extra };
}

const SENT_SIGNATURE = base58.encode(new Uint8Array(64).fill(7));

/** The server's answer (HTTP 202) for a transfer it sent to Solana that isn't confirmed yet. */
function sentUnconfirmedError(id: string, noun = 'payment', check = `botwallet pay list --id ${id}`) {
  return new BotWalletError('SUBMISSION_UNCONFIRMED',
    `This ${noun} was sent to Solana but is not confirmed yet, so it may still go through. Do not pay again.`,
    `Check its status in about a minute with: ${check}. It will show completed or failed.`,
    {
      transaction_id: id,
      status: 'pending',
      solana_signature: SENT_SIGNATURE,
      explorer_url: `https://solscan.io/tx/${SENT_SIGNATURE}`,
      check_command: check,
    });
}

/** What the SDK makes of the server's answer (HTTP 403) for a wallet the owner froze. */
function frozenError() {
  return new GuardRailError('wallet_suspended',
    'This wallet is frozen by its owner, so it can\'t send money. Ask your owner to unfreeze it in the Botwallet dashboard.',
    { guard_rail: { key: 'wallet_suspended', current_value: 'Frozen' } },
    'Ask your owner to unfreeze this wallet in the Botwallet dashboard, then try again.');
}

describe('botwallet_pay', () => {
  it('checks for Key 1 before creating a payment', async () => {
    const sdk = fakeSdk();
    const out = parseResult(await pay.handler({ to: 'shop', amount: 5 }, makeCtx(sdk, { hasSeed: false })));
    expect(out.code).toBe('NO_LOCAL_SEED');
    expect(sdk.pay).not.toHaveBeenCalled();
  });

  it('pays a pre-approved payment and returns its idempotency key', async () => {
    const sdk = fakeSdk();
    const id = newId('pay');
    sdk.pay.mockResolvedValue(preApproved(id));
    sdk.confirmPayment.mockImplementation(async () => confirmAnswer(id));

    const result = await pay.handler({ to: 'shop', amount: 5 }, makeCtx(sdk));
    const out = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(out).toMatchObject({ paid: true, auto_approved: true, transaction_id: id });
    expect(out.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(sdk.pay.mock.calls[0][1]).toBe(out.idempotency_key);
    expect(signer.completed.some(c => c.transactionId === id)).toBe(true);
  });

  it('sends the idempotency key it is given, so a retry finds the same payment', async () => {
    const sdk = fakeSdk();
    const id = newId('pay');
    sdk.pay.mockResolvedValue(preApproved(id));
    sdk.confirmPayment.mockImplementation(async () => confirmAnswer(id));

    const out = parseResult(await pay.handler({ to: 'shop', amount: 5, idempotency_key: 'order-77' }, makeCtx(sdk)));
    expect(sdk.pay.mock.calls[0][1]).toBe('order-77');
    expect(out.idempotency_key).toBe('order-77');
  });

  it('after a timeout creating the payment, asks for a retry with the same key', async () => {
    const sdk = fakeSdk();
    sdk.pay.mockRejectedValue(new TimeoutError(30000));

    const result = await pay.handler({ to: 'shop', amount: 5 }, makeCtx(sdk));
    const out = parseResult(result);

    expect(result.isError).toBe(true);
    expect(out.code).toBe('OUTCOME_UNKNOWN');
    expect(out.message).toMatch(/no money moved/);
    expect(out.how_to_fix).toContain(out.idempotency_key);
    expect(sdk.confirmPayment).not.toHaveBeenCalled();
  });

  it('after a lost answer once Key 1 signed, says the payment may have gone through', async () => {
    const sdk = fakeSdk();
    const id = newId('pay');
    sdk.pay.mockResolvedValue(preApproved(id));
    sdk.confirmPayment.mockImplementation(async () => confirmAnswer(id));
    sdk.frostSignComplete.mockRejectedValue(new TimeoutError(30000));

    const result = await pay.handler({ to: 'shop', amount: 5 }, makeCtx(sdk));
    const out = parseResult(result);

    expect(result.isError).toBe(true);
    expect(out).toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      status: 'unknown',
      transaction_id: id,
      check_tool: 'botwallet_list_payments',
      check_args: { transaction_id: id },
    });
    expect(out.idempotency_key).toBeTruthy();
    expect(out.how_to_fix).toMatch(/Do not call botwallet_pay again/);
    expect(out.how_to_fix).not.toMatch(/try again in a moment/);
  });

  it('when sending fails after Key 1 signed, says to check the balance before paying again', async () => {
    const sdk = fakeSdk();
    const id = newId('pay');
    sdk.pay.mockResolvedValue(preApproved(id));
    sdk.confirmPayment.mockImplementation(async () => confirmAnswer(id));
    // An older server marks the payment failed when its request to Solana breaks off
    sdk.frostSignComplete.mockRejectedValue(new BotWalletError('TRANSACTION_FAILED',
      'error sending request for url: connection closed before message completed',
      'The FROST signature may be invalid or the transaction expired. Create a new payment.'));

    const out = parseResult(await pay.handler({ to: 'shop', amount: 5 }, makeCtx(sdk)));
    expect(out).toMatchObject({ code: 'OUTCOME_UNKNOWN', transaction_id: id, check_tool: 'botwallet_balance' });
    expect(out.sent).toBeUndefined();
    expect(out.how_to_fix).toMatch(/Do not call botwallet_pay again/);
    expect(out.how_to_fix).toMatch(/two minutes/);
  });

  it('when Solana turned the signed payment down before taking it, says nothing was sent', async () => {
    const sdk = fakeSdk();
    const id = newId('pay');
    sdk.pay.mockResolvedValue(preApproved(id));
    sdk.confirmPayment.mockImplementation(async () => confirmAnswer(id));
    sdk.frostSignComplete.mockRejectedValue(new BotWalletError('TRANSACTION_FAILED',
      'Transaction simulation failed: Blockhash not found', 'Create a new payment.'));

    const out = parseResult(await pay.handler({ to: 'shop', amount: 5 }, makeCtx(sdk)));
    expect(out).toMatchObject({ code: 'TRANSACTION_FAILED', sent: false, transaction_id: id });
  });

  it('reports a payment sent but not confirmed yet as pending, not as a failure', async () => {
    const sdk = fakeSdk();
    const id = newId('pay');
    sdk.pay.mockResolvedValue(preApproved(id));
    sdk.confirmPayment.mockImplementation(async () => confirmAnswer(id));
    sdk.frostSignComplete.mockRejectedValue(sentUnconfirmedError(id));

    const result = await pay.handler({ to: 'shop', amount: 5 }, makeCtx(sdk));
    const out = parseResult(result);

    expect(result.isError).toBeUndefined();
    expect(out).toMatchObject({
      status: 'pending',
      sent: true,
      transaction_id: id,
      solana_signature: SENT_SIGNATURE,
      explorer_url: `https://solscan.io/tx/${SENT_SIGNATURE}`,
      check_tool: 'botwallet_list_payments',
      check_args: { transaction_id: id },
    });
    expect(out.idempotency_key).toBeTruthy();
    expect(out.paid).toBeUndefined();
    expect(out.message).toMatch(/may still go through/);
    expect(out.next_step).toMatch(/Do not call botwallet_pay again/);
  });

  it('when building the transaction fails, says nothing was sent and how to finish it', async () => {
    const sdk = fakeSdk();
    const id = newId('pay');
    sdk.pay.mockResolvedValue(preApproved(id));
    sdk.confirmPayment.mockRejectedValue(new NetworkError('socket hang up'));

    const out = parseResult(await pay.handler({ to: 'shop', amount: 5 }, makeCtx(sdk)));
    expect(out).toMatchObject({ sent: false, transaction_id: id });
    expect(out.how_to_fix).toMatch(/botwallet_confirm_payment/);
    expect(sdk.frostSignInit).not.toHaveBeenCalled();
  });

  it('refuses to sign more than the agent asked for, even if the server reports the same', async () => {
    const sdk = fakeSdk();
    const id = newId('pay');
    sdk.pay.mockResolvedValue(preApproved(id, { amount_usdc: 50 }));
    sdk.confirmPayment.mockImplementation(async () => confirmAnswer(id, { amount: 50_000_000n }));

    const result = await pay.handler({ to: 'shop', amount: 5 }, makeCtx(sdk));
    const out = parseResult(result);

    expect(result.isError).toBe(true);
    expect(out).toMatchObject({ code: 'TRANSACTION_MISMATCH', sent: false, transaction_id: id });
    expect(sdk.frostSignComplete).not.toHaveBeenCalled();
  });

  it('pays a Solana address only into that address', async () => {
    const sdk = fakeSdk();
    const id = newId('pay');
    sdk.pay.mockResolvedValue(preApproved(id, { to_address: RECIPIENT }));
    sdk.confirmPayment.mockImplementation(async () => confirmAnswer(id, { toWallet: ATTACKER }));

    const out = parseResult(await pay.handler({ to: RECIPIENT, amount: 5 }, makeCtx(sdk)));
    expect(out.code).toBe('TRANSACTION_MISMATCH');
    expect(sdk.frostSignComplete).not.toHaveBeenCalled();
  });

  it('reports a replayed payment that already went through as paid, without signing again', async () => {
    const sdk = fakeSdk();
    const id = newId('pay');
    sdk.pay.mockResolvedValue({ idempotent: true, status: 'completed', transaction_id: id, amount_usdc: 5 });

    const result = await pay.handler({ to: 'shop', amount: 5, idempotency_key: 'k1' }, makeCtx(sdk));
    const out = parseResult(result);
    expect(result.isError).toBeUndefined();
    expect(out).toMatchObject({ paid: true, already_completed: true, transaction_id: id, idempotency_key: 'k1' });
    expect(sdk.confirmPayment).not.toHaveBeenCalled();
  });

  it('reports a replayed payment that is being sent as unknown, without signing again', async () => {
    const sdk = fakeSdk();
    const id = newId('pay');
    sdk.pay.mockResolvedValue({ idempotent: true, status: 'pending', transaction_id: id });

    const out = parseResult(await pay.handler({ to: 'shop', amount: 5, idempotency_key: 'k2' }, makeCtx(sdk)));
    expect(out).toMatchObject({ code: 'OUTCOME_UNKNOWN', transaction_id: id, idempotency_key: 'k2' });
    expect(sdk.confirmPayment).not.toHaveBeenCalled();
  });

  it('reports a replayed payment that failed, and that a new key starts a new payment', async () => {
    const sdk = fakeSdk();
    const id = newId('pay');
    sdk.pay.mockResolvedValue({ idempotent: true, status: 'failed', transaction_id: id });

    const out = parseResult(await pay.handler({ to: 'shop', amount: 5, idempotency_key: 'k3' }, makeCtx(sdk)));
    expect(out).toMatchObject({ code: 'PAYMENT_FAILED', transaction_id: id });
    // An older server may list a payment failed that still went through
    expect(out.sent).toBeUndefined();
    expect(out.how_to_fix).toMatch(/botwallet_balance/);
    expect(out.how_to_fix).toMatch(/without this idempotency_key/);
  });

  it('reports a replayed payment that expired as not sent', async () => {
    const sdk = fakeSdk();
    const id = newId('pay');
    sdk.pay.mockResolvedValue({ idempotent: true, status: 'expired', transaction_id: id });

    const out = parseResult(await pay.handler({ to: 'shop', amount: 5, idempotency_key: 'k4' }, makeCtx(sdk)));
    expect(out).toMatchObject({ code: 'PAYMENT_EXPIRED', sent: false, transaction_id: id });
  });

  it('checks an approved payment against what the agent asked for', async () => {
    const sdk = fakeSdk();
    const id = newId('pay');
    sdk.pay.mockResolvedValue({
      status: 'awaiting_approval', transaction_id: id, approval_id: 'ap-1', amount_usdc: 5, fee_usdc: 0.05,
    });
    const waiting = parseResult(await pay.handler({ to: 'shop', amount: 5 }, makeCtx(sdk)));
    expect(waiting).toMatchObject({ needs_approval: true, transaction_id: id });
    expect(waiting.idempotency_key).toBeTruthy();

    // After approval the server prepares a bigger payment and reports it consistently
    sdk.confirmPayment.mockImplementationOnce(async () => confirmAnswer(id, { amount: 9_000_000n }));
    const refused = parseResult(await confirmPayment.handler({ transaction_id: id }, makeCtx(sdk)));
    expect(refused.code).toBe('TRANSACTION_MISMATCH');

    sdk.confirmPayment.mockImplementationOnce(async () => confirmAnswer(id));
    const paid = parseResult(await confirmPayment.handler({ transaction_id: id }, makeCtx(sdk)));
    expect(paid).toMatchObject({ paid: true, transaction_id: id });
  });
});

describe('botwallet_confirm_payment', () => {
  it('reports a payment completed earlier as paid', async () => {
    const sdk = fakeSdk();
    sdk.confirmPayment.mockRejectedValue(
      new BotWalletError('ALREADY_COMPLETED', 'This transaction has already been completed'));
    const out = parseResult(await confirmPayment.handler({ transaction_id: 'done-1' }, makeCtx(sdk)));
    expect(out).toMatchObject({ paid: true, already_completed: true, transaction_id: 'done-1' });
  });

  it('reports a payment listed as failed without promising nothing was sent', async () => {
    const sdk = fakeSdk();
    sdk.confirmPayment.mockRejectedValue(
      new BotWalletError('TRANSACTION_FAILED', 'This transaction previously failed', 'Create a new payment'));
    const out = parseResult(await confirmPayment.handler({ transaction_id: 'failed-1' }, makeCtx(sdk)));
    expect(out).toMatchObject({ code: 'TRANSACTION_FAILED', transaction_id: 'failed-1' });
    expect(out.sent).toBeUndefined();
    expect(out.how_to_fix).toMatch(/botwallet_balance/);
    expect(sdk.frostSignInit).not.toHaveBeenCalled();
  });

  it('does not sign a payment that is already being sent', async () => {
    const sdk = fakeSdk();
    sdk.confirmPayment.mockRejectedValue(
      new BotWalletError('INVALID_STATUS', 'Cannot confirm transaction with status: pending'));
    const out = parseResult(await confirmPayment.handler({ transaction_id: 'pending-1' }, makeCtx(sdk)));
    expect(out).toMatchObject({ code: 'OUTCOME_UNKNOWN', transaction_id: 'pending-1' });
    expect(sdk.frostSignInit).not.toHaveBeenCalled();
  });

  it('does not sign a payment that is being signed and sent right now, nor say nothing was sent', async () => {
    const sdk = fakeSdk();
    sdk.confirmPayment.mockRejectedValue(new BotWalletError('SIGNING_IN_PROGRESS',
      'This payment is being signed and sent right now',
      'Do not pay again. Check its status in about a minute with: botwallet pay list --id busy-1',
      { transaction_id: 'busy-1', status: 'pending', check_command: 'botwallet pay list --id busy-1' }));
    const out = parseResult(await confirmPayment.handler({ transaction_id: 'busy-1' }, makeCtx(sdk)));
    expect(out).toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      transaction_id: 'busy-1',
      check_tool: 'botwallet_list_payments',
      check_args: { transaction_id: 'busy-1' },
    });
    expect(out.sent).toBeUndefined();
    expect(sdk.frostSignInit).not.toHaveBeenCalled();
  });

  it('reports a payment sent earlier and still confirming as pending, without signing again', async () => {
    const sdk = fakeSdk();
    sdk.confirmPayment.mockRejectedValue(sentUnconfirmedError('sent-1'));
    const result = await confirmPayment.handler({ transaction_id: 'sent-1' }, makeCtx(sdk));
    const out = parseResult(result);
    expect(result.isError).toBeUndefined();
    expect(out).toMatchObject({ status: 'pending', sent: true, transaction_id: 'sent-1', solana_signature: SENT_SIGNATURE });
    expect(sdk.frostSignInit).not.toHaveBeenCalled();
  });

  it('reports a payment sent by another round as pending or paid, never as not sent', async () => {
    const sdk = fakeSdk();
    const id = newId('pay');
    sdk.confirmPayment.mockImplementation(async () => confirmAnswer(id));

    // frost_sign_init answers for a payment that was sent in the meantime
    sdk.frostSignInit.mockRejectedValueOnce(sentUnconfirmedError(id));
    const pending = parseResult(await confirmPayment.handler({ transaction_id: id }, makeCtx(sdk)));
    expect(pending).toMatchObject({ status: 'pending', sent: true, transaction_id: id });

    sdk.frostSignComplete.mockRejectedValueOnce(
      new BotWalletError('ALREADY_COMPLETED', 'This payment was already sent and confirmed'));
    const done = parseResult(await confirmPayment.handler({ transaction_id: id }, makeCtx(sdk)));
    expect(done).toMatchObject({ paid: true, already_completed: true, transaction_id: id });
    expect(done.sent).toBeUndefined();
  });

  it('when the owner froze the wallet, says nothing was sent and which tool finishes it later', async () => {
    const sdk = fakeSdk();
    const id = newId('pay');
    sdk.confirmPayment.mockRejectedValueOnce(frozenError());
    const atConfirm = parseResult(await confirmPayment.handler({ transaction_id: id }, makeCtx(sdk)));
    expect(atConfirm).toMatchObject({ code: 'WALLET_SUSPENDED', sent: false, transaction_id: id });
    expect(atConfirm.how_to_fix).toMatch(/unfreeze/);
    expect(atConfirm.how_to_fix).toMatch(/call botwallet_confirm_payment with this transaction_id/);
    expect(sdk.frostSignInit).not.toHaveBeenCalled();

    // Frozen between preparing and signing: turned away before anything was sent
    sdk.confirmPayment.mockImplementation(async () => confirmAnswer(id));
    sdk.frostSignComplete.mockRejectedValueOnce(frozenError());
    const atSigning = parseResult(await confirmPayment.handler({ transaction_id: id }, makeCtx(sdk)));
    expect(atSigning).toMatchObject({ code: 'WALLET_SUSPENDED', sent: false, transaction_id: id });
    expect(atSigning.how_to_fix).toMatch(/call botwallet_confirm_payment with this transaction_id/);
  });

  it('leaves a transfer the owner started on the signing page to the owner', async () => {
    const sdk = fakeSdk();
    sdk.confirmPayment.mockRejectedValue(new BotWalletError('INVALID_STATUS',
      'This transfer was started by the wallet owner on the signing page, and only the owner can finish it there',
      'Leave it to the owner. Check it with: botwallet pay list --id own-1',
      { transaction_id: 'own-1', status: 'pending' }));
    const out = parseResult(await confirmPayment.handler({ transaction_id: 'own-1' }, makeCtx(sdk)));
    expect(out).toMatchObject({
      code: 'INVALID_STATUS',
      transaction_id: 'own-1',
      check_tool: 'botwallet_list_payments',
      check_args: { transaction_id: 'own-1' },
    });
    expect(out.how_to_fix).toMatch(/Leave it to your owner/);
    expect(out.how_to_fix).not.toMatch(/botwallet pay list/);
    // The owner may still send it
    expect(out.sent).toBeUndefined();
    expect(sdk.frostSignInit).not.toHaveBeenCalled();
  });

  it('without a record from this session, checks against the server\'s own figures', async () => {
    const sdk = fakeSdk();
    const id = newId('pay');
    sdk.confirmPayment.mockImplementationOnce(async () => confirmAnswer(id, { amount: 9_000_000n, declaredAmountUsd: 5 }));
    expect(parseResult(await confirmPayment.handler({ transaction_id: id }, makeCtx(sdk))).code).toBe('TRANSACTION_MISMATCH');

    sdk.confirmPayment.mockImplementationOnce(async () => confirmAnswer(id, { declaredTo: ATTACKER }));
    expect(parseResult(await confirmPayment.handler({ transaction_id: id }, makeCtx(sdk))).code).toBe('TRANSACTION_MISMATCH');

    sdk.confirmPayment.mockImplementationOnce(async () => confirmAnswer(id));
    expect(parseResult(await confirmPayment.handler({ transaction_id: id }, makeCtx(sdk)))).toMatchObject({ paid: true });
  });

  it('turns away a second request for a payment that is being signed', async () => {
    const sdk = fakeSdk();
    const id = newId('pay');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    sdk.confirmPayment.mockImplementation(async () => {
      await gate;
      return confirmAnswer(id);
    });

    const first = confirmPayment.handler({ transaction_id: id }, makeCtx(sdk));
    const second = parseResult(await confirmPayment.handler({ transaction_id: id }, makeCtx(sdk)));
    expect(second.code).toBe('OUTCOME_UNKNOWN');
    expect(second.message).toMatch(/already being signed/);

    release();
    expect(parseResult(await first)).toMatchObject({ paid: true, transaction_id: id });
    expect(sdk.confirmPayment).toHaveBeenCalledTimes(1);
  });
});

describe('with a config.json that cannot be read', () => {
  // config.json records the wallet's address, which Key 1 checks the server's group key against
  const configFile = () => path.join(testHome, '.botwallet', 'config.json');
  let saved: string;

  beforeEach(() => {
    saved = fs.readFileSync(configFile(), 'utf-8');
    fs.writeFileSync(configFile(), '{ not json');
  });

  afterEach(() => {
    fs.writeFileSync(configFile(), saved);
  });

  it('Key 1 signs no payment, before Botwallet prepares anything', async () => {
    const sdk = fakeSdk();
    const id = newId('pay');
    sdk.confirmPayment.mockImplementation(async () => confirmAnswer(id));

    const result = await confirmPayment.handler({ transaction_id: id }, makeCtx(sdk));
    const out = parseResult(result);

    expect(result.isError).toBe(true);
    expect(out).toMatchObject({ code: 'CONFIG_ERROR', sent: false, transaction_id: id });
    expect(out.message).toMatch(/is not valid JSON/);
    expect(out.how_to_fix).toMatch(/call botwallet_confirm_payment again with this transaction_id/);
    expect(sdk.confirmPayment).not.toHaveBeenCalled();
    expect(sdk.frostSignInit).not.toHaveBeenCalled();
  });

  it('Key 1 signs no paid API call, before Botwallet prepares anything', async () => {
    const sdk = fakeSdk();

    const out = parseResult(await x402PayAndFetch.handler({ fetch_id: 'fx-config' }, makeCtx(sdk)));

    expect(out).toMatchObject({ code: 'CONFIG_ERROR', sent: false, fetch_id: 'fx-config' });
    expect(out.how_to_fix).toMatch(/botwallet_x402_pay_and_fetch again with the same fetch_id/);
    expect(sdk.x402Confirm).not.toHaveBeenCalled();
  });
});

describe('botwallet_withdraw', () => {
  it('checks for Key 1 before asking for a withdrawal', async () => {
    const sdk = fakeSdk();
    const out = parseResult(await withdraw.handler(
      { amount: 5, to_address: RECIPIENT, reason: 'payout' }, makeCtx(sdk, { hasSeed: false, walletName: undefined })));
    expect(out.code).toBe('NO_LOCAL_SEED');
    expect(sdk.withdraw).not.toHaveBeenCalled();
  });

  it('refuses a to_address that is not a Solana address before asking for a withdrawal', async () => {
    // Base58 but 33 bytes (the CLI's test value), and characters base58 doesn't have
    for (const to_address of ['z'.repeat(44), '0OIl'.repeat(10)]) {
      const sdk = fakeSdk();
      const result = await withdraw.handler({ amount: 5, to_address, reason: 'payout' }, makeCtx(sdk));
      expect(result.isError).toBe(true);
      expect(parseResult(result)).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Invalid Solana address format' });
      expect(sdk.withdraw).not.toHaveBeenCalled();
    }
  });

  it('signs only the approved amount to the approved address', async () => {
    const sdk = fakeSdk();
    const id = newId('wd');
    sdk.withdraw.mockResolvedValue({
      status: 'awaiting_approval', withdrawal_id: id, approval_id: 'ap-2', amount_usdc: 5, network_fee_usdc: 0.15,
      to_address: RECIPIENT,
    });
    const waiting = parseResult(await withdraw.handler({ amount: 5, to_address: RECIPIENT, reason: 'payout' }, makeCtx(sdk)));
    expect(waiting).toMatchObject({ needs_approval: true, transaction_id: id, withdrawal_id: id });
    expect(waiting.idempotency_key).toBeTruthy();

    sdk.confirmWithdrawal.mockImplementationOnce(async () => confirmAnswer(id, { toWallet: ATTACKER, fee: 150_000n }));
    const refused = parseResult(await confirmWithdrawal.handler({ transaction_id: id }, makeCtx(sdk)));
    expect(refused).toMatchObject({ code: 'TRANSACTION_MISMATCH', sent: false });

    sdk.confirmWithdrawal.mockImplementationOnce(async () => confirmAnswer(id, { fee: 150_000n }));
    const done = parseResult(await confirmWithdrawal.handler({ transaction_id: id }, makeCtx(sdk)));
    expect(done).toMatchObject({ withdrawn: true, transaction_id: id, withdrawal_id: id });
    expect(done.paid).toBeUndefined();
  });

  it('reports a withdrawal listed as failed without promising nothing was sent', async () => {
    const sdk = fakeSdk();
    sdk.confirmWithdrawal.mockRejectedValue(
      new BotWalletError('WITHDRAWAL_FAILED', 'This withdrawal previously failed', 'Create a new withdrawal request'));
    const out = parseResult(await confirmWithdrawal.handler({ transaction_id: 'wd-failed' }, makeCtx(sdk)));
    expect(out).toMatchObject({ code: 'WITHDRAWAL_FAILED', withdrawal_id: 'wd-failed' });
    expect(out.sent).toBeUndefined();
    expect(out.how_to_fix).toMatch(/botwallet_balance/);
    expect(out.how_to_fix).toMatch(/botwallet_withdraw\b/);
  });

  it('after a lost answer once Key 1 signed, points to botwallet_get_withdrawal', async () => {
    const sdk = fakeSdk();
    const id = newId('wd');
    sdk.confirmWithdrawal.mockImplementation(async () => confirmAnswer(id, { fee: 150_000n }));
    sdk.frostSignComplete.mockRejectedValue(new NetworkError('socket hang up'));

    const out = parseResult(await confirmWithdrawal.handler({ transaction_id: id }, makeCtx(sdk)));
    expect(out).toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      check_tool: 'botwallet_get_withdrawal',
      check_args: { withdrawal_id: id },
    });
  });

  it('reports a withdrawal sent but not confirmed yet as pending, checked with botwallet_get_withdrawal', async () => {
    const sdk = fakeSdk();
    const id = newId('wd');
    sdk.confirmWithdrawal.mockImplementation(async () => confirmAnswer(id, { fee: 150_000n }));
    sdk.frostSignComplete.mockRejectedValue(sentUnconfirmedError(id, 'withdrawal', `botwallet withdraw get ${id}`));

    const result = await confirmWithdrawal.handler({ transaction_id: id }, makeCtx(sdk));
    const out = parseResult(result);
    expect(result.isError).toBeUndefined();
    expect(out).toMatchObject({
      status: 'pending',
      sent: true,
      transaction_id: id,
      withdrawal_id: id,
      solana_signature: SENT_SIGNATURE,
      check_tool: 'botwallet_get_withdrawal',
      check_args: { withdrawal_id: id },
    });
    expect(out.withdrawn).toBeUndefined();
    expect(out.next_step).toMatch(/Do not call botwallet_withdraw again/);
  });
});


describe('x402 paid APIs', () => {
  const API_URL = 'https://api.example.com/data';
  const CAIP2_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

  /** A v1 402 body, as x402 APIs send it. */
  function paymentRequired(accepts: Record<string, unknown>[] = [{
    scheme: 'exact', network: 'solana', maxAmountRequired: '10000', payTo: MERCHANT, asset: USDC_MAINNET,
    description: 'Weather data',
  }]) {
    return Response.json({ x402Version: 1, error: 'X-PAYMENT header is required', accepts }, { status: 402 });
  }

  function stubApi(paid: () => Promise<Response>, unpaid: () => Response = () => paymentRequired()) {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (new Headers(init?.headers).get('x-payment')) return paid();
      return unpaid();
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function preparedAnswer(fetchId: string) {
    return {
      fetch_id: fetchId, status: 'pre_approved', amount_usdc: 0.01, fee_usdc: 0.01, total_usdc: 0.02,
      pay_to: MERCHANT, network: 'solana',
    };
  }

  async function probe(sdk: ReturnType<typeof fakeSdk>, fetchId: string) {
    sdk.x402Prepare.mockResolvedValue(preparedAnswer(fetchId));
    const out = parseResult(await x402Fetch.handler({ url: API_URL }, makeCtx(sdk)));
    expect(out).toMatchObject({ payment_required: true, fetch_id: fetchId });
  }

  function x402ConfirmAnswer(fetchId: string, t: ServerTransfer & { url?: string } = {}) {
    return {
      ...confirmAnswer(fetchId, { amount: 10_000n, fee: 100n, toWallet: MERCHANT, ...t }),
      url: t.url ?? API_URL,
      method: 'GET',
      pay_to: t.declaredTo ?? t.toWallet ?? MERCHANT,
      amount_usdc: 0.01,
      fee_usdc: 0.01,
    };
  }

  /** The request that carried the payment. */
  function paidCall(fetchMock: ReturnType<typeof stubApi>) {
    const call = fetchMock.mock.calls.find(([, init]) => new Headers(init?.headers).get('x-payment'));
    return call && { url: call[0], init: call[1]!, xPayment: new Headers(call[1]?.headers).get('x-payment') };
  }

  describe('botwallet_x402_fetch', () => {
    it('reads the price from a standard 402 and prepares it the way the CLI does', async () => {
      const sdk = fakeSdk();
      const fetchId = newId('fx');
      stubApi(async () => Response.json({}), () => paymentRequired([
        { scheme: 'exact', network: 'base', maxAmountRequired: '10000', payTo: '0xabc', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
        { scheme: 'exact', network: CAIP2_MAINNET, amount: '25000', payTo: MERCHANT, asset: USDC_MAINNET },
      ]));
      sdk.x402Prepare.mockResolvedValue(preparedAnswer(fetchId));

      const out = parseResult(await x402Fetch.handler({ url: API_URL }, makeCtx(sdk)));
      expect(out).toMatchObject({ payment_required: true, fetch_id: fetchId, url: API_URL });
      expect(sdk.x402Prepare).toHaveBeenCalledWith({
        url: API_URL, pay_to: MERCHANT, amount: '25000', network: 'solana', method: 'GET',
        asset: USDC_MAINNET, scheme: 'exact',
      });
    });

    it('reads a v2 402 from the Payment-Required header', async () => {
      const sdk = fakeSdk();
      const header = Buffer.from(JSON.stringify({
        x402Version: 2,
        accepts: [{ scheme: 'exact', network: CAIP2_MAINNET, amount: '10000', payTo: MERCHANT, asset: USDC_MAINNET }],
      })).toString('base64');
      stubApi(async () => Response.json({}), () => new Response(null, { status: 402, headers: { 'payment-required': header } }));
      sdk.x402Prepare.mockResolvedValue(preparedAnswer(newId('fx')));

      await x402Fetch.handler({ url: API_URL }, makeCtx(sdk));
      expect(sdk.x402Prepare).toHaveBeenCalledWith(expect.objectContaining({ pay_to: MERCHANT, amount: '10000', network: 'solana' }));
    });

    it('does not prepare a payment the API prices in another token', async () => {
      const sdk = fakeSdk();
      stubApi(async () => Response.json({}), () => paymentRequired([
        { scheme: 'exact', network: 'solana', maxAmountRequired: '1000000', payTo: MERCHANT, asset: 'So11111111111111111111111111111111111111112' },
      ]));

      const out = parseResult(await x402Fetch.handler({ url: API_URL }, makeCtx(sdk)));
      expect(out).toMatchObject({ payment_required: true, compatible: false, available_networks: ['solana'] });
      expect(out.error).toMatch(/USDC on Solana/);
      expect(sdk.x402Prepare).not.toHaveBeenCalled();
    });

    it('does not prepare a payment for a plain HTTP API', async () => {
      const sdk = fakeSdk();
      stubApi(async () => Response.json({}));

      const out = parseResult(await x402Fetch.handler({ url: 'http://api.example.com/data' }, makeCtx(sdk)));
      expect(out).toMatchObject({ payment_required: true, status: 402 });
      expect(out.error).toMatch(/HTTPS/);
      expect(sdk.x402Prepare).not.toHaveBeenCalled();
    });

    it('does not prepare a payment another host asks for after a redirect', async () => {
      const sdk = fakeSdk();
      const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
        if (url === API_URL) {
          return new Response(null, { status: 302, headers: { location: 'https://pay.other.example/data' } });
        }
        return paymentRequired();
      });
      vi.stubGlobal('fetch', fetchMock);

      const out = parseResult(await x402Fetch.handler(
        { url: API_URL, headers: { Authorization: 'Bearer for-api-example-com' } }, makeCtx(sdk)));
      expect(out).toMatchObject({ payment_required: true, status: 402, url: 'https://pay.other.example/data' });
      expect(out.error).toMatch(/api\.example\.com redirected to another host, pay\.other\.example\. Nothing was prepared or paid/);
      expect(out.error).toMatch(/probe its URL directly/);
      expect(out.fetch_id).toBeUndefined();
      expect(sdk.x402Prepare).not.toHaveBeenCalled();
      // The probe itself kept the credential from the other host
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('authorization')).toBeNull();
    });

    it('still prepares a payment after a redirect on the same host', async () => {
      const sdk = fakeSdk();
      const fetchId = newId('fx');
      vi.stubGlobal('fetch', vi.fn(async (url: string, _init?: RequestInit) => {
        if (url === API_URL) return new Response(null, { status: 307, headers: { location: '/v2/data' } });
        return paymentRequired();
      }));
      sdk.x402Prepare.mockResolvedValue(preparedAnswer(fetchId));

      const out = parseResult(await x402Fetch.handler({ url: API_URL }, makeCtx(sdk)));
      expect(out).toMatchObject({ payment_required: true, fetch_id: fetchId, url: 'https://api.example.com/v2/data' });
      expect(sdk.x402Prepare).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://api.example.com/v2/data' }));
    });

    it('refuses to probe a local address', async () => {
      const fetchMock = stubApi(async () => Response.json({}));
      const result = await x402Fetch.handler({ url: 'http://169.254.169.254/latest/meta-data/' }, makeCtx(fakeSdk()));
      expect(result.isError).toBe(true);
      expect(parseResult(result).message).toMatch(/private or local/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns a free answer even when its JSON is broken', async () => {
      stubApi(async () => Response.json({}),
        () => new Response('{"broken":', { headers: { 'content-type': 'application/json' } }));
      const out = parseResult(await x402Fetch.handler({ url: API_URL }, makeCtx(fakeSdk())));
      expect(out).toMatchObject({ payment_required: false, status: 200, content: '{"broken":' });
    });
  });

  describe('botwallet_x402_pay_and_fetch', () => {
    it('pays the API its own price and returns the content', async () => {
      const sdk = fakeSdk();
      const fetchId = newId('fx');
      const fetchMock = stubApi(async () => Response.json({ answer: 42 }));
      await probe(sdk, fetchId);
      sdk.x402Confirm.mockImplementation(async () => x402ConfirmAnswer(fetchId));

      const out = parseResult(await x402PayAndFetch.handler({ fetch_id: fetchId }, makeCtx(sdk)));
      expect(out).toMatchObject({ success: true, status: 200, fetch_id: fetchId });
      expect(out.content).toContain('42');
      expect(sdk.x402Settle).toHaveBeenCalledWith({ fetch_id: fetchId, success: true, response_status: 200 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('sends the payment header in the CLI format, last, and only to this URL', async () => {
      const sdk = fakeSdk();
      const fetchId = newId('fx');
      const fetchMock = stubApi(async () => Response.json({ answer: 42 }));
      await probe(sdk, fetchId);
      sdk.x402Confirm.mockImplementation(async () => x402ConfirmAnswer(fetchId));

      await x402PayAndFetch.handler({ fetch_id: fetchId, headers: { 'X-PAYMENT': 'forged' } }, makeCtx(sdk));
      const paid = paidCall(fetchMock)!;
      expect(paid.url).toBe(API_URL);
      expect(paid.xPayment).toBe(
        '{"network":"mainnet-beta","payload":{"signature":"AQID","transaction":"AQID"},"scheme":"exact","x402Version":1}');
      expect(paid.init.redirect).toBe('manual');
    });

    it('pays a price whose fee the server rounds down in the quote', async () => {
      // $1.49 at 1%: quoted $0.01, but the fee transfer is $0.0149
      const sdk = fakeSdk();
      const fetchId = newId('fx');
      const price = 1_490_000n;
      const fees = serverX402Fees(price, 100);
      stubApi(async () => Response.json({ answer: 42 }), () => paymentRequired([
        { scheme: 'exact', network: 'solana', maxAmountRequired: String(price), payTo: MERCHANT, asset: USDC_MAINNET },
      ]));
      sdk.x402Prepare.mockResolvedValue({ ...preparedAnswer(fetchId), amount_usdc: 1.49, fee_usdc: 0.01, total_usdc: 1.5 });
      await x402Fetch.handler({ url: API_URL }, makeCtx(sdk));
      sdk.x402Confirm.mockImplementation(async () => ({
        ...x402ConfirmAnswer(fetchId, { amount: price, fee: fees.transfer }),
        amount_usdc: 1.49,
        fee_usdc: Number(fees.quoted) / 1e6,
      }));

      const out = parseResult(await x402PayAndFetch.handler({ fetch_id: fetchId }, makeCtx(sdk)));
      expect(out).toMatchObject({ success: true, status: 200, fetch_id: fetchId });
      expect(sdk.x402SignComplete).toHaveBeenCalledTimes(1);
    });

    it('reports an API call paid earlier as paid, without paying again', async () => {
      const sdk = fakeSdk();
      const fetchMock = stubApi(async () => Response.json({ answer: 42 }));
      sdk.x402Confirm.mockRejectedValue(
        new BotWalletError('ALREADY_COMPLETED', 'This x402 payment has already been completed'));

      const result = await x402PayAndFetch.handler({ fetch_id: 'fx-done' }, makeCtx(sdk));
      const out = parseResult(result);
      expect(result.isError).toBeUndefined();
      expect(out).toMatchObject({ already_paid: true, fetch_id: 'fx-done' });
      expect(out.sent).toBeUndefined();
      expect(out.next_steps).toMatch(/botwallet_x402_fetch/);
      expect(sdk.frostSignInit).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports an API call listed as failed as unknown, and says to check the balance', async () => {
      const sdk = fakeSdk();
      const fetchMock = stubApi(async () => Response.json({ answer: 42 }));
      sdk.x402Confirm.mockRejectedValue(
        new BotWalletError('TRANSACTION_FAILED', 'This x402 payment previously failed', 'Create a new fetch'));

      const out = parseResult(await x402PayAndFetch.handler({ fetch_id: 'fx-failed' }, makeCtx(sdk)));
      expect(out).toMatchObject({ code: 'OUTCOME_UNKNOWN', fetch_id: 'fx-failed', check_tool: 'botwallet_balance' });
      expect(out.sent).toBeUndefined();
      expect(out.how_to_fix).toMatch(/two minutes/);
      expect(sdk.frostSignInit).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('says nothing was paid when the call is still waiting for approval', async () => {
      const sdk = fakeSdk();
      sdk.x402Confirm.mockRejectedValue(
        new BotWalletError('AWAITING_APPROVAL', 'This x402 payment is waiting for owner approval'));
      const out = parseResult(await x402PayAndFetch.handler({ fetch_id: 'fx-waiting' }, makeCtx(sdk)));
      expect(out).toMatchObject({ code: 'AWAITING_APPROVAL', sent: false, fetch_id: 'fx-waiting' });
    });

    it('when the owner froze the wallet, says nothing was paid and that the same fetch_id works later', async () => {
      const sdk = fakeSdk();
      const fetchId = newId('fx');
      const fetchMock = stubApi(async () => Response.json({ answer: 42 }));

      sdk.x402Confirm.mockRejectedValueOnce(frozenError());
      const atConfirm = parseResult(await x402PayAndFetch.handler({ fetch_id: fetchId }, makeCtx(sdk)));
      expect(atConfirm).toMatchObject({ code: 'WALLET_SUSPENDED', sent: false, fetch_id: fetchId });
      expect(atConfirm.how_to_fix).toMatch(/unfreeze/);
      expect(atConfirm.how_to_fix).toMatch(/botwallet_x402_pay_and_fetch again with the same fetch_id/);

      sdk.x402Confirm.mockImplementation(async () => x402ConfirmAnswer(fetchId));
      sdk.x402SignComplete.mockRejectedValueOnce(frozenError());
      const atSigning = parseResult(await x402PayAndFetch.handler({ fetch_id: fetchId }, makeCtx(sdk)));
      expect(atSigning).toMatchObject({ code: 'WALLET_SUSPENDED', sent: false, fetch_id: fetchId });
      expect(atSigning.how_to_fix).toMatch(/unfreeze/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses to pay a plain HTTP URL before Key 1 signs anything', async () => {
      const sdk = fakeSdk();
      const fetchId = newId('fx');
      const fetchMock = stubApi(async () => Response.json({ answer: 42 }));
      sdk.x402Confirm.mockImplementation(async () => x402ConfirmAnswer(fetchId, { url: 'http://api.example.com/data' }));

      const out = parseResult(await x402PayAndFetch.handler({ fetch_id: fetchId }, makeCtx(sdk)));
      expect(out).toMatchObject({ sent: false, fetch_id: fetchId, transaction_id: fetchId });
      expect(out.message).toMatch(/HTTPS/);
      expect(sdk.frostSignInit).not.toHaveBeenCalled();
      expect(sdk.x402Settle).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses a payment to another address, and never sends it to the API', async () => {
      const sdk = fakeSdk();
      const fetchId = newId('fx');
      const fetchMock = stubApi(async () => Response.json({ answer: 42 }));
      await probe(sdk, fetchId);
      sdk.x402Confirm.mockImplementation(async () => x402ConfirmAnswer(fetchId, { toWallet: ATTACKER }));

      const out = parseResult(await x402PayAndFetch.handler({ fetch_id: fetchId }, makeCtx(sdk)));
      expect(out).toMatchObject({ code: 'TRANSACTION_MISMATCH', sent: false, fetch_id: fetchId });
      expect(sdk.x402SignComplete).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('after the paid request fails, records it as failed and says to check before paying again', async () => {
      const sdk = fakeSdk();
      const fetchId = newId('fx');
      stubApi(async () => { throw new TypeError('fetch failed'); });
      await probe(sdk, fetchId);
      sdk.x402Confirm.mockImplementation(async () => x402ConfirmAnswer(fetchId));

      const result = await x402PayAndFetch.handler({ fetch_id: fetchId }, makeCtx(sdk));
      const out = parseResult(result);
      expect(result.isError).toBe(true);
      expect(out).toMatchObject({
        code: 'OUTCOME_UNKNOWN', fetch_id: fetchId, transaction_id: fetchId, check_tool: 'botwallet_balance',
      });
      expect(out.how_to_fix).toMatch(/recorded this API call as failed/);
      expect(out.how_to_fix).toMatch(/botwallet_balance/);
      expect(sdk.x402Settle).toHaveBeenCalledWith({
        fetch_id: fetchId, success: false, response_status: 0, error_message: 'fetch failed',
      });
    });

    it('when recording a failed request also fails, says so', async () => {
      const sdk = fakeSdk();
      const fetchId = newId('fx');
      stubApi(async () => { throw new TypeError('fetch failed'); });
      await probe(sdk, fetchId);
      sdk.x402Confirm.mockImplementation(async () => x402ConfirmAnswer(fetchId));
      sdk.x402Settle.mockRejectedValue(new TimeoutError(30000));

      const out = parseResult(await x402PayAndFetch.handler({ fetch_id: fetchId }, makeCtx(sdk)));
      expect(out).toMatchObject({ code: 'OUTCOME_UNKNOWN', fetch_id: fetchId, transaction_id: fetchId });
      expect(out.settle_error).toMatch(/could not record/);
      expect(out.how_to_fix).not.toMatch(/recorded this API call as failed/);
    });

    it('returns a paid answer whose JSON is broken, and records the payment', async () => {
      const sdk = fakeSdk();
      const fetchId = newId('fx');
      stubApi(async () => new Response('{"answer":', { headers: { 'content-type': 'application/json' } }));
      await probe(sdk, fetchId);
      sdk.x402Confirm.mockImplementation(async () => x402ConfirmAnswer(fetchId));

      const out = parseResult(await x402PayAndFetch.handler({ fetch_id: fetchId }, makeCtx(sdk)));
      expect(out).toMatchObject({ success: true, content: '{"answer":', payment: { transaction_id: fetchId } });
      expect(sdk.x402Settle).toHaveBeenCalledWith({ fetch_id: fetchId, success: true, response_status: 200 });
    });

    it('keeps the API error answer out of what is sent to Botwallet', async () => {
      const sdk = fakeSdk();
      const fetchId = newId('fx');
      stubApi(async () => new Response('{"error":"bad token for user@example.com"}', {
        status: 500, headers: { 'content-type': 'application/json' },
      }));
      await probe(sdk, fetchId);
      sdk.x402Confirm.mockImplementation(async () => x402ConfirmAnswer(fetchId));

      const out = parseResult(await x402PayAndFetch.handler({ fetch_id: fetchId }, makeCtx(sdk)));
      expect(out).toMatchObject({ success: false, status: 500, fetch_id: fetchId });
      expect(out.content).toContain('bad token');
      expect(out.next_steps).toMatch(/botwallet_balance/);
      expect(sdk.x402Settle).toHaveBeenCalledWith({ fetch_id: fetchId, success: false, response_status: 500 });
    });

    it('still returns the API answer when recording the result fails', async () => {
      const sdk = fakeSdk();
      const fetchId = newId('fx');
      stubApi(async () => Response.json({ answer: 42 }));
      await probe(sdk, fetchId);
      sdk.x402Confirm.mockImplementation(async () => x402ConfirmAnswer(fetchId));
      sdk.x402Settle.mockRejectedValue(new TimeoutError(30000));

      const result = await x402PayAndFetch.handler({ fetch_id: fetchId }, makeCtx(sdk));
      const out = parseResult(result);
      expect(result.isError).toBeUndefined();
      expect(out.content).toContain('42');
      expect(out.settle_error).toMatch(/Do not pay for this request again/);
    });
  });
});
