// The Botwallet API client this package uses (client.ts), its errors and the
// API types other modules use. Internal: it is not published as an SDK.

export { BotWallet } from './client.js';

export {
  BotWalletError,
  UnauthorizedError,
  InsufficientFundsError,
  RecipientNotFoundError,
  GuardRailError,
  NetworkError,
  TimeoutError,
} from './errors.js';

export {
  hasCode,
  isNoAnswer,
  isFrozenWallet,
  isSentUnconfirmed,
  isAlreadyCompleted,
  isPendingStatusError,
  isOwnerSigning,
  isListedAsFailed,
} from './error-codes.js';

export type {
  DkgCompleteParams,
  DkgCompleteResponse,
  InfoResponse,
  X402ConfirmResponse,
  X402SettleParams,
} from './types.js';
