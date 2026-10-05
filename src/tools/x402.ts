import { z } from 'zod';
import type { ToolContext, ToolDefinition, ToolResult } from '../types.js';
import { READ_ONLY, REACHES_OUT, MOVES_MONEY } from '../utils/annotations.js';
import { BotWalletError, type X402ConfirmResponse, type X402SettleParams } from '../sdk/index.js';
import { formatResult } from '../utils/format.js';
import {
  formatToolError,
  guardRailBlockedError,
  isNoAnswer,
  noSeedError,
  notSentError,
  outcomeUnknownError,
  signingRefusedError,
  type TransferRef,
} from '../utils/errors.js';
import { frostSignForX402, type SigningCheck } from '../frost/index.js';
import { TransactionCheckError, usdToBaseUnits } from '../solana/index.js';
import { loadSeed } from '../config/index.js';
import { agreedTransferFor, forgetAgreedTransfer, rememberAgreedTransfer } from '../utils/agreed-transfers.js';
import { expectedTransfer, localWalletAddress } from '../utils/signing-check.js';
import { withSigningLock, SigningInProgressError } from '../utils/signing-lock.js';
import {
  probeUrl,
  parse402Response,
  findSolanaOption,
  availableNetworks,
  getAmount,
  normalizeSolanaNetwork,
  requireHttps,
  checkPaidRequest,
  buildXPaymentHeader,
  fetchWithPayment,
  readResponseBody,
  displayBody,
  X402RequestError,
  type X402Requirements,
} from '../utils/x402-client.js';

