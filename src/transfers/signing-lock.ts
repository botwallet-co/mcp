// Transactions this process is signing right now. A second call for the same
// transaction while the first is still running would ask the server to build
// and sign it again, so it is turned away instead.

const signing = new Set<string>();

export class SigningInProgressError extends Error {
  constructor(readonly transactionId: string) {
    super(`Transaction ${transactionId} is already being signed by another request.`);
    this.name = 'SigningInProgressError';
  }
}

/** Run `fn` while holding the signing lock for one transaction. */
export async function withSigningLock<T>(transactionId: string, fn: () => Promise<T>): Promise<T> {
  if (signing.has(transactionId)) throw new SigningInProgressError(transactionId);
  signing.add(transactionId);
  try {
    return await fn();
  } finally {
    signing.delete(transactionId);
  }
}
