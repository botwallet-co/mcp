// The check Key 1 runs on every transaction before it signs. Messages are built
// the way the server builds them (tests/helpers/solana-messages.ts), plus the
// transactions a compromised server could try to get signed instead.

import { describe, it, expect } from 'vitest';
import { base58 } from '@scure/base';
import {
  verifyTransferMessage,
  transferExpectation,
  feeCeiling,
  usdToBaseUnits,
  TransactionCheckError,
  type ExpectedTransfer,
} from '../../../src/solana/verify-transaction.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
} from '../../../src/solana/message.js';
import {
  ata,
  buildServerTransfer,
  compileMessage,
  serverX402Fees,
  testAddress,
  transferCheckedData,
  transferData,
  USDC_DEVNET,
  USDC_MAINNET,
  type ServerTransferParams,
} from '../../helpers/solana-messages.js';

const FEE_PAYER = testAddress('fee-payer');
const WALLET = testAddress('wallet');
const RECIPIENT = testAddress('recipient');
const FEE_COLLECTION = testAddress('fee-collection');
const ATTACKER = testAddress('attacker');
const WALLET_BYTES = base58.decode(WALLET);

const AMOUNT = 5_000_000n; // $5.00
const FEE = 50_000n; // $0.05

function serverParams(overrides: Partial<ServerTransferParams> = {}): ServerTransferParams {
  return {
    feePayer: FEE_PAYER,
    wallet: WALLET,
    toWallet: RECIPIENT,
    feeCollection: FEE_COLLECTION,
    amount: AMOUNT,
    fee: FEE,
    ...overrides,
  };
}

function expected(overrides: Partial<ExpectedTransfer> = {}): ExpectedTransfer {
  return {
    kind: 'payment',
    network: 'mainnet-beta',
    amount: AMOUNT,
    recipient: RECIPIENT,
    quotedFee: FEE,
    ...overrides,
  };
}

function check(message: Uint8Array, exp: ExpectedTransfer = expected()): void {
  verifyTransferMessage(message, WALLET_BYTES, exp);
}

function refusal(message: Uint8Array, exp: ExpectedTransfer = expected()): string {
  try {
    check(message, exp);
  } catch (e) {
    expect(e).toBeInstanceOf(TransactionCheckError);
    return (e as Error).message;
  }
  throw new Error('expected the check to refuse this transaction');
}

const walletUsdc = ata(WALLET);
const recipientUsdc = ata(RECIPIENT);
const feeUsdc = ata(FEE_COLLECTION);

