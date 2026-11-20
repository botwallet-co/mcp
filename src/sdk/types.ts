// =============================================================================
// Botwallet API types
// =============================================================================
// Request parameters and the `data` of each bot action's answer, as the
// handlers in supabase/functions/bot/handlers return them. Fields a tool only
// passes on to the agent are typed for reference; answers a tool reads and
// passes on too keep an index signature for the fields not listed.
// =============================================================================

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

export interface BotWalletConfig {
  /** API key for authentication (starts with bw_bot_) */
  apiKey?: string;
  /** Base URL for the API (defaults to production) */
  baseUrl?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
}

// -----------------------------------------------------------------------------
// Common Types
// -----------------------------------------------------------------------------

export type WalletStatus = 'unclaimed' | 'active' | 'suspended' | 'abandoned';
export type PaymentRequestStatus = 'pending' | 'completed' | 'expired' | 'cancelled';
// The transaction_type and transaction_status enums of the database
export type TransactionType =
  | 'deposit' | 'payment' | 'withdrawal' | 'refund' | 'fee' | 'adjustment' | 'payment_received' | 'x402_payment';
export type TransactionStatus =
  | 'pre_approved' | 'awaiting_approval' | 'approved' | 'rejected' | 'pending' | 'completed' | 'failed'
  | 'reversed' | 'expired';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type ApprovalType = 'payment' | 'withdrawal' | 'x402_payment';
export type RecipientType = 'merchant' | 'bot';

export interface FeeBreakdown {
  platform_fee_usdc: number;
  account_setup_fee_usdc: number;
}

// -----------------------------------------------------------------------------
// Response Types - Basics
// -----------------------------------------------------------------------------

export interface PingResponse {
  ok: boolean;
  timestamp: string;
  version: string;
}

export interface UpdateOwnerParams {
  /** New owner's email address */
  owner_email: string;
}

export interface UpdateOwnerResponse {
  updated: boolean;
  pledged_to: string;
  owner_found: boolean;
  claim_url: string;
  claim_code: string;
  message: string;
}

export interface InfoResponse {
  wallet_id: string;
  username: string;
  name: string | null;
  status: WalletStatus;
  /** True only for an active or suspended wallet: false while unclaimed and once abandoned. */
  is_claimed: boolean;
  /** The last balance read from the chain (balance_cached_at); `balance` reads it live. */
  balance: number;
  deposit_address: string;
  wallet_type?: string;
  funding_url: string;
  created_at: string;
  last_active_at: string | null;
  low_balance?: boolean;
  low_balance_threshold?: number;
  /** When `balance` was last read from the chain */
  balance_cached_at?: string;
  // Set while the wallet is unclaimed or abandoned
  claim_url?: string;
  /** Null once an unclaimed wallet's code has expired */
  claim_code?: string | null;
  /** Unclaimed wallets only */
  claim_expires_at?: string;
  claim_expired?: boolean;
  pledged_to?: string | null;
  claim_instructions?: string;
  abandoned?: boolean;
  [key: string]: unknown;
}

export interface BalanceResponse {
  balance: number;
  balance_usdc: number;
  deposit_address: string;
  token_account?: string;
  source: 'solana' | 'cache';
  network: string;
  rpc_provider?: string;
  /** Null when the owner has set no budget, as is remaining_budget */
  budget: number | null;
  budget_period: string;
  spent_this_period: number;
  remaining_budget: number | null;
  funding_url: string;
  low_balance: boolean;
  low_balance_threshold: number;
  last_reconciled_at?: string;
  /** Set when the live balance couldn't be read and this one is cached (from cached_at) */
  warning?: string;
  cached_at?: string;
  external_activity_detected?: Record<string, unknown>;
}

// -----------------------------------------------------------------------------
// Response Types - Spending
// -----------------------------------------------------------------------------

export interface LookupParams {
  username: string;
}

export interface LookupResponse {
  found: boolean;
  username: string;
  name?: string;
  type?: RecipientType;
  suggestion?: string;
}

