// What the agent agreed to send, kept between the tool that starts a transfer
// and the tool that signs it.
//
// botwallet_pay, botwallet_withdraw and botwallet_x402_fetch record the amount,
// recipient and quoted fee the agent asked for. When the same MCP session later
// signs that transfer (after an owner approval, for example), Key 1 checks the
// transaction against this record instead of only against what the server
// reports at confirm time. Kept in memory only: after a restart the signing
// tools fall back to the server's own figures, still within the fee ceiling.

export interface AgreedTransfer {
  /** What the recipient gets, in USDC base units. */
  amount: bigint;
  /** When true, `amount` is the exact amount rounded up to a whole cent. */
  amountRoundedUpToCent?: boolean;
  /** The recipient's wallet address, when the agent gave one. */
  recipient?: string;
  /** The fee the agent was quoted, in USDC base units. */
  quotedFee?: bigint;
}

const MAX_RECORDS = 500;
const agreed = new Map<string, AgreedTransfer>();

/** Remember what the agent agreed to for a transaction (or x402 fetch) id. */
export function rememberAgreedTransfer(id: string, transfer: AgreedTransfer): void {
  agreed.delete(id);
  agreed.set(id, transfer);
  while (agreed.size > MAX_RECORDS) {
    const oldest = agreed.keys().next().value;
    if (oldest === undefined) break;
    agreed.delete(oldest);
  }
}

export function agreedTransferFor(id: string): AgreedTransfer | undefined {
  return agreed.get(id);
}

export function forgetAgreedTransfer(id: string): void {
  agreed.delete(id);
}
