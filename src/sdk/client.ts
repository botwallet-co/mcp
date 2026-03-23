// =============================================================================
// Botwallet SDK Client
// =============================================================================
// AI-first SDK for autonomous agents to manage money.
// Designed to be self-documenting and guide bots through operations.
// =============================================================================

import {
  BotWalletError,
  UnauthorizedError,
  InsufficientFundsError,
  RecipientNotFoundError,
  GuardRailError,
  NetworkError,
  TimeoutError,
} from './errors.js';

import type {
  BotWalletConfig,
  ApiErrorResponse,
  // Basics
  PingResponse,
  RegisterParams,
  RegisterResponse,
  InfoResponse,
  BalanceResponse,
  UpdateOwnerParams,
  UpdateOwnerResponse,
  // Spending
  LookupParams,
  LookupResponse,
  CanIAffordParams,
  CanIAffordResponse,
  PayParams,
  PayResponse,
  ListPaymentsParams,
  ListPaymentsResponse,
  CancelPaymentParams,
  CancelPaymentResponse,
  ConfirmPaymentParams,
  ConfirmPaymentResponse,
  // Wallet (extended)
  UpdateNameParams,
  UpdateNameResponse,
  // Earning
  CreatePaymentRequestParams,
  CreatePaymentRequestResponse,
  GetPaymentRequestParams,
  GetPaymentRequestResponse,
  ListPaymentRequestsParams,
  ListPaymentRequestsResponse,
  CancelPaymentRequestParams,
  CancelPaymentRequestResponse,
  SendPaylinkInvitationParams,
  SendPaylinkInvitationResponse,
  // Funding
  GetDepositAddressResponse,
  RequestFundsParams,
  RequestFundsResponse,
  ListFundRequestsParams,
  ListFundRequestsResponse,
  // Withdrawals
  WithdrawParams,
  WithdrawResponse,
  ConfirmWithdrawalParams,
  ConfirmWithdrawalResponse,
  GetWithdrawalParams,
  GetWithdrawalResponse,
  // History & Limits
  TransactionsParams,
  TransactionsResponse,
  MyLimitsResponse,
  PendingApprovalsResponse,
  ApprovalStatusParams,
  ApprovalStatusResponse,
  EventsParams,
  EventsResponse,
  MarkReadParams,
  MarkReadResponse,
  // FROST
  FrostSignInitParams,
  FrostSignInitResponse,
  FrostSignCompleteParams,
  FrostSignCompleteResponse,
  // DKG
  DkgInitParams,
  DkgInitResponse,
  DkgCompleteParams,
  DkgCompleteResponse,
  // x402
  X402DiscoverParams,
  X402DiscoverResponse,
  X402PrepareParams,
  X402PrepareResponse,
  X402ConfirmParams,
  X402ConfirmResponse,
  X402SignCompleteParams,
  X402SignCompleteResponse,
  X402SettleParams,
  X402SettleResponse,
  // Wallet Transfer
  WalletExportResponse,
  WalletImportKeyParams,
  WalletImportKeyResponse,
} from './types.js';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

// Default API URL
// Override via:
//   - BotWalletConfig.baseUrl
//   - BOTWALLET_API_URL environment variable
const DEFAULT_BASE_URL = 'https://api.botwallet.co/v1';
const DEFAULT_TIMEOUT = 30000;


// -----------------------------------------------------------------------------
// BotWallet Client Class
// -----------------------------------------------------------------------------

/**
 * BotWallet SDK Client
 * 
 * @example
 * ```typescript
 * import { BotWallet } from '@botwallet/sdk';
 * 
 * // Create client with API key
 * const wallet = new BotWallet({ apiKey: 'bw_bot_...' });
 * 
 * // Check balance
 * const balance = await wallet.balance();
 * console.log(`Balance: $${balance.balance}`);
 * 
 * // Make a payment
 * const result = await wallet.pay({ to: 'merchant-name', amount: 10.00 });
 * if (result.paid) {
 *   console.log(`Paid! New balance: $${result.new_balance}`);
 * }
 * ```
 */
export class BotWallet {
  private apiKey?: string;
  private baseUrl: string;
  private timeout: number;