const x402Discover: ToolDefinition = {
  name: 'botwallet_x402_discover',
  annotations: READ_ONLY,
  description:
    'Search for paid APIs that accept x402 payments. ' +
    'Searches a curated catalog of APIs. ' +
    'Returns API descriptions, pricing, and endpoints. ' +
    'Use this to find APIs before calling botwallet_x402_fetch to probe them.',
  inputSchema: z.object({
    query: z.string().optional()
      .describe('Search query (e.g. "weather", "translation", "image generation")'),
  }),
  async handler(args, ctx) {
    try {
      const { query } = args as { query?: string };

      // x402_catalog is a public endpoint — no auth required
      // SDK base URL is e.g. https://api.botwallet.co/v1, public is at /v1/public
      const url = new URL(`${ctx.sdk.getBaseUrl()}/public`);
      url.searchParams.set('action', 'x402_catalog');
      if (query) url.searchParams.set('query', query);

      const res = await fetch(url.toString());
      const json = await res.json() as Record<string, unknown>;

      if (json.success === false) {
        const err = json.error as Record<string, unknown> | undefined;
        return formatToolError(new Error(
          (err?.message as string) || 'Failed to query x402 catalog'
        ));
      }

      const data = (json.data || {}) as Record<string, unknown>;
      const entries = (data.entries || []) as Array<Record<string, unknown>>;

      return formatResult({
        apis: entries,
        count: entries.length,
        message: entries.length === 0
          ? 'No APIs found matching your query. Try a broader search term.'
          : `Found ${entries.length} API(s). Use botwallet_x402_fetch to probe any URL.`,
      });
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const x402Fetch: ToolDefinition = {
  name: 'botwallet_x402_fetch',
  // Not read-only: it calls the URL the agent gives and, for a paid API, prepares a payment
  annotations: REACHES_OUT,
  description:
    'Probe a URL to check if it requires x402 payment. ' +
    'If the URL returns a 200, the content is returned directly (free). ' +
    'If it returns a 402, parses the payment requirements and prepares a payment intent — ' +
    'returns the price and a `fetch_id` for use with botwallet_x402_pay_and_fetch. ' +
    'If the payment needs owner approval, returns `needs_approval: true` with an `approval_url` to send to your human owner; ' +
    'call botwallet_x402_pay_and_fetch only after they approve. ' +
    'No money is spent — this is "window shopping." ' +
    'You can probe multiple APIs to compare prices before committing. ' +
    'Botwallet pays only HTTPS APIs that accept USDC on Solana.',
  inputSchema: z.object({
    url: z.string().url()
      .describe('URL to probe. Paying needs an HTTPS URL.'),
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).optional()
      .describe('HTTP method (default: GET)'),
    headers: z.record(z.string()).optional()
      .describe('Additional HTTP headers'),
    body: z.string().optional()
      .describe('Request body (for POST/PUT)'),
  }),
  async handler(args, ctx) {
    try {
      const { url, method = 'GET', headers, body } = args as {
        url: string; method?: string; headers?: Record<string, string>; body?: string;
      };

      // After redirects: the URL (and method) that answered is the one to pay
      const probe = await probeUrl(url, method, headers, body);
      const { response } = probe;

      // Free — return content directly
      if (response.ok) {
        const { text, truncated } = await readResponseBody(response);
        return formatResult({
          payment_required: false,
          status: response.status,
          content: displayBody(response.headers.get('content-type'), text),
          ...(truncated ? { truncated: true } : {}),
        });
      }

      // 402 Payment Required
      if (response.status === 402) {
        let requirements: X402Requirements;
        try {
          requirements = await parse402Response(response);
        } catch (e) {
          return formatResult({
            payment_required: true,
            status: 402,
            error: `Could not parse x402 payment requirements: ${(e as Error).message}`,
          });
        }

        const solanaOption = findSolanaOption(requirements);
        if (!solanaOption) {
          return formatResult({
            payment_required: true,
            status: 402,
            compatible: false,
            error: 'This API offers no way to pay in USDC on Solana. Botwallet pays in USDC on Solana only.',
            available_networks: availableNetworks(requirements),
          });
        }

        // Refuse before anything is prepared or sent for approval
        try {
          requireHttps(probe.url);
        } catch (e) {
          return formatResult({
            payment_required: true,
            status: 402,
            url: probe.url,
            error: `Botwallet cannot pay this API: ${(e as Error).message}.`,
          });
        }

        // Prepare payment intent via BotWallet API
        const amount = getAmount(solanaOption);
        const prepared = await ctx.sdk.x402Prepare({
          url: probe.url,
          pay_to: solanaOption.payTo,
          amount,
          network: normalizeSolanaNetwork(solanaOption.network),
          method: probe.method,
          asset: solanaOption.asset,
          scheme: solanaOption.scheme,
        });

        // Key 1 later signs only the API's own price (base units, read the way
        // the server's x402_prepare reads them) to the API's own address, for at
        // most the quoted fee
        const priceBaseUnits = Math.round(parseFloat(amount));
        if (typeof prepared.fetch_id === 'string' && prepared.fetch_id &&
            Number.isSafeInteger(priceBaseUnits) && priceBaseUnits > 0) {
          rememberAgreedTransfer(prepared.fetch_id, {
            amount: BigInt(priceBaseUnits),
            recipient: solanaOption.payTo,
            quotedFee: usdToBaseUnits(prepared.fee_usdc) ?? undefined,
          });
        }

        // Owner approval needed — nothing is paid until the owner approves
        // AND the agent comes back to call botwallet_x402_pay_and_fetch.
        if (prepared.status === 'awaiting_approval') {
          return formatResult({
            payment_required: true,
            needs_approval: true,
            fetch_id: prepared.fetch_id,
            approval_id: prepared.approval_id,
            approval_url: prepared.approval_url,
            message: prepared.message,
            approval_reason: prepared.approval_reason,
            price_usdc: prepared.amount_usdc,
            fee_usdc: prepared.fee_usdc,
            total_usdc: prepared.total_usdc,
            pay_to: prepared.pay_to,
            network: prepared.network,
            url: probe.url,
            description: solanaOption.description,
            expires_at: prepared.expires_at,
            next_steps: 'Send the approval_url to your human owner and tell them that approving does not pay for the API by itself. ' +
              'Once they approve, call botwallet_x402_pay_and_fetch with the fetch_id. Approvals expire after 24 hours.',
            confirm_tool: 'botwallet_x402_pay_and_fetch',
            confirm_args: { fetch_id: prepared.fetch_id },
            check_tool: 'botwallet_approval_status',
            check_args: { approval_id: prepared.approval_id },
          });
        }

        // Blocked by the owner's guard rails — surface the server's reason
        if (prepared.status === 'rejected' || prepared.status === 'blocked') {
          return guardRailBlockedError(prepared, 'API payment');
        }

        return formatResult({
          payment_required: true,
          fetch_id: prepared.fetch_id,
          price_usdc: prepared.amount_usdc,
          fee_usdc: prepared.fee_usdc,
          total_usdc: prepared.total_usdc,
          pay_to: prepared.pay_to,
          network: prepared.network,
          url: probe.url,
          description: solanaOption.description,
          next_steps: 'Call botwallet_x402_pay_and_fetch with the fetch_id to pay and get the API response.',
        });
      }

      // Other error
      return formatResult({
        payment_required: false,
        status: response.status,
        error: `HTTP ${response.status}: ${response.statusText}`,
      });
    } catch (e) {
      return formatToolError(e);
    }
  },
};

// Until the signed payment goes out in the API request, nothing is paid, and
// the same fetch_id can be tried again: the server hands back the transaction
// it already prepared instead of making a new one.
const RETRY_SAME_FETCH =
  'Nothing was paid. To try again, call botwallet_x402_pay_and_fetch with the same fetch_id. ' +
  'Do not call botwallet_x402_fetch again for this request: that starts a new payment.';

const REQUEST_REFUSED =
  'Nothing was paid. If a header you passed is the problem, fix it and call botwallet_x402_pay_and_fetch ' +
  'again with the same fetch_id. Botwallet pays only APIs at a public HTTPS address.';

// The owner froze the wallet (WALLET_SUSPENDED): the server turns the call away
// before anything changes, so the same fetch_id works once it is unfrozen.
const UNFREEZE_THEN_RETRY =
  'Nothing was paid. Ask your owner to unfreeze this wallet in the Botwallet dashboard, then call ' +
  'botwallet_x402_pay_and_fetch again with the same fetch_id. Do not call botwallet_x402_fetch again for this ' +
  'request: that starts a new payment.';

function isFrozenWallet(error: unknown): boolean {
  return error instanceof BotWalletError && error.code === 'WALLET_SUSPENDED';
}

async function payAndFetch(
  ctx: ToolContext,
  walletName: string,
  fetchId: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<ToolResult> {
  const ref: TransferRef = { fetch_id: fetchId };
  // Load Key 1 first, so a broken seed file stops before the server prepares anything
  let mnemonic: string;
  try {
    mnemonic = loadSeed(walletName);
  } catch (e) {
    return notSentError(e, ref);
  }

  // Step 1: Confirm payment — creates Solana transaction. Nothing is signed yet.
  let confirmResult: X402ConfirmResponse;
  try {
    confirmResult = await ctx.sdk.x402Confirm({ fetch_id: fetchId });
  } catch (e) {
    return confirmError(e, fetchId, ref);
  }
  const transactionId = confirmResult.transaction_id;
  const url = typeof confirmResult.url === 'string' ? confirmResult.url : '';
  const method = confirmResult.method || 'GET';
  const network = confirmResult.network;
  const paymentRef: TransferRef = { ...ref, transaction_id: transactionId };

  if (!confirmResult.message) {
    return notSentError(new Error('Server did not return transaction message for signing'), paymentRef);
  }
  if (!url) {
    return notSentError(new Error('Server did not return the API URL to pay'), paymentRef);
  }

  // Rule out the API request before Key 1 signs anything: HTTPS, a public
  // address, valid headers
  try {
    await checkPaidRequest(url, headers);
  } catch (e) {
    if (e instanceof X402RequestError) {
      return notSentError(e, paymentRef, REQUEST_REFUSED);
    }
    return notSentError(e, paymentRef, RETRY_SAME_FETCH);
  }

  // Step 2: Check and FROST sign — server returns signed tx (no on-chain submission)
  let signedTx: string;
  try {
    const check: SigningCheck = {
      walletAddress: localWalletAddress(walletName),
      transfer: expectedTransfer('x402', confirmResult, agreedTransferFor(fetchId)),
    };
    const signResult = await frostSignForX402(ctx.sdk, mnemonic, transactionId, confirmResult.message, check);
    signedTx = typeof signResult.signed_transaction === 'string' ? signResult.signed_transaction : '';
  } catch (e) {
    if (e instanceof TransactionCheckError) return signingRefusedError(e, paymentRef, 'API payment');
    return notSentError(e, paymentRef, isFrozenWallet(e) ? UNFREEZE_THEN_RETRY : RETRY_SAME_FETCH);
  }
  if (!signedTx) {
    return notSentError(new Error('FROST signing did not return signed transaction'), paymentRef, RETRY_SAME_FETCH);
  }

  // Step 3: Fetch with X-Payment header. From here the API holds a signed payment.
  const xPayment = buildXPaymentHeader(signedTx, network);
  let response: Response;
  try {
    response = await fetchWithPayment(url, method, headers, body, xPayment);
  } catch (e) {
    if (e instanceof X402RequestError) return notSentError(e, paymentRef, REQUEST_REFUSED);
    forgetAgreedTransfer(fetchId);
    // As the CLI does: record the failed call, so it doesn't stay pending
    const settleError = await settle(ctx, { fetch_id: fetchId, success: false, response_status: 0,
      error_message: (e as Error).message.slice(0, 500) });
    return outcomeUnknownError(
      `The signed payment was sent to the API, but no answer came back (${(e as Error).message}). ` +
      'The API may still take the payment.',
      (settleError ? '' : 'Botwallet has recorded this API call as failed, so this fetch_id can\'t be used again. ') +
      CHECK_BEFORE_PAYING_AGAIN,
      paymentRef,
      {
        check_tool: 'botwallet_balance',
        check_args: {},
        ...(settleError ? { settle_error: settleError } : {}),
      },
    );
  }
  forgetAgreedTransfer(fetchId);

  // The API has answered. Read its answer once, then record the outcome: the
  // answer is returned even if either step fails.
  let content = '';
  let truncated = false;
  let readError: string | undefined;
  try {
    const read = await readResponseBody(response);
    content = displayBody(response.headers.get('content-type'), read.text);
    truncated = read.truncated;
  } catch (e) {
    readError = `The API's answer could not be read in full (${(e as Error).message}).`;
  }

  // Step 4: Settle — report outcome back. Only the status goes to Botwallet,
  // never the API's answer.
  const settleError = await settle(ctx, {
    fetch_id: fetchId,
    success: response.ok,
    response_status: response.status,
  });

  const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
  return formatResult({
    success: response.ok,
    status: response.status,
    fetch_id: fetchId,
    content,
    ...(truncated ? { truncated: true } : {}),
    ...(readError ? { read_error: readError } : {}),
    ...(location ? { redirect_location: location } : {}),
    ...(response.ok ? {} : {
      error: `The API answered HTTP ${response.status} after the payment was sent.`,
      next_steps: (settleError ? '' : 'Botwallet has recorded this API call as failed. ') + CHECK_BEFORE_PAYING_AGAIN,
    }),
    payment: {
      amount_usdc: confirmResult.amount_usdc,
      fee_usdc: confirmResult.fee_usdc,
      total_usdc: confirmResult.total_usdc,
      transaction_id: transactionId,
    },
    ...(settleError ? { settle_error: settleError } : {}),
  });
}

// After a signed payment went to the API without a clear success
const CHECK_BEFORE_PAYING_AGAIN =
  'A payment the API has not taken can\'t go through after about two minutes. Wait that long, then check ' +
  'botwallet_balance before paying for this request again: if the price has left the wallet, the API took the payment.';

/**
 * x402_confirm turned this fetch_id down. Most answers come before anything
 * was signed for it, but "completed" and "failed" are recorded after an
 * earlier attempt sent the signed payment to the API, and "already being
 * processed" may come after that too.
 */
function confirmError(error: unknown, fetchId: string, ref: TransferRef): ToolResult {
  const code = error instanceof BotWalletError ? (error.code as string) : '';
  if (code === 'ALREADY_COMPLETED') {
    forgetAgreedTransfer(fetchId);
    return formatResult({
      already_paid: true,
      ...ref,
      message: 'This API call was paid for earlier, and Botwallet recorded it as completed. Nothing new was paid.',
      next_steps: 'Its answer can\'t be fetched again with this fetch_id. If you need it again, call ' +
        'botwallet_x402_fetch, which starts a new payment.',
    });
  }
  if (code === 'TRANSACTION_FAILED' || code === 'ALREADY_CONFIRMED') {
    if (code === 'TRANSACTION_FAILED') forgetAgreedTransfer(fetchId);
    return outcomeUnknownError(
      code === 'TRANSACTION_FAILED'
        ? `Botwallet lists this API call as failed (${(error as Error).message}), so this fetch_id can't be used again. ` +
          'If an earlier attempt sent the signed payment to the API, the API may still take it.'
        : `Botwallet says this API payment is already being processed (${(error as Error).message}). It may have been paid.`,
      CHECK_BEFORE_PAYING_AGAIN,
      ref,
      { check_tool: 'botwallet_balance', check_args: {} },
    );
  }
  if (isFrozenWallet(error)) return notSentError(error, ref, UNFREEZE_THEN_RETRY);
  return notSentError(error, ref, isNoAnswer(error) ? RETRY_SAME_FETCH : undefined);
}

/** Report the outcome of a paid call. Returns what to tell the agent if it fails, else undefined. */
async function settle(ctx: ToolContext, params: X402SettleParams): Promise<string | undefined> {
  try {
    await ctx.sdk.x402Settle(params);
    return undefined;
  } catch (e) {
    return `Botwallet could not record the result of this call (${(e as Error).message}), so it may still ` +
      'list the payment as pending. Do not pay for this request again until you know whether this payment went through.';
  }
}

const x402PayAndFetch: ToolDefinition = {
  name: 'botwallet_x402_pay_and_fetch',
  annotations: MOVES_MONEY,
  description:
    'Pay for and fetch content from an x402 API. Uses the `fetch_id` from botwallet_x402_fetch. ' +
    'Checks the payment (the API\'s own price and address, plus at most the quoted fee and a cent of rounding), ' +
    'performs FROST threshold signing, builds the payment header, fetches the API, and settles. ' +
    'The price and address are checked against the API\'s own answer only if this MCP server ran botwallet_x402_fetch ' +
    'and has not restarted since; otherwise against the ones Botwallet recorded, with the fee still capped. ' +
    'Returns the API response content and payment details. If it fails, follow its `how_to_fix`. When nothing was paid, ' +
    'retry with the same `fetch_id`: probing the API again with botwallet_x402_fetch starts a new payment.',
  inputSchema: z.object({
    fetch_id: z.string()
      .describe('Fetch ID from a previous botwallet_x402_fetch call'),
    headers: z.record(z.string()).optional()
      .describe('Additional HTTP headers for the API request'),
    body: z.string().optional()
      .describe('Request body for POST/PUT requests'),
  }),
  async handler(args, ctx) {
    try {
      const walletName = ctx.config.walletName;
      if (!ctx.config.hasSeed || !walletName) {
        return noSeedError('make x402 payment (FROST signing)', walletName);
      }

      const { fetch_id, headers = {}, body } = args as {
        fetch_id: string; headers?: Record<string, string>; body?: string;
      };

      return await withSigningLock(fetch_id, () => payAndFetch(ctx, walletName, fetch_id, headers, body));
    } catch (e) {
      if (e instanceof SigningInProgressError) {
        return outcomeUnknownError(
          'This API payment is already being signed by another request.',
          'Wait for that request to finish. Do not call botwallet_x402_fetch again for this request.',
          { fetch_id: e.transactionId },
        );
      }
      return formatToolError(e);
    }
  },
};

export const x402Tools: ToolDefinition[] = [
  x402Discover,
  x402Fetch,
  x402PayAndFetch,
];
