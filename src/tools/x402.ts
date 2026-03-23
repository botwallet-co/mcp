import { z } from 'zod';
import type { ToolDefinition } from '../types.js';
import { formatResult } from '../utils/format.js';
import { formatToolError, noSeedError } from '../utils/errors.js';
import { frostSignForX402 } from '../frost/index.js';
import { loadSeed } from '../config/index.js';
import {
  probeUrl,
  parse402Response,
  findSolanaOption,
  buildXPaymentHeader,
  fetchWithPayment,
} from '../utils/x402-client.js';

const x402Discover: ToolDefinition = {
  name: 'botwallet_x402_discover',
  description:
    'Search for paid APIs that accept x402 payments. ' +
    'Searches a curated catalog of APIs or the Coinbase Bazaar directory. ' +
    'Returns API descriptions, pricing, and endpoints.',
  inputSchema: z.object({
    query: z.string().optional()
      .describe('Search query (e.g. "weather", "translation", "image generation")'),
    source: z.enum(['catalog', 'bazaar']).optional()
      .describe('Search source: "catalog" (curated) or "bazaar" (Coinbase). Default: catalog'),
    limit: z.number().int().min(1).max(50).optional()
      .describe('Max results to return'),
    offset: z.number().int().min(0).optional()
      .describe('Pagination offset'),
  }),
  async handler(args, ctx) {
    try {
      const result = await ctx.sdk.x402Discover(args as {
        query?: string; source?: 'catalog' | 'bazaar'; limit?: number; offset?: number;
      });
      return formatResult(result);
    } catch (e) {
      return formatToolError(e);
    }
  },
};

const x402Fetch: ToolDefinition = {
  name: 'botwallet_x402_fetch',
  description:
    'Probe a URL to check if it requires x402 payment. ' +
    'If the URL returns a 200, the content is returned directly (free). ' +
    'If it returns a 402, parses the payment requirements and prepares a payment intent — ' +
    'returns the price and a `fetch_id` for use with botwallet_x402_pay_and_fetch. ' +
    'No money is spent — this is "window shopping." ' +
    'You can probe multiple APIs to compare prices before committing.',
  inputSchema: z.object({
    url: z.string().url()
      .describe('URL to probe (must be HTTPS)'),
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

      const response = await probeUrl(url, method, headers, body);

      // Free — return content directly
      if (response.ok) {
        const contentType = response.headers.get('content-type') || '';
        let content: string;
        if (contentType.includes('json')) {
          content = JSON.stringify(await response.json(), null, 2);
        } else {
          content = await response.text();
        }
        return formatResult({
          payment_required: false,
          status: response.status,
          content,
        });
      }

      // 402 Payment Required
      if (response.status === 402) {
        const requirements = parse402Response(response);
        if (!requirements) {
          return formatResult({
            payment_required: true,
            status: 402,
            error: 'Could not parse x402 payment requirements from response',
          });
        }

        const solanaOption = findSolanaOption(requirements);
        if (!solanaOption) {
          return formatResult({
            payment_required: true,
            status: 402,
            error: 'No Solana payment option available',
            available_networks: requirements.accepts.map(a => a.network),
          });
        }

        // Prepare payment intent via BotWallet API
        const prepared = await ctx.sdk.x402Prepare({
          url,
          pay_to: solanaOption.pay_to,
          amount: solanaOption.amount,
          network: solanaOption.network,
          method,
        });

        return formatResult({
          payment_required: true,
          fetch_id: prepared.fetch_id,
          price_usdc: prepared.amount_usdc,
          fee_usdc: prepared.fee_usdc,
          total_usdc: prepared.total_usdc,
          pay_to: prepared.pay_to,
          network: prepared.network,
          description: requirements.description,
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

const x402PayAndFetch: ToolDefinition = {
  name: 'botwallet_x402_pay_and_fetch',
  description:
    'Pay for and fetch content from an x402 API. Uses the `fetch_id` from botwallet_x402_fetch. ' +
    'Performs FROST threshold signing, builds the payment header, fetches the API, and settles. ' +
    'Returns the API response content and payment details.',
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
      if (!ctx.config.hasSeed || !ctx.config.walletName) {
        return noSeedError('make x402 payment (FROST signing)');
      }

      const { fetch_id, headers = {}, body } = args as {
        fetch_id: string; headers?: Record<string, string>; body?: string;
      };

      // Step 1: Confirm payment — creates Solana transaction
      const confirmResult = await ctx.sdk.x402Confirm({ fetch_id });
      const transactionId = confirmResult.transaction_id;
      const url = confirmResult.url;
      const method = confirmResult.method;
      const network = confirmResult.network;

      if (!confirmResult.message) {
        return formatToolError(new Error('Server did not return transaction message for signing'));
      }

      // Step 2: FROST sign — server returns signed tx (no on-chain submission)
      const mnemonic = loadSeed(ctx.config.walletName);
      const signResult = await frostSignForX402(ctx.sdk, mnemonic, transactionId, confirmResult.message);

      const signedTx = signResult.signed_transaction as string;
      if (!signedTx) {
        return formatToolError(new Error('FROST signing did not return signed transaction'));
      }

      // Step 3: Fetch with X-Payment header
      const xPayment = buildXPaymentHeader(signedTx, network);
      const response = await fetchWithPayment(url, method, headers, body, xPayment);

      // Step 4: Settle — report outcome back
      let responseContent: string;
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('json')) {
        responseContent = JSON.stringify(await response.json(), null, 2);
      } else {
        responseContent = await response.text();
      }

      await ctx.sdk.x402Settle({
        fetch_id,
        success: response.ok,
        response_status: response.status,
        error_message: response.ok ? undefined : responseContent.substring(0, 500),
      });

      return formatResult({
        success: response.ok,
        status: response.status,
        content: responseContent,
        payment: {
          amount_usdc: confirmResult.amount_usdc,
          fee_usdc: confirmResult.fee_usdc,
          total_usdc: confirmResult.total_usdc,
          transaction_id: transactionId,
        },
      });
    } catch (e) {
      return formatToolError(e);
    }
  },
};

export const x402Tools: ToolDefinition[] = [
  x402Discover,
  x402Fetch,
  x402PayAndFetch,
];
