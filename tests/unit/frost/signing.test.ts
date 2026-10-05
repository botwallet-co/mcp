// frostSignAndSubmit / frostSignForX402 against a fake server holding Key 2:
// Key 1 signs only after the group key and the transaction check out, and a
// lost answer after the partial signature was sent is reported as unknown.

import { describe, it, expect, vi } from 'vitest';
import { base58 } from '@scure/base';
import {
  frostSignAndSubmit,
  frostSignForX402,
  SubmitOutcomeUnknownError,
  type SigningCheck,
} from '../../../src/frost/index.js';
import { TransactionCheckError } from '../../../src/solana/index.js';
import { BotWalletError, NetworkError, TimeoutError, type BotWallet } from '../../../src/sdk/index.js';
import { FakeSigner } from '../../helpers/fake-signer.js';
import { buildServerTransfer, testAddress } from '../../helpers/solana-messages.js';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const RECIPIENT = testAddress('recipient');
const TX = 'tx-1';

function setup(messageOverrides: { amount?: bigint; toWallet?: string; wallet?: string } = {}) {
  const signer = new FakeSigner(MNEMONIC);
  const message = buildServerTransfer({
    feePayer: testAddress('fee-payer'),
    wallet: messageOverrides.wallet ?? signer.walletAddress,
    toWallet: messageOverrides.toWallet ?? RECIPIENT,
    feeCollection: testAddress('fee-collection'),
    amount: messageOverrides.amount ?? 5_000_000n,
    fee: 50_000n,
  });
  const messageB64 = signer.storeMessage(TX, message);
  const sdk = {
    frostSignInit: vi.fn(async (p: { transaction_id: string; nonce_commitment: string }) => signer.frostSignInit(p)),
    frostSignComplete: vi.fn(async (p: { session_id: string; partial_sig: string }) => {
      const done = signer.complete(p);
      return { paid: true, transaction_id: done.transactionId, solana_signature: base58.encode(done.signature) };
    }),
    x402SignComplete: vi.fn(async (p: { session_id: string; partial_sig: string }) => {
      signer.complete(p);
      return { signed_transaction: 'c2lnbmVk' };
    }),
  };
  const check: SigningCheck = {
    walletAddress: signer.walletAddress,
    transfer: { kind: 'payment', network: 'mainnet-beta', amount: 5_000_000n, recipient: RECIPIENT, quotedFee: 50_000n },
  };
  return { signer, sdk, messageB64, check, wallet: sdk as unknown as BotWallet };
}