describe('transactions the server builds', () => {
  it('accepts a payment to an existing account', () => {
    expect(() => check(buildServerTransfer(serverParams()))).not.toThrow();
  });

  it('accepts a payment that sets up the recipient and fee accounts', () => {
    const message = buildServerTransfer(serverParams({ toAccountExists: false, feeCollectionAccountExists: false }));
    expect(() => check(message)).not.toThrow();
  });

  it('accepts a withdrawal with the 3% fee and account setup', () => {
    const fee = 150_000n + 250_000n;
    const message = buildServerTransfer(serverParams({ fee, toAccountExists: false }));
    expect(() => check(message, expected({ kind: 'withdrawal', quotedFee: fee }))).not.toThrow();
  });

  it('accepts a payment to the fee wallet itself, with the fee into the same account', () => {
    const message = buildServerTransfer(serverParams({ toWallet: FEE_COLLECTION }));
    expect(() => check(message, expected({ recipient: FEE_COLLECTION }))).not.toThrow();
  });

  it("accepts a payment from a USDC account other than the wallet's associated one (servers before Oct 2026)", () => {
    const message = buildServerTransfer(serverParams({ fromTokenAccount: testAddress('older-usdc-account') }));
    expect(() => check(message)).not.toThrow();
  });

  it('accepts an x402 payment whose exact price is only bounded by the cents figure', () => {
    // 5,000 base units ($0.005) is reported as 1 cent; the fee transfer is 1% of the price
    const message = buildServerTransfer(serverParams({ amount: 5_000n, fee: 50n }));
    expect(() => check(message, expected({ kind: 'x402', amount: 10_000n, amountRoundedUpToCent: true, quotedFee: 10_000n })))
      .not.toThrow();
  });

  it('accepts x402 fee transfers the server works out from the exact price', () => {
    // $1.49 at 1% is quoted as $0.01, but the fee transfer is $0.0149; $2.10 is quoted $0.02, sent $0.021
    for (const price of [1_490_000n, 2_100_000n]) {
      const fees = serverX402Fees(price, 100);
      expect(fees.transfer).toBeGreaterThan(fees.quoted);
      const message = buildServerTransfer(serverParams({ amount: price, fee: fees.transfer }));
      // In the session that probed the API (exact price) and after a restart (price from the cents figure)
      expect(() => check(message, expected({ kind: 'x402', amount: price, quotedFee: fees.quoted }))).not.toThrow();
      expect(() => check(message, expected({
        kind: 'x402', amount: fees.reportedPrice, amountRoundedUpToCent: true, quotedFee: fees.quoted,
      }))).not.toThrow();
    }
  });

  it('accepts every x402 fee the server builds, at 1% and at the code default of 2.5%', () => {
    // The server's fee transfer is never more than a cent over its quote...
    const over: string[] = [];
    for (const feeBps of [100, 250]) {
      for (let price = 1n; price <= 20_000_000n; price += 1_237n) {
        const fees = serverX402Fees(price, feeBps);
        if (fees.transfer > fees.quoted + 10_000n) over.push(`${price} at ${feeBps} bps`);
      }
    }
    expect(over).toEqual([]);
    // ...and Key 1 signs it: whole cents, and prices just past a cent, where the rounding is worst
    for (const feeBps of [100, 250]) {
      for (const price of [1n, 4_999n, 1_000_000n, 1_005_001n, 2_495_001n, 19_990_001n]) {
        const fees = serverX402Fees(price, feeBps);
        const message = buildServerTransfer(serverParams({ amount: price, fee: fees.transfer }));
        expect(() => check(message, expected({ kind: 'x402', amount: price, quotedFee: fees.quoted })),
          `price ${price} at ${feeBps} bps`).not.toThrow();
      }
    }
  });

  it('accepts a zero fee transfer and a fee below the quote', () => {
    expect(() => check(buildServerTransfer(serverParams({ fee: 0n })))).not.toThrow();
    expect(() => check(buildServerTransfer(serverParams({ fee: FEE - 1n })))).not.toThrow();
  });

  it('accepts devnet transfers with the devnet USDC mint', () => {
    const message = buildServerTransfer(serverParams({ mint: USDC_DEVNET }));
    expect(() => check(message, expected({ network: 'devnet' }))).not.toThrow();
  });

});