export interface CanIAffordParams {
  to: string;
  amount: number;
}

export interface CanIAffordResponse {
  can_pay: boolean;
  // can_pay: true
  to?: string;
  to_name?: string;
  amount_usdc?: number;
  fee_usdc?: number;
  total_usdc?: number;
  fee_breakdown?: FeeBreakdown;
  balance_after_usdc?: number;
  /**
   * Why not: needs_approval, insufficient_funds, recipient_not_found,
   * recipient_inactive, recipient_suspended, or the guard rail that blocks it
   * (with guard_rail, owner_message and the rule's own details).
   */
  reason?: string;
  message?: string;
  owner_message?: string;
  // insufficient_funds
  balance_usdc?: number;
  required_usdc?: number;
  shortfall_usdc?: number;
  funding_url?: string;
  [key: string]: unknown;
}

export interface PayParams {
  /** Username of recipient (merchant or bot), or a Solana address */
  to?: string;
  /** Amount in USD */
  amount?: number;
  /** Payment request ID (alternative to to+amount) */
  payment_request_id?: string;
  /** Note visible to recipient */
  note?: string;
  /** Your internal reference */
  reference?: string;
}

/**
 * The payment intent pay created: pre_approved (ready to confirm),
 * awaiting_approval or rejected (blocked by the owner's guard rails). With an
 * idempotency_key used before, the earlier payment in whatever state it is
 * now, marked idempotent. Nothing is signed or sent yet.
 */
export interface PayResponse {
  transaction_id: string;
  reference_id: string;
  status: TransactionStatus;
  to?: string;
  to_name?: string;
  to_address?: string;
  amount_usdc: number;
  fee_usdc: number;
  total_usdc: number;
  fee_breakdown?: FeeBreakdown;
  balance_usdc?: number;
  expires_at?: string;
  created_at?: string;
  network?: string;
  message?: string;
  idempotent?: boolean;
  // awaiting_approval
  approval_id?: string | null;
  approval_url?: string;
  approval_reason?: string;
  guard_rail?: unknown;
  // rejected
  rejection_reason?: string;
  how_to_fix?: string;
  next_step?: string;
  confirm_command?: string;
  check_command?: string;
  [key: string]: unknown;
}

// -----------------------------------------------------------------------------
// Response Types - Earning
// -----------------------------------------------------------------------------

export interface CreatePaymentRequestParams {
  amount: number;
  description: string;
  reference?: string;
  expires_in?: string; // "1h", "24h", "7d"
  reveal_owner?: boolean;
  line_items?: Array<{
    description: string;
    quantity: number;
    unit_price_cents: number;
    total_cents: number;
  }>;
  [key: string]: unknown;
}

export interface CreatePaymentRequestResponse {
  request_id: string;
  short_code: string;
  payment_url: string;
  amount: number;
  description: string;
  reference?: string;
  status: 'pending';
  expires_at: string;
  message: string;
}

export interface GetPaymentRequestParams {
  request_id?: string;
  reference?: string;
}

export interface GetPaymentRequestResponse {
  request_id: string;
  short_code: string;
  status: PaymentRequestStatus;
  amount: number;
  description: string | null;
  reference: string | null;
  created_at: string;
  // Pending
  expires_at?: string;
  payment_url?: string;
  // Completed
  received?: number;
  paid_at?: string;
  paid_by?: string;
}

export interface ListPaymentRequestsParams {
  status?: PaymentRequestStatus | 'all';
  limit?: number;
  offset?: number;
}

export interface PaymentRequestSummary {
  request_id: string;
  short_code: string;
  amount: number;
  description: string | null;
  status: PaymentRequestStatus;
  created_at: string;
  expires_at: string | null;
}