describe('frostSignAndSubmit', () => {
  it('signs the agreed transfer; the aggregated signature is valid for the wallet', async () => {
    const { signer, sdk, wallet, messageB64, check } = setup();
    const result = await frostSignAndSubmit(wallet, MNEMONIC, TX, messageB64, check);
    expect(result.paid).toBe(true);
    expect(sdk.frostSignComplete).toHaveBeenCalledTimes(1);
    expect(signer.completed).toHaveLength(1);
  });

  it('signs when config.json has no address, checking the message against the group key', async () => {
    const { signer, wallet, messageB64, check } = setup();
    await frostSignAndSubmit(wallet, MNEMONIC, TX, messageB64, { ...check, walletAddress: undefined });
    expect(signer.completed).toHaveLength(1);
  });

  it('refuses a group key that is not this wallet', async () => {
    const { sdk, wallet, messageB64, check } = setup();
    const err = await frostSignAndSubmit(wallet, MNEMONIC, TX, messageB64, {
      ...check,
      walletAddress: testAddress('another-wallet'),
    }).catch(e => e);
    expect(err).toBeInstanceOf(TransactionCheckError);
    expect(err.code).toBe('WALLET_MISMATCH');
    expect(sdk.frostSignComplete).not.toHaveBeenCalled();
  });

  it('refuses a transaction for more than agreed, before any partial signature is sent', async () => {
    const { sdk, wallet, messageB64, check } = setup({ amount: 500_000_000n });
    const err = await frostSignAndSubmit(wallet, MNEMONIC, TX, messageB64, check).catch(e => e);
    expect(err).toBeInstanceOf(TransactionCheckError);
    expect(err.code).toBe('TRANSACTION_MISMATCH');
    expect(sdk.frostSignComplete).not.toHaveBeenCalled();
  });

  it('refuses a transaction to someone else', async () => {
    const { sdk, wallet, messageB64, check } = setup({ toWallet: testAddress('attacker') });
    await expect(frostSignAndSubmit(wallet, MNEMONIC, TX, messageB64, check)).rejects.toBeInstanceOf(TransactionCheckError);
    expect(sdk.frostSignComplete).not.toHaveBeenCalled();
  });

  it('refuses when the stored message differs from the one checked', async () => {
    const { signer, sdk, wallet, messageB64, check } = setup();
    signer.storeMessage(TX, buildServerTransfer({
      feePayer: testAddress('fee-payer'),
      wallet: signer.walletAddress,
      toWallet: testAddress('attacker'),
      feeCollection: testAddress('fee-collection'),
      amount: 5_000_000n,
      fee: 50_000n,
    }));
    const err = await frostSignAndSubmit(wallet, MNEMONIC, TX, messageB64, check).catch(e => e);
    expect(err).toBeInstanceOf(TransactionCheckError);
    expect(err.message).toMatch(/changed/);
    expect(sdk.frostSignComplete).not.toHaveBeenCalled();
  });

  it('reports a timeout or lost connection after the partial signature as an unknown outcome', async () => {
    for (const failure of [new TimeoutError(30000), new NetworkError('socket hang up'), new Error('boom'),
      new BotWalletError('INTERNAL_ERROR', 'Failed to update')]) {
      const { sdk, wallet, messageB64, check } = setup();
      sdk.frostSignComplete.mockRejectedValueOnce(failure);
      const err = await frostSignAndSubmit(wallet, MNEMONIC, TX, messageB64, check).catch(e => e);
      expect(err).toBeInstanceOf(SubmitOutcomeUnknownError);
    }
  });

  it('passes on answers that mean nothing was sent', async () => {
    for (const code of ['SESSION_EXPIRED', 'INVALID_PARTIAL_SIG', 'WALLET_SUSPENDED']) {
      const { sdk, wallet, messageB64, check } = setup();
      sdk.frostSignComplete.mockRejectedValueOnce(new BotWalletError(code as never, 'no'));
      const err = await frostSignAndSubmit(wallet, MNEMONIC, TX, messageB64, check).catch(e => e);
      expect(err).toBeInstanceOf(BotWalletError);
      expect(err).not.toBeInstanceOf(SubmitOutcomeUnknownError);
      expect(err.code).toBe(code);
    }
  });

  it('passes on answers that say the transaction was sent, confirmed or not yet', async () => {
    for (const code of ['SUBMISSION_UNCONFIRMED', 'ALREADY_COMPLETED']) {
      const { sdk, wallet, messageB64, check } = setup();
      sdk.frostSignComplete.mockRejectedValueOnce(new BotWalletError(code as never, 'sent', undefined,
        { transaction_id: TX, solana_signature: 'sig' }));
      const err = await frostSignAndSubmit(wallet, MNEMONIC, TX, messageB64, check).catch(e => e);
      expect(err).toBeInstanceOf(BotWalletError);
      expect(err).not.toBeInstanceOf(SubmitOutcomeUnknownError);
      expect(err.code).toBe(code);
      expect(err.details).toMatchObject({ solana_signature: 'sig' });
    }
  });

  it('passes on TRANSACTION_FAILED when Solana turned the transaction down before taking it', async () => {
    const answers: Array<[string, string | undefined]> = [
      ['Transaction simulation failed: Blockhash not found', 'The FROST signature may be invalid or the transaction expired. Create a new payment.'],
      ['Transaction signature verification failure', undefined],
      ['The transaction expired before it reached the chain', 'Nothing was sent, so no money moved. Create a new payment if you still need it.'],
    ];
    for (const [message, howToFix] of answers) {
      const { sdk, wallet, messageB64, check } = setup();
      sdk.frostSignComplete.mockRejectedValueOnce(new BotWalletError('TRANSACTION_FAILED' as never, message, howToFix));
      const err = await frostSignAndSubmit(wallet, MNEMONIC, TX, messageB64, check).catch(e => e);
      expect(err).toBeInstanceOf(BotWalletError);
      expect(err).not.toBeInstanceOf(SubmitOutcomeUnknownError);
      expect(err.code).toBe('TRANSACTION_FAILED');
    }
  });

  it('reports other TRANSACTION_FAILED answers as unknown, since the transaction may have been sent', async () => {
    // Older servers also mark the payment failed when the request to Solana breaks off
    for (const message of [
      'error sending request for url: connection closed before message completed',
      'Unexpected end of JSON input',
      'Transaction simulation failed: This transaction has already been processed',
    ]) {
      const { sdk, wallet, messageB64, check } = setup();
      sdk.frostSignComplete.mockRejectedValueOnce(new BotWalletError('TRANSACTION_FAILED' as never, message,
        'The FROST signature may be invalid or the transaction expired. Create a new payment.'));
      const err = await frostSignAndSubmit(wallet, MNEMONIC, TX, messageB64, check).catch(e => e);
      expect(err).toBeInstanceOf(SubmitOutcomeUnknownError);
      expect(err.markedFailed).toBe(true);
    }
  });
});

describe('frostSignForX402', () => {
  it('runs the same checks before signing', async () => {
    const { sdk, wallet, messageB64, check } = setup({ amount: 6_000_000n });
    await expect(frostSignForX402(wallet, MNEMONIC, TX, messageB64, { ...check, transfer: { ...check.transfer, kind: 'x402' } }))
      .rejects.toBeInstanceOf(TransactionCheckError);
    expect(sdk.x402SignComplete).not.toHaveBeenCalled();
  });

  it('signs the agreed API payment', async () => {
    const { signer, wallet, messageB64, check } = setup();
    const result = await frostSignForX402(wallet, MNEMONIC, TX, messageB64, { ...check, transfer: { ...check.transfer, kind: 'x402' } });
    expect(result.signed_transaction).toBeTruthy();
    expect(signer.completed).toHaveLength(1);
  });
});