describe('transactions Key 1 refuses', () => {
  it('a different amount', () => {
    expect(refusal(buildServerTransfer(serverParams({ amount: AMOUNT + 1n })))).toMatch(/amount/);
    expect(refusal(buildServerTransfer(serverParams({ amount: AMOUNT - 1n })))).toMatch(/amount/);
    expect(refusal(buildServerTransfer(serverParams({ amount: AMOUNT * 100n })))).toMatch(/amount/);
  });

  it('an x402 price above the bound', () => {
    const message = buildServerTransfer(serverParams({ amount: 10_001n, fee: 50n }));
    expect(refusal(message, expected({ kind: 'x402', amount: 10_000n, amountRoundedUpToCent: true, quotedFee: 10_000n })))
      .toMatch(/amount/);
  });

  it('a different recipient', () => {
    expect(refusal(buildServerTransfer(serverParams({ toWallet: ATTACKER })))).toMatch(/recipient/);
  });

  it('a transfer when no recipient is known', () => {
    expect(refusal(buildServerTransfer(serverParams()), expected({ recipient: '' }))).toMatch(/recipient/);
  });

  it("a recipient account that is not the recipient's associated USDC account", () => {
    const message = buildServerTransfer(serverParams({ toTokenAccount: testAddress('other-token-account') }));
    expect(refusal(message)).toMatch(/recipient/);
  });

  it('an x402 fee more than a cent above the quote', () => {
    const fees = serverX402Fees(1_490_000n, 100);
    const exp = expected({ kind: 'x402', amount: 1_490_000n, quotedFee: fees.quoted });
    expect(() => check(buildServerTransfer(serverParams({ amount: 1_490_000n, fee: fees.quoted + 10_000n })), exp))
      .not.toThrow();
    expect(refusal(buildServerTransfer(serverParams({ amount: 1_490_000n, fee: fees.quoted + 10_001n })), exp))
      .toMatch(/fee/);
    // The rounding allowance is for paid API calls only
    expect(refusal(buildServerTransfer(serverParams({ fee: FEE + 1n })), expected({ kind: 'withdrawal' }))).toMatch(/fee/);
  });

  it('a fee above the quote or above the ceiling', () => {
    expect(refusal(buildServerTransfer(serverParams({ fee: FEE + 1n })))).toMatch(/fee/);
    const ceiling = feeCeiling('payment', AMOUNT);
    expect(refusal(buildServerTransfer(serverParams({ fee: ceiling + 1n })), expected({ quotedFee: undefined })))
      .toMatch(/fee/);
    expect(refusal(buildServerTransfer(serverParams({ fee: ceiling + 1n })), expected({ quotedFee: ceiling * 2n })))
      .toMatch(/fee/);
  });

  it('an extra transfer, even a small one', () => {
    const keys = [FEE_PAYER, WALLET, walletUsdc, recipientUsdc, feeUsdc, ata(ATTACKER), TOKEN_PROGRAM_ID];
    const message = compileMessage(keys, [
      { program: TOKEN_PROGRAM_ID, accounts: [walletUsdc, recipientUsdc, WALLET], data: transferData(AMOUNT) },
      { program: TOKEN_PROGRAM_ID, accounts: [walletUsdc, feeUsdc, WALLET], data: transferData(FEE) },
      { program: TOKEN_PROGRAM_ID, accounts: [walletUsdc, ata(ATTACKER), WALLET], data: transferData(1n) },
    ]);
    expect(refusal(message)).toMatch(/extra transfer/);
  });

  it('the fee before the payment', () => {
    const keys = [FEE_PAYER, WALLET, walletUsdc, recipientUsdc, feeUsdc, TOKEN_PROGRAM_ID];
    const message = compileMessage(keys, [
      { program: TOKEN_PROGRAM_ID, accounts: [walletUsdc, feeUsdc, WALLET], data: transferData(FEE) },
      { program: TOKEN_PROGRAM_ID, accounts: [walletUsdc, recipientUsdc, WALLET], data: transferData(AMOUNT) },
    ]);
    expect(refusal(message)).toMatch(/recipient's USDC account/);
  });

  it('the fee from another token account of the wallet (another token)', () => {
    const otherMintAccount = ata(WALLET, testAddress('other-mint'));
    const attackerAccount = ata(ATTACKER, testAddress('other-mint'));
    const keys = [FEE_PAYER, WALLET, walletUsdc, recipientUsdc, otherMintAccount, attackerAccount, TOKEN_PROGRAM_ID];
    const message = compileMessage(keys, [
      { program: TOKEN_PROGRAM_ID, accounts: [walletUsdc, recipientUsdc, WALLET], data: transferData(AMOUNT) },
      { program: TOKEN_PROGRAM_ID, accounts: [otherMintAccount, attackerAccount, WALLET], data: transferData(1n) },
    ]);
    expect(refusal(message)).toMatch(/fee paid from a different account/);
  });

  it('the devnet mint on mainnet, or an unknown network', () => {
    expect(refusal(buildServerTransfer(serverParams({ mint: USDC_DEVNET })))).toMatch(/USDC account|recipient/);
    expect(refusal(buildServerTransfer(serverParams()), expected({ network: 'testnet' }))).toMatch(/network/);
  });

  it('TransferChecked, even of USDC, which the server never builds', () => {
    for (const mint of [USDC_MAINNET, testAddress('other-mint')]) {
      const keys = [FEE_PAYER, WALLET, walletUsdc, mint, recipientUsdc, TOKEN_PROGRAM_ID];
      const message = compileMessage(keys, [
        { program: TOKEN_PROGRAM_ID, accounts: [walletUsdc, mint, recipientUsdc, WALLET], data: transferCheckedData(AMOUNT) },
      ]);
      expect(refusal(message)).toMatch(/token instruction other than a transfer/);
    }
  });

  it('priority-fee instructions, which the server never builds', () => {
    const keys = [FEE_PAYER, WALLET, walletUsdc, recipientUsdc, feeUsdc, TOKEN_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID];
    const message = compileMessage(keys, [
      { program: COMPUTE_BUDGET_PROGRAM_ID, accounts: [], data: Uint8Array.from([3, 1, 0, 0, 0, 0, 0, 0, 0]) },
      { program: TOKEN_PROGRAM_ID, accounts: [walletUsdc, recipientUsdc, WALLET], data: transferData(AMOUNT) },
      { program: TOKEN_PROGRAM_ID, accounts: [walletUsdc, feeUsdc, WALLET], data: transferData(FEE) },
    ]);
    expect(refusal(message)).toMatch(/unexpected program/);
  });

  it('a transfer some other account authorizes', () => {
    const keys = [FEE_PAYER, WALLET, walletUsdc, recipientUsdc, ATTACKER, TOKEN_PROGRAM_ID];
    const message = compileMessage(keys, [
      { program: TOKEN_PROGRAM_ID, accounts: [walletUsdc, recipientUsdc, ATTACKER], data: transferData(AMOUNT) },
    ]);
    expect(refusal(message)).toMatch(/not authorized by the wallet/);
  });

  for (const [name, data] of [
    ['Approve', Uint8Array.from([4, ...new Array(8).fill(0xff)])],
    ['SetAuthority', Uint8Array.from([6, 2, 1, ...base58.decode(ATTACKER)])],
    ['CloseAccount', Uint8Array.from([9])],
    ['Burn', Uint8Array.from([8, ...new Array(8).fill(1)])],
  ] as const) {
    it(`a token ${name} next to the payment`, () => {
      const keys = [FEE_PAYER, WALLET, walletUsdc, recipientUsdc, feeUsdc, ATTACKER, TOKEN_PROGRAM_ID];
      const message = compileMessage(keys, [
        { program: TOKEN_PROGRAM_ID, accounts: [walletUsdc, recipientUsdc, WALLET], data: transferData(AMOUNT) },
        { program: TOKEN_PROGRAM_ID, accounts: [walletUsdc, ATTACKER, WALLET], data },
      ]);
      expect(refusal(message)).toMatch(/token instruction other than a transfer/);
    });
  }

  it('a SOL transfer out of the wallet', () => {
    const keys = [FEE_PAYER, WALLET, walletUsdc, recipientUsdc, ATTACKER, TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID];
    const message = compileMessage(keys, [
      { program: TOKEN_PROGRAM_ID, accounts: [walletUsdc, recipientUsdc, WALLET], data: transferData(AMOUNT) },
      { program: SYSTEM_PROGRAM_ID, accounts: [WALLET, ATTACKER], data: Uint8Array.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) },
    ]);
    expect(refusal(message)).toMatch(/unexpected program/);
  });

  it('an unknown program', () => {
    const program = testAddress('some-program');
    const keys = [FEE_PAYER, WALLET, walletUsdc, recipientUsdc, TOKEN_PROGRAM_ID, program];
    const message = compileMessage(keys, [
      { program: TOKEN_PROGRAM_ID, accounts: [walletUsdc, recipientUsdc, WALLET], data: transferData(AMOUNT) },
      { program, accounts: [WALLET], data: new Uint8Array(0) },
    ]);
    expect(refusal(message)).toMatch(/unexpected program/);
  });

  it('account setup paid by the wallet', () => {
    const keys = [FEE_PAYER, WALLET, walletUsdc, recipientUsdc, RECIPIENT, USDC_MAINNET, SYSTEM_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID];
    const message = compileMessage(keys, [
      {
        program: ASSOCIATED_TOKEN_PROGRAM_ID,
        accounts: [WALLET, recipientUsdc, RECIPIENT, USDC_MAINNET, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID],
        data: Uint8Array.from([1]),
      },
      { program: TOKEN_PROGRAM_ID, accounts: [walletUsdc, recipientUsdc, WALLET], data: transferData(AMOUNT) },
    ]);
    expect(refusal(message)).toMatch(/not paid by the fee payer/);
  });

  it('the wallet as the fee payer, or not the second signer', () => {
    const swapped = compileMessage([WALLET, FEE_PAYER, walletUsdc, recipientUsdc, TOKEN_PROGRAM_ID], [
      { program: TOKEN_PROGRAM_ID, accounts: [walletUsdc, recipientUsdc, WALLET], data: transferData(AMOUNT) },
    ]);
    expect(refusal(swapped)).toMatch(/second signer/);

    const threeSigners = compileMessage([FEE_PAYER, WALLET, ATTACKER, walletUsdc, recipientUsdc, TOKEN_PROGRAM_ID], [
      { program: TOKEN_PROGRAM_ID, accounts: [walletUsdc, recipientUsdc, WALLET], data: transferData(AMOUNT) },
    ], { header: [3, 0, 1] });
    expect(refusal(threeSigners)).toMatch(/two signers/);
  });

  it('a versioned message, trailing bytes or an account listed twice', () => {
    const message = buildServerTransfer(serverParams());
    const versioned = Uint8Array.from([0x80, ...message]);
    expect(refusal(versioned)).toMatch(/unreadable/);
    expect(refusal(Uint8Array.from([...message, 0]))).toMatch(/unreadable/);

    const twice = compileMessage([FEE_PAYER, WALLET, walletUsdc, recipientUsdc, TOKEN_PROGRAM_ID, recipientUsdc], [
      { program: TOKEN_PROGRAM_ID, accounts: [walletUsdc, recipientUsdc, WALLET], data: transferData(AMOUNT) },
    ]);
    expect(refusal(twice)).toMatch(/listed twice/);
  });

  it('a transaction for another wallet', () => {
    const message = buildServerTransfer(serverParams({ wallet: ATTACKER }));
    expect(refusal(message)).toMatch(/second signer/);
  });
});