export interface ListPaymentRequestsResponse {
  requests: PaymentRequestSummary[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface CancelPaymentRequestParams {
  request_id: string;
}

export interface CancelPaymentRequestResponse {
  cancelled: boolean;
  request_id: string;
}

// -----------------------------------------------------------------------------
// Response Types - Funding
// -----------------------------------------------------------------------------

export interface GetDepositAddressResponse {
  deposit_address: string;
  funding_url: string;
  balance: number;
  instructions: string;
}

export interface RequestFundsParams {
  amount: number;
  reason: string;
}

export interface RequestFundsResponse {
  requested: boolean;
  request_id: string;
  amount: number;
  reason: string;
  notification_sent: boolean;
  sent_to: string | null;
  funding_url: string;
  deposit_address: string;
  message: string;
}

export interface ListFundRequestsParams {
  status?: 'pending' | 'funded' | 'dismissed' | 'all';
  limit?: number;
  offset?: number;
}

export interface FundRequestRecord {
  request_id: string;
  amount: number;
  reason: string;
  status: 'pending' | 'funded' | 'dismissed';
  created_at: string;
  notified_at: string | null;
  funded_at: string | null;
  funded_amount: number | null;
}

export interface ListFundRequestsResponse {
  requests: FundRequestRecord[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
  funding_url: string;
  deposit_address: string;
}

// -----------------------------------------------------------------------------
// Response Types - Withdrawals
// -----------------------------------------------------------------------------

export interface WithdrawParams {
  amount: number;
  to_address: string;
  reason: string;
}

/**
 * The withdrawal request: awaiting_approval, as every withdrawal needs the
 * owner's approval. With an idempotency_key used before, the earlier request
 * in whatever state it is now, marked idempotent.
 */
export interface WithdrawResponse {
  withdrawal_id: string;
  reference_id?: string;
  status: TransactionStatus;
  amount_usdc: number;
  network_fee_usdc: number;
  you_receive_usdc: number;
  fee_breakdown?: FeeBreakdown;
  to_address: string;
  /** The rule that asked for approval */
  reason?: string;
  message?: string;
  idempotent?: boolean;
  approval_id?: string;
  approval_url?: string;
  expires_at?: string;
  created_at?: string;
  next_step?: string;
  confirm_command?: string;
  [key: string]: unknown;
}

export interface GetWithdrawalParams {
  withdrawal_id: string;
}

export interface GetWithdrawalResponse {
  withdrawal_id: string;
  status: TransactionStatus;
  amount_usdc: number;
  network_fee_usdc: number;
  you_receive_usdc: number;
  fee_breakdown?: FeeBreakdown;
  to_address: string;
  created_at: string;
  completed_at?: string;
  /** The Solana signature once it was sent */
  solana_tx?: string;
  next_step?: string;
  confirm_command?: string;
  ready_to_confirm?: boolean;
  approval_url?: string;
  message?: string;
}

// -----------------------------------------------------------------------------
// Response Types - History
// -----------------------------------------------------------------------------

export interface TransactionsParams {
  type?: 'all' | 'in' | 'out';
  limit?: number;
  offset?: number;
}

export interface TransactionRecord {
  id: string;
  reference_id: string;
  type: TransactionType;
  status: TransactionStatus;
  /** Negative for money going out */
  amount_usdc: number;
  fee_usdc: number;
  /** What the transaction changed the balance by */
  net_usdc: number;
  balance_after_usdc: number | null;
  counterparty: string;
  counterparty_address: string;
  description: string | null;
  timestamp: string;
}

export interface TransactionsResponse {
  transactions: TransactionRecord[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

// -----------------------------------------------------------------------------
// Response Types - Guard Rails
// -----------------------------------------------------------------------------

/** The owner's guard rails, in USD. Null means no limit is set. */
export interface MyLimitsResponse {
  /** Payments up to this go through without the owner's approval */
  auto_approve_max: number;
  /** Payments above this are refused */
  hard_cap: number | null;
  hard_cap_budget: number | null;
  hard_cap_budget_period: string;
  budget: number | null;
  budget_period: string;
  spent_this_period: number;
  remaining_budget: number | null;
  firewall_enabled: boolean;
  recipient_whitelist: string[] | null;
  recipient_blacklist: string[] | null;
  allow_withdrawal_requests: boolean;
  max_withdrawal: number | null;
  allow_paylinks: boolean;
  max_paylink_amount: number | null;
  balance: number;
  guard_rails_portal: string;
  message: string;
}

export interface PendingApprovalRecord {
  approval_id: string;
  type: ApprovalType;
  amount_usdc: number;
  to: string | null;
  to_type: 'merchant' | 'wallet' | 'address' | null;
  reason: string;
  note: string | null;
  created_at: string;
  expires_at: string;
  approval_url: string;
}

export interface PendingApprovalsResponse {
  pending: PendingApprovalRecord[];
  count: number;
}

// -----------------------------------------------------------------------------
// Response Types - Spending (extended)
// -----------------------------------------------------------------------------

export interface ListPaymentsParams {
  transaction_id?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface PaymentRecord {
  transaction_id: string;
  reference_id: string;
  status: TransactionStatus;
  to?: string;
  to_name?: string;
  to_address?: string;
  amount_usdc: number;
  fee_usdc: number;
  total_usdc: number;
  description: string | null;
  solana_signature: string | null;
  created_at: string;
  expires_at: string | null;
  completed_at: string | null;
  /** Whether botwallet_confirm_payment can finish it now */
  can_confirm: boolean;
}

/** The list, or with transaction_id just that payment. */
export type ListPaymentsResponse =
  | { payments: PaymentRecord[]; count: number; offset: number; limit: number }
  | { payment: PaymentRecord };

export interface CancelPaymentParams {
  transaction_id: string;
}

export interface CancelPaymentResponse {
  cancelled: boolean;
  transaction_id: string;
}

export interface ConfirmPaymentParams {
  transaction_id: string;
}

export interface ConfirmPaymentResponse {
  transaction_id: string;
  message: string;
  [key: string]: unknown;
}

export interface ConfirmWithdrawalParams {
  withdrawal_id: string;
}

export interface ConfirmWithdrawalResponse {
  transaction_id: string;
  message: string;
  [key: string]: unknown;
}

// -----------------------------------------------------------------------------
// Response Types - Wallet (extended)
// -----------------------------------------------------------------------------

export interface UpdateNameParams {
  name: string;
}

export interface UpdateNameResponse {
  updated: boolean;
  name: string;
  username: string;
}

// -----------------------------------------------------------------------------
// Response Types - Earning (extended)
// -----------------------------------------------------------------------------

export interface SendPaylinkInvitationParams {
  request_id: string;
  to_email?: string;
  to_wallet?: string;
  message?: string;
}

export interface SendPaylinkInvitationResponse {
  sent: boolean;
  request_id: string;
  sent_to: string;
  method: string;
  message?: string;
}

// -----------------------------------------------------------------------------
// Response Types - History (extended)
// -----------------------------------------------------------------------------

export interface ApprovalStatusParams {
  approval_id: string;
}

export interface ApprovalStatusResponse {
  approval_id: string;
  type: ApprovalType;
  status: ApprovalStatus;
  amount_usdc: number;
  recipient: string | null;
  note: string | null;
  triggered_by: string;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  rejection_reason: string | null;
  /** Approved, so the transfer can be confirmed now */
  actionable: boolean;
  /** The payment, withdrawal or paid API call (its fetch_id) the approval is for */
  transaction_id: string | null;
  next_step: string | null;
  /** The CLI command that confirms it */
  confirm_command: string | null;
  [key: string]: unknown;
}

export interface EventsParams {
  types?: string[];
  limit?: number;
  unread_only?: boolean;
  since?: string;
}

export interface EventRecord {
  id: string;
  type: string;
  title: string;
  message: string;
  severity: string;
  related_id?: string;
  related_type?: string;
  metadata?: Record<string, unknown>;
  is_read: boolean;
  created_at: string;
}

export interface EventsResponse {
  events: EventRecord[];
  count: number;
  total_matching: number;
  unread_count: number;
  tip: string;
}

export interface MarkReadParams {
  event_ids?: string[];
  all?: boolean;
}

export interface MarkReadResponse {
  marked_read: number;
  message?: string;
}

// -----------------------------------------------------------------------------
// Response Types - FROST Signing
// -----------------------------------------------------------------------------

export interface FrostSignInitParams {
  transaction_id: string;
  nonce_commitment: string;
}

export interface FrostSignInitResponse {
  session_id: string;
  server_nonce_commitment: string;
  group_key: string;
  message?: string;
  [key: string]: unknown;
}

export interface FrostSignCompleteParams {
  session_id: string;
  partial_sig: string;
}

/** A payment or withdrawal the chain confirmed (frost_sign_complete) */
export interface FrostSignCompleteResponse {
  paid: true;
  status: 'completed';
  transaction_id: string;
  reference_id: string;
  solana_signature: string;
  explorer_url: string;
  to?: string;
  to_address?: string;
  amount_usdc: number;
  fee_usdc: number;
  new_balance_usdc: number;
  network: string;
  signing_method: string;
  /** Set when the new balance is below the owner's alert threshold */
  low_balance?: boolean;
  funding_url?: string;
  [key: string]: unknown;
}

// -----------------------------------------------------------------------------
// Response Types - DKG
// -----------------------------------------------------------------------------

export interface DkgInitParams {
  name: string;
  agent_model?: string;
  owner_email?: string;
  metadata?: Record<string, string>;
}

export interface DkgInitResponse {
  session_id: string;
  server_public_share: string;
  [key: string]: unknown;
}

export interface DkgCompleteParams {
  session_id: string;
  agent_public_share: string;
  group_public_key: string;
}

export interface DkgCompleteResponse {
  wallet_id: string;
  username: string;
  api_key: string;
  deposit_address: string;
  funding_url: string;
  claim_code: string;
  claim_url: string;
  claim_expires_at: string;
  message: string;
  pledged_to?: string;
  owner_found?: boolean;
  owner_notified?: boolean;
}

// -----------------------------------------------------------------------------
// Response Types - x402
// -----------------------------------------------------------------------------

export interface X402PrepareParams {
  url: string;
  pay_to: string;
  amount: string;
  network: string;
  method: string;
  /** The token mint the API priced in, from its payment option. Servers that don't know it ignore it. */
  asset?: string;
  /** The payment option's x402 scheme ("exact"). Servers that don't know it ignore it. */
  scheme?: string;
}

export interface X402PrepareResponse {
  fetch_id: string;
  status: string;
  url: string;
  amount_usdc: number;
  fee_usdc: number;
  total_usdc: number;
  fee_breakdown?: FeeBreakdown;
  pay_to: string;
  network: string;
  [key: string]: unknown;
}

export interface X402ConfirmParams {
  fetch_id: string;
}

export interface X402ConfirmResponse {
  transaction_id: string;
  message: string;
  url: string;
  method: string;
  network: string;
  to_address: string;
  amount_usdc: number;
  fee_usdc: number;
  total_usdc: number;
  [key: string]: unknown;
}

export interface X402SignCompleteParams {
  session_id: string;
  partial_sig: string;
}

export interface X402SignCompleteResponse {
  signed_transaction: string;
  [key: string]: unknown;
}

export interface X402SettleParams {
  fetch_id: string;
  success: boolean;
  response_status: number;
  error_message?: string;
}

export interface X402SettleResponse {
  settled: boolean;
  amount_usdc?: number;
  new_balance_usdc?: number;
  transaction_id?: string;
  [key: string]: unknown;
}

// -----------------------------------------------------------------------------
// Response Types - Wallet Transfer
// -----------------------------------------------------------------------------

export interface WalletExportResponse {
  export_id: string;
  encryption_key: string;
}

export interface WalletImportKeyParams {
  export_id: string;
}

export interface WalletImportKeyResponse {
  // Only the decryption key: the API key travels inside the encrypted file
  encryption_key: string;
}

// -----------------------------------------------------------------------------
// Error Types
// -----------------------------------------------------------------------------

export interface ApiErrorResponse {
  error: string;
  message: string;
  how_to_fix?: string;
  [key: string]: unknown;
}

