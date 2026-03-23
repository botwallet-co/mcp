// =============================================================================
// Botwallet SDK
// =============================================================================
// Payment infrastructure for AI agents
// 
// @example
// ```typescript
// import { BotWallet } from '@botwallet/sdk';
// 
// const wallet = new BotWallet({ apiKey: 'bw_bot_...' });
// const balance = await wallet.balance();
// ```
// =============================================================================

// Client
export { BotWallet, createBotWallet } from './client.js';

// Errors
export {
  BotWalletError,
  UnauthorizedError,
  InsufficientFundsError,
  RecipientNotFoundError,
  GuardRailError,
  NetworkError,
  TimeoutError,
} from './errors.js';

// Types
export type {
  // Config
  BotWalletConfig,
  
  // Common
  WalletStatus,
  PaymentRequestStatus,
  TransactionType,
  TransactionStatus,
  ApprovalStatus,
  RecipientType,
  
  // Basics
  PingResponse,
  RegisterParams,
  RegisterResponse,
  InfoResponse,
  BalanceResponse,
  UpdateOwnerParams,
  UpdateOwnerResponse,
  UpdateNameParams,
  UpdateNameResponse,
  
  // DKG
  DkgInitParams,
  DkgInitResponse,
  DkgCompleteParams,
  DkgCompleteResponse,
  
  // Spending
  LookupParams,
  LookupResponse,
  CanIAffordParams,
  CanIAffordResponse,
  PayParams,
  PayResponse,
  PaySuccessResponse,
  PayApprovalResponse,
  ListPaymentsParams,
  ListPaymentsResponse,
  CancelPaymentParams,
  CancelPaymentResponse,
  ConfirmPaymentParams,
  ConfirmPaymentResponse,
  
  // Earning
  CreatePaymentRequestParams,
  CreatePaymentRequestResponse,
  GetPaymentRequestParams,
  GetPaymentRequestResponse,
  ListPaymentRequestsParams,
  ListPaymentRequestsResponse,
  PaymentRequestSummary,
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
  FundRequestRecord,
  
  // Withdrawals
  WithdrawParams,
  WithdrawResponse,
  WithdrawProcessingResponse,
  WithdrawApprovalResponse,
  ConfirmWithdrawalParams,
  ConfirmWithdrawalResponse,
  GetWithdrawalParams,
  GetWithdrawalResponse,
  
  // History
  TransactionsParams,
  TransactionsResponse,
  TransactionRecord,
  
  // Limits
  MyLimitsResponse,
  SpendingLimits,
  RecipientRestrictions,
  EarningLimits,
  WithdrawalLimits,
  PendingApprovalsResponse,
  PendingApprovalRecord,
  ApprovalStatusParams,
  ApprovalStatusResponse,
  
  // Events
  EventsParams,
  EventsResponse,
  EventRecord,
  MarkReadParams,
  MarkReadResponse,
  
  // FROST Signing
  FrostSignInitParams,
  FrostSignInitResponse,
  FrostSignCompleteParams,
  FrostSignCompleteResponse,
  
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
  
  // Errors
  ApiErrorResponse,
  BotWalletErrorCode,
} from './types.js';