  /**
   * Create a BotWallet client.
   * 
   * API key can be provided via:
   * 1. config.apiKey parameter
   * 2. BOTWALLET_API_KEY environment variable (auto-detected)
   * 
   * @example
   * ```typescript
   * // With explicit API key
   * const wallet = new BotWallet({ apiKey: 'bw_bot_...' });
   * 
   * // Auto-detect from environment (recommended for production)
   * process.env.BOTWALLET_API_KEY = 'bw_bot_...';
   * const wallet = new BotWallet();
   * ```
   */
  constructor(config: BotWalletConfig = {}) {
    // Auto-detect API key from environment if not provided
    this.apiKey = config.apiKey || this.detectApiKey();
    this.baseUrl = config.baseUrl || process.env.BOTWALLET_API_URL || DEFAULT_BASE_URL;
    this.timeout = config.timeout || DEFAULT_TIMEOUT;
  }

  /**
   * Detect API key from environment variables
   */
  private detectApiKey(): string | undefined {
    // Check common environment variable names
    if (typeof process !== 'undefined' && process.env) {
      return process.env.BOTWALLET_API_KEY || process.env.BW_API_KEY;
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // HTTP Layer
  // ---------------------------------------------------------------------------

  private async request<T>(
    action: string,
    data?: object,
    options?: { requiresAuth?: boolean; idempotencyKey?: string }
  ): Promise<T> {
    const { requiresAuth = true, idempotencyKey } = options || {};

    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (requiresAuth) {
      if (!this.apiKey) {
        throw new UnauthorizedError(
          'API key required. Provide via: new BotWallet({ apiKey: "bw_bot_..." }) or set BOTWALLET_API_KEY environment variable. If you don\'t have a key, call register() first.'
        );
      }
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    if (idempotencyKey) {
      headers['X-Idempotency-Key'] = idempotencyKey;
    }

    // Build body
    const body = JSON.stringify({ action, ...data });

    // Make request with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.baseUrl}/bot`, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const json = await response.json() as Record<string, unknown>;

      // V3 response format: { success: true/false, data: {...}, error: { code, message, how_to_fix } }
      // Matches Go CLI's Call() in packages/cli-go/api/client.go
      if ('success' in json) {
        if (json.success === false) {
          const errObj = (json.error || {}) as Record<string, unknown>;
          throw this.handleApiError({
            error: (errObj.code as string) || 'INTERNAL_ERROR',
            message: (errObj.message as string) || 'Unknown error',
            how_to_fix: errObj.how_to_fix as string | undefined,
            ...Object.fromEntries(
              Object.entries(errObj).filter(([k]) => !['code', 'message', 'how_to_fix'].includes(k))
            ),
          });
        }
        // Success: unwrap { success: true, data: {...} } → return data
        if (json.data && typeof json.data === 'object') {
          return json.data as T;
        }
      }

      // Fallback for non-V3 responses
      if (!response.ok) {
        throw this.handleApiError(json as ApiErrorResponse);
      }

      return json as T;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof BotWalletError) {
        throw error;
      }

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new TimeoutError(this.timeout);
        }
        throw new NetworkError(error.message, error);
      }

      throw new NetworkError('Unknown error occurred');
    }
  }

  private handleApiError(response: ApiErrorResponse): BotWalletError {
    const { error, message, how_to_fix, ...details } = response;

    // Special handling for specific error types
    switch (error) {
      case 'UNAUTHORIZED':
        return new UnauthorizedError(message);

      case 'INSUFFICIENT_FUNDS':
        return new InsufficientFundsError(
          details.balance as number,
          details.required as number,
          details.funding_url as string | undefined
        );

      case 'RECIPIENT_NOT_FOUND':
        return new RecipientNotFoundError(details.username as string || 'unknown');

      case 'DAILY_LIMIT':
      case 'MAX_PER_TRANSACTION':
      case 'ALLOW_BOT_PAYMENTS':
      case 'BOT_WHITELIST':
      case 'MERCHANT_BLACKLIST':
      case 'MERCHANT_WHITELIST':
      case 'ALLOW_WITHDRAWALS':
      case 'WITHDRAWAL_APPROVAL_REQUIRED':
      case 'MIN_WITHDRAWAL':
      case 'MAX_WITHDRAWAL':
      case 'WITHDRAWAL_WHITELIST':
      case 'ALLOW_PAYMENT_REQUESTS':
      case 'MAX_PAYMENT_REQUEST':
        return new GuardRailError(error.toLowerCase(), message, details);

      default:
        return BotWalletError.fromResponse(response);
    }
  }

  // ---------------------------------------------------------------------------
  // Configuration Methods
  // ---------------------------------------------------------------------------

  /**
   * Set or update the API key
   */
  setApiKey(apiKey: string): this {
    this.apiKey = apiKey;
    return this;
  }

  /**
   * Check if client has an API key configured
   */
  hasApiKey(): boolean {
    return !!this.apiKey;
  }

  /**
   * Get the configured base URL
   */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  // ---------------------------------------------------------------------------
  // BASICS
  // ---------------------------------------------------------------------------

  /**
   * Test connectivity to the API
   * @returns Server status and version
   */
  async ping(): Promise<PingResponse> {
    return this.request<PingResponse>('ping', undefined, { requiresAuth: false });
  }

  /**
   * Register a new wallet
   * @param params - Registration parameters
   * @returns New wallet details including API key (save this!)
   */
  async register(params: RegisterParams): Promise<RegisterResponse> {
    return this.request<RegisterResponse>('register', params, { requiresAuth: false });
  }

  /**
   * Get wallet information
   * @returns Wallet info including balance and status
   */
  async info(): Promise<InfoResponse> {
    return this.request<InfoResponse>('info');
  }

  /**
   * Get detailed balance information
   * @returns Balance with daily limits and spending context
   */
  async balance(): Promise<BalanceResponse> {
    return this.request<BalanceResponse>('balance');
  }

  /**
   * Update the pledged owner email (unclaimed wallets only)
   * @param params - New owner email
   * @returns Update confirmation with new claim details
   */
  async updateOwner(params: UpdateOwnerParams): Promise<UpdateOwnerResponse> {
    return this.request<UpdateOwnerResponse>('update_owner', params);
  }

  /**
   * Update the wallet's display name
   * @param params - New display name
   */
  async updateName(params: UpdateNameParams): Promise<UpdateNameResponse> {
    return this.request<UpdateNameResponse>('update_name', params);
  }

  // ---------------------------------------------------------------------------
  // DKG (Distributed Key Generation)
  // ---------------------------------------------------------------------------

  /**
   * Start FROST Distributed Key Generation (no auth required)
   * @param params - Name and optional metadata
   * @returns Server's public key share (A2) and session ID
   */
  async dkgInit(params: DkgInitParams): Promise<DkgInitResponse> {
    return this.request<DkgInitResponse>('dkg_init', params, { requiresAuth: false });
  }

  /**
   * Complete FROST DKG (no auth required)
   * @param params - Session ID, bot's public share (A1), and group key (A)
   * @returns Wallet details including API key
   */
  async dkgComplete(params: DkgCompleteParams): Promise<DkgCompleteResponse> {
    return this.request<DkgCompleteResponse>('dkg_complete', params, { requiresAuth: false });
  }

  // ---------------------------------------------------------------------------
  // SPENDING
  // ---------------------------------------------------------------------------

  /**
   * Look up a recipient by username
   * @param params - Lookup parameters
   * @returns Whether recipient exists and their type
   */
  async lookup(params: LookupParams): Promise<LookupResponse> {
    return this.request<LookupResponse>('lookup', params);
  }

  /**
   * Check if you can afford a payment before attempting it
   * @param params - Payment parameters to check
   * @returns Whether payment would succeed and why/why not
   */
  async canIAfford(params: CanIAffordParams): Promise<CanIAffordResponse> {
    return this.request<CanIAffordResponse>('can_i_afford', params);
  }

  /**
   * Make a payment to a merchant or bot
   * @param params - Payment parameters
   * @param idempotencyKey - Optional key to prevent duplicate payments
   * @returns Payment result (success or approval needed)
   */
  async pay(params: PayParams, idempotencyKey?: string): Promise<PayResponse> {
    return this.request<PayResponse>('pay', params, { idempotencyKey });
  }

  /**
   * List payment transactions
   * @param params - Filter and pagination options
   */
  async listPayments(params?: ListPaymentsParams): Promise<ListPaymentsResponse> {
    return this.request<ListPaymentsResponse>('list_payments', params);
  }

  /**
   * Cancel a pending or pre-approved payment
   * @param params - Transaction ID to cancel
   */
  async cancelPayment(params: CancelPaymentParams): Promise<CancelPaymentResponse> {
    return this.request<CancelPaymentResponse>('cancel_payment', params);
  }

  /**
   * Confirm a payment and get the transaction message to sign
   * @param params - Transaction ID to confirm
   */
  async confirmPayment(params: ConfirmPaymentParams): Promise<ConfirmPaymentResponse> {
    return this.request<ConfirmPaymentResponse>('confirm_payment', params);
  }

  // ---------------------------------------------------------------------------
  // EARNING
  // ---------------------------------------------------------------------------

  /**
   * Create a payment request (to receive money)
   * @param params - Payment request details
   * @returns Created payment request with payment URL
   */
  async createPaymentRequest(params: CreatePaymentRequestParams): Promise<CreatePaymentRequestResponse> {
    return this.request<CreatePaymentRequestResponse>('create_payment_request', params);
  }

  /**
   * Get status of a payment request
   * @param params - Request ID or reference
   * @returns Payment request details and status
   */
  async getPaymentRequest(params: GetPaymentRequestParams): Promise<GetPaymentRequestResponse> {
    return this.request<GetPaymentRequestResponse>('get_payment_request', params);
  }

  /**
   * List your payment requests
   * @param params - Filter and pagination options
   * @returns List of payment requests
   */
  async listPaymentRequests(params?: ListPaymentRequestsParams): Promise<ListPaymentRequestsResponse> {
    return this.request<ListPaymentRequestsResponse>('list_payment_requests', params);
  }

  /**
   * Cancel a pending payment request
   * @param params - Request ID
   * @returns Cancellation confirmation
   */
  async cancelPaymentRequest(params: CancelPaymentRequestParams): Promise<CancelPaymentRequestResponse> {
    return this.request<CancelPaymentRequestResponse>('cancel_payment_request', params);
  }

  /**
   * Send a paylink invitation via email or to a bot wallet
   * @param params - Request ID and recipient details
   */
  async sendPaylinkInvitation(params: SendPaylinkInvitationParams): Promise<SendPaylinkInvitationResponse> {
    return this.request<SendPaylinkInvitationResponse>('send_paylink_invitation', params);
  }

  // ---------------------------------------------------------------------------
  // FUNDING
  // ---------------------------------------------------------------------------

  /**
   * Get your deposit address for receiving USDC
   * @returns Deposit address and instructions
   */
  async getDepositAddress(): Promise<GetDepositAddressResponse> {
    return this.request<GetDepositAddressResponse>('get_deposit_address');
  }

  /**
   * Request funds from your human owner
   * @param params - Amount and reason
   * @returns Request status and notification info
   */
  async requestFunds(params: RequestFundsParams): Promise<RequestFundsResponse> {
    return this.request<RequestFundsResponse>('request_funds', params);
  }

  /**
   * List your fund requests to owner
   * @param params - Filter and pagination options
   * @returns List of fund requests
   */
  async listFundRequests(params?: ListFundRequestsParams): Promise<ListFundRequestsResponse> {
    return this.request<ListFundRequestsResponse>('list_fund_requests', params);
  }

  // ---------------------------------------------------------------------------
  // WITHDRAWALS
  // ---------------------------------------------------------------------------

  /**
   * Withdraw USDC to a Solana address
   * @param params - Amount and destination address
   * @param idempotencyKey - Optional key to prevent duplicate withdrawals
   * @returns Withdrawal status (processing or approval needed)
   */
  async withdraw(params: WithdrawParams, idempotencyKey?: string): Promise<WithdrawResponse> {
    return this.request<WithdrawResponse>('withdraw', params, { idempotencyKey });
  }

  /**
   * Confirm an approved withdrawal and get the transaction message to sign
   * @param params - Withdrawal ID to confirm
   * @returns Transaction message for FROST signing
   */
  async confirmWithdrawal(params: ConfirmWithdrawalParams): Promise<ConfirmWithdrawalResponse> {
    return this.request<ConfirmWithdrawalResponse>('confirm_withdrawal', params);
  }

  /**
   * Get status of a withdrawal
   * @param params - Withdrawal ID
   * @returns Withdrawal details and status
   */
  async getWithdrawal(params: GetWithdrawalParams): Promise<GetWithdrawalResponse> {
    return this.request<GetWithdrawalResponse>('get_withdrawal', params);
  }

  // ---------------------------------------------------------------------------
  // HISTORY & LIMITS
  // ---------------------------------------------------------------------------

  /**
   * Get transaction history
   * @param params - Filter and pagination options
   * @returns List of transactions
   */
  async transactions(params?: TransactionsParams): Promise<TransactionsResponse> {
    return this.request<TransactionsResponse>('transactions', params);
  }

  /**
   * Get your spending limits and restrictions
   * @returns All guard rails and current status
   */
  async myLimits(): Promise<MyLimitsResponse> {
    return this.request<MyLimitsResponse>('my_limits');
  }

  /**
   * Get pending approval requests
   * @returns List of actions waiting for owner approval
   */
  async pendingApprovals(): Promise<PendingApprovalsResponse> {
    return this.request<PendingApprovalsResponse>('pending_approvals');
  }

  /**
   * Check the status of a specific approval
   * @param params - Approval ID
   */
  async approvalStatus(params: ApprovalStatusParams): Promise<ApprovalStatusResponse> {
    return this.request<ApprovalStatusResponse>('approval_status', params);
  }

  /**
   * Get wallet events/notifications
   * @param params - Filter options
   */
  async events(params?: EventsParams): Promise<EventsResponse> {
    return this.request<EventsResponse>('events', params);
  }

  /**
   * Mark events as read
   * @param params - Specific event IDs or all
   */
  async markRead(params: MarkReadParams): Promise<MarkReadResponse> {
    return this.request<MarkReadResponse>('mark_read', params);
  }

  // ---------------------------------------------------------------------------
  // FROST SIGNING
  // ---------------------------------------------------------------------------

  /**
   * Start a FROST signing round — exchange nonce commitments
   * @param params - Transaction ID and bot's nonce commitment (R1)
   * @returns Server's nonce commitment (R2), group key, and session ID
   */
  async frostSignInit(params: FrostSignInitParams): Promise<FrostSignInitResponse> {
    return this.request<FrostSignInitResponse>('frost_sign_init', params);
  }

  /**
   * Complete a FROST signing round — server aggregates and submits to Solana
   * @param params - Session ID and bot's partial signature (z1)
   * @returns Transaction result
   */
  async frostSignComplete(params: FrostSignCompleteParams): Promise<FrostSignCompleteResponse> {
    return this.request<FrostSignCompleteResponse>('frost_sign_complete', params);
  }

  // ---------------------------------------------------------------------------
  // x402 PAID APIs
  // ---------------------------------------------------------------------------

  /**
   * Discover x402 paid APIs from the catalog or Coinbase Bazaar
   * @param params - Search query and source
   */
  async x402Discover(params?: X402DiscoverParams): Promise<X402DiscoverResponse> {
    return this.request<X402DiscoverResponse>('x402_discover', params);
  }

  /**
   * Prepare an x402 payment intent
   * @param params - URL, payment details, network, method
   */
  async x402Prepare(params: X402PrepareParams): Promise<X402PrepareResponse> {
    return this.request<X402PrepareResponse>('x402_prepare', params);
  }

  /**
   * Confirm an x402 payment — builds Solana transaction
   * @param params - Fetch ID from prepare step
   * @returns Transaction message to sign
   */
  async x402Confirm(params: X402ConfirmParams): Promise<X402ConfirmResponse> {
    return this.request<X402ConfirmResponse>('x402_confirm', params);
  }

  /**
   * Complete FROST signing for x402 — returns signed tx without submitting to Solana
   * @param params - Session ID and partial signature
   * @returns Signed transaction bytes (for X-Payment header)
   */
  async x402SignComplete(params: X402SignCompleteParams): Promise<X402SignCompleteResponse> {
    return this.request<X402SignCompleteResponse>('x402_sign_complete', params);
  }

  /**
   * Report x402 API call outcome back to the server
   * @param params - Fetch ID, success status, response status
   */
  async x402Settle(params: X402SettleParams): Promise<X402SettleResponse> {
    return this.request<X402SettleResponse>('x402_settle', params);
  }

  // ---------------------------------------------------------------------------
  // WALLET TRANSFER
  // ---------------------------------------------------------------------------

  /**
   * Request a wallet export encryption key from the server
   * @returns Export ID and encryption key
   */
  async walletExport(): Promise<WalletExportResponse> {
    return this.request<WalletExportResponse>('wallet_export');
  }

  /**
   * Retrieve the decryption key for a .bwlt file (no auth required)
   * @param params - Export ID from the .bwlt file
   * @returns Decryption key
   */
  async walletImportKey(params: WalletImportKeyParams): Promise<WalletImportKeyResponse> {
    return this.request<WalletImportKeyResponse>('wallet_import_key', params, { requiresAuth: false });
  }

}

// -----------------------------------------------------------------------------
// Factory Function
// -----------------------------------------------------------------------------

/**
 * Create a new BotWallet client
 * 
 * @example
 * ```typescript
 * import { createBotWallet } from '@botwallet/sdk';
 * 
 * const wallet = createBotWallet({ apiKey: 'bw_bot_...' });
 * ```
 */
export function createBotWallet(config?: BotWalletConfig): BotWallet {
  return new BotWallet(config);
}

