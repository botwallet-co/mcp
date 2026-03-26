// =============================================================================
// Botwallet SDK Types
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
export type TransactionType = 'deposit' | 'payment' | 'withdrawal' | 'refund' | 'fee' | 'adjustment';
export type TransactionStatus = 'pending' | 'completed' | 'failed' | 'reversed';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
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

export interface RegisterParams {
  /** Display name for your bot (required, 2-50 chars) */
  name: string;
  /** Agent model identifier (e.g., 'gpt-4', 'claude-3') */
  agent_model?: string;
  /** Owner's email - wallet will appear in their portal when they sign up */
  owner_email?: string;
  /** Bot's Solana public key (required — CLI generates keypair locally via FROST DKG) */
  public_key: string;
}

export interface RegisterResponse {
  wallet_id: string;
  username: string;
  api_key: string;
  deposit_address: string;
  funding_url: string;
  claim_code: string;
  claim_url: string;
  claim_expires_at: string;
  message: string;
  /** Email the wallet is pledged to (if owner_email was provided) */
  pledged_to?: string;
  /** Whether the owner email exists in the system */
  owner_found?: boolean;
  /** Whether the owner was notified (if they exist) */
  owner_notified?: boolean;
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
  is_claimed: boolean;
  balance: number;
  deposit_address: string;
  funding_url: string;
  created_at: string;
  last_active_at: string | null;
  low_balance?: boolean;
  low_balance_threshold?: number;
}

export interface BalanceResponse {
  balance: number;
  balance_usdc: number;
  deposit_address: string;
  token_account?: string;
  source: string;
  network: string;
  rpc_provider?: string;
  budget: number;
  budget_period: string;
  spent_this_period: number;
  remaining_budget: number;
  funding_url: string;
  low_balance: boolean;
  low_balance_threshold: number;
  last_reconciled_at?: string;
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
  // Success fields
  to?: string;
  to_name?: string;
  amount?: number;
  fee?: number;
  total?: number;
  fee_breakdown?: FeeBreakdown;
  balance_after?: number;
  // Failure fields
  reason?: string;
  message?: string;
  balance?: number;
  required?: number;
  shortfall?: number;
  funding_url?: string;
  approval_threshold?: number;
  daily_limit?: number;
  spent_today?: number;
  remaining_today?: number;
}

export interface PayParams {
  /** Username of recipient (merchant or bot) */
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

export interface PayPreApprovedResponse {
  status: 'pre_approved';
  transaction_id: string;
  reference_id: string;
  to: string;
  to_name: string;
  amount_usdc: number;
  fee_usdc: number;
  total_usdc: number;
  fee_breakdown?: FeeBreakdown;
  balance_usdc: number;
  expires_at: string;
  created_at: string;
  message: string;
  next_step: 'confirm';
  confirm_command: string;
}

export interface PayApprovalResponse {
  status: 'awaiting_approval';
  transaction_id: string;
  reference_id: string;
  approval_id: string;
  to: string;
  to_name: string;
  amount_usdc: number;
  fee_usdc: number;
  total_usdc: number;
  fee_breakdown?: FeeBreakdown;
  balance_usdc: number;
  expires_at: string;
  created_at: string;
  message: string;
  approval_reason: string;
  approval_url: string;
  next_step: 'wait_for_approval';
  confirm_command: string;
  check_command: string;
}

export interface PaySuccessResponse {
  paid: true;
  transaction_id: string;
  to: string;
  to_name: string;
  amount: number;
  fee: number;
  new_balance: number;
  low_balance?: boolean;
  funding_url?: string;
}

export type PayResponse = PayPreApprovedResponse | PayApprovalResponse | PaySuccessResponse;

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

export interface WithdrawApprovalResponse {
  status: 'awaiting_approval';
  withdrawal_id: string;
  approval_id: string;
  amount_usdc: number;
  network_fee_usdc: number;
  you_receive_usdc: number;
  fee_breakdown?: FeeBreakdown;
  to_address: string;
  reason: string;
  message: string;
  approval_url: string;
  next_step: 'wait_for_approval';
  confirm_command: string;
}

export type WithdrawResponse = WithdrawApprovalResponse | Record<string, unknown>;

export interface GetWithdrawalParams {
  withdrawal_id: string;
}

export interface GetWithdrawalResponse {
  withdrawal_id: string;
  status: TransactionStatus;
  amount: number;
  network_fee: number;
  you_received: number;
  fee_breakdown?: FeeBreakdown;
  to_address: string;
  created_at: string;
  completed_at?: string;
  solana_tx?: string;
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
  amount: number;
  fee: number;
  net: number;
  balance_after: number;
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

export interface SpendingLimits {
  max_per_transaction: number | null;
  daily_limit: number | null;
  approval_required_above: number | null;
  spent_today: number;
  remaining_today: number | null;
}

export interface RecipientRestrictions {
  allow_bot_payments: boolean;
  bot_whitelist: string[] | null;
  merchant_whitelist: string[] | null;
  merchant_blacklist: string[] | null;
}

export interface EarningLimits {
  allow_payment_requests: boolean;
  max_payment_request: number | null;
}

export interface WithdrawalLimits {
  allowed: boolean;
  requires_approval: boolean;
  address_whitelist: string[] | null;
  min: number;
  max: number | null;
}

export interface MyLimitsResponse {
  spending: SpendingLimits;
  recipients: RecipientRestrictions;
  earning: EarningLimits;
  withdrawals: WithdrawalLimits;
  controlled_by: 'owner' | 'defaults';
}

export interface PendingApprovalRecord {
  approval_id: string;
  type: 'payment' | 'withdrawal';
  amount: number;
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

export interface ListPaymentsResponse {
  payments: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

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
  type: 'payment' | 'withdrawal';
  status: ApprovalStatus;
  amount: number;
  created_at: string;
  resolved_at?: string;
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

export interface FrostSignCompleteResponse {
  success: boolean;
  transaction_id?: string;
  solana_signature?: string;
  new_balance?: number;
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
// Response Types - x402 Discovery
// -----------------------------------------------------------------------------

export interface X402DiscoverParams {
  query?: string;
  source?: 'catalog' | 'bazaar';
  limit?: number;
  offset?: number;
}

export interface X402DiscoverResponse {
  apis: Record<string, unknown>[];
  total: number;
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
  encryption_key: string;
  api_key?: string;
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

export type BotWalletErrorCode =
  | 'UNAUTHORIZED'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'INSUFFICIENT_FUNDS'
  | 'RECIPIENT_NOT_FOUND'
  | 'RECIPIENT_INACTIVE'
  | 'RECIPIENT_SUSPENDED'
  | 'DAILY_LIMIT'
  | 'MAX_PER_TRANSACTION'
  | 'APPROVAL_REQUIRED'
  | 'WALLET_SUSPENDED'
  | 'EXPIRED'
  | 'INVALID_STATUS'
  | 'DUPLICATE_REQUEST'
  | 'INTERNAL_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT';