describe('what the agreed figures allow', () => {
  it('payments and withdrawals: exactly the amount, at most the quoted fee', () => {
    expect(transferExpectation(expected())).toEqual({
      network: 'mainnet-beta', recipient: RECIPIENT, minAmount: AMOUNT, maxAmount: AMOUNT, maxFee: FEE,
    });
  });

  it('x402: the same range and fee allowance as the CLI', () => {
    // The CLI's x402Intent for amount_usdc 0.01 and fee_usdc 0.01
    const exp = transferExpectation(expected({ kind: 'x402', amount: 10_000n, amountRoundedUpToCent: true, quotedFee: 10_000n }));
    expect([exp.minAmount, exp.maxAmount, exp.maxFee]).toEqual([1n, 10_000n, 20_000n]);
    // With the exact price this session agreed to, only that price
    const exact = transferExpectation(expected({ kind: 'x402', amount: 5_000n, quotedFee: 10_000n }));
    expect([exact.minAmount, exact.maxAmount]).toEqual([5_000n, 5_000n]);
  });

  it('no quote means no fee, and the ceiling caps any quote', () => {
    expect(transferExpectation(expected({ quotedFee: undefined })).maxFee).toBe(0n);
    expect(transferExpectation(expected({ quotedFee: AMOUNT })).maxFee).toBe(feeCeiling('payment', AMOUNT));
  });
});

describe('fee ceiling and amounts', () => {
  it('stays well above the published fees', () => {
    // 1% payment fee with the $0.01 minimum and $0.25 account setup
    expect(feeCeiling('payment', 100_000_000n)).toBeGreaterThan(1_000_000n + 250_000n);
    expect(feeCeiling('payment', 10_000n)).toBeGreaterThan(10_000n + 250_000n);
    // 3% withdrawal fee and $0.25 account setup
    expect(feeCeiling('withdrawal', 100_000_000n)).toBeGreaterThan(3_000_000n + 250_000n);
  });

  it('reads USD amounts the way the server does', () => {
    expect(usdToBaseUnits(5)).toBe(5_000_000n);
    expect(usdToBaseUnits(0.01)).toBe(10_000n);
    expect(usdToBaseUnits(1.005)).toBe(BigInt(Math.round(1.005 * 100)) * 10_000n);
    expect(usdToBaseUnits('5')).toBeNull();
    expect(usdToBaseUnits(-1)).toBeNull();
    expect(usdToBaseUnits(Number.NaN)).toBeNull();
  });
});
