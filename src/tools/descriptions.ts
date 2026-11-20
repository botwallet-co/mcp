// Text that several tool descriptions share, so a fee or a rule changes in
// one place. The fees are Botwallet's published ones; the server's fee
// settings decide what is charged, and Key 1 never signs more than the fee
// ceiling (FEE_CEILING_BPS in solana/verify-transaction.ts).

export const PAYMENT_FEES =
  'Fees: $0.01 minimum or 1% of the transaction amount, whichever is greater, ' +
  'plus a one-time $0.25 account setup fee if the recipient\'s address has never held USDC.';

export const WITHDRAWAL_FEES =
  'Fees: 3% of the amount (1% platform fee, minimum $0.01, plus a 2% withdrawal surcharge), ' +
  'plus a one-time $0.25 account setup fee if the destination address has never held USDC.';

/** A transfer the server sent that Solana hasn't confirmed yet (SUBMISSION_UNCONFIRMED). */
export function sentPendingHelp(noun: string, dontRepeat: string): string {
  return `A result with \`status: "pending"\` and \`sent: true\` means the ${noun} was sent and Solana has not ` +
    `confirmed it yet: ${dontRepeat}; check \`check_tool\` in about a minute.`;
}

/** OUTCOME_UNKNOWN from a confirm tool: check `usualCheck` before anything else. */
export function confirmOutcomeUnknownHelp(noun: string, usualCheck: string): string {
  return `An error with code OUTCOME_UNKNOWN means the ${noun} may have gone through: check the tool its ` +
    `\`check_tool\` names (usually ${usualCheck}) before doing anything else.`;
}
