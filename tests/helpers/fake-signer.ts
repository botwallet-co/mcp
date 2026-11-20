// The server half of FROST signing, for offline tests: holds Key 2, answers
// frost_sign_init and frost_sign_complete like supabase/functions/bot/handlers/
// frost-signing.ts, checks the agent's partial signature and checks that the
// aggregated signature is a valid Ed25519 signature by the wallet address.

import { vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { base58 } from '@scure/base';
import {
  aggregateSignatures,
  computeGroupKey,
  generateKeyShare,
  generateNonce,
  keyShareFromMnemonic,
  partialSign,
  verifyPartialSig,
} from '../../src/frost/index.js';
import type { SigningNonce } from '../../src/frost/types.js';

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const unb64 = (text: string) => Uint8Array.from(Buffer.from(text, 'base64'));

interface Session {
  transactionId: string;
  agentCommitment: Uint8Array;
  serverNonce: SigningNonce;
}

export interface CompletedSigning {
  transactionId: string;
  message: Uint8Array;
  signature: Uint8Array;
}

export class FakeSigner {
  readonly groupKey: Uint8Array;
  readonly walletAddress: string;
  private readonly agentPublic: Uint8Array;
  private readonly serverSecret: Uint8Array;
  private readonly messages = new Map<string, string>();
  private readonly sessions = new Map<string, Session>();
  readonly completed: CompletedSigning[] = [];

  constructor(agentMnemonic: string) {
    const agent = keyShareFromMnemonic(agentMnemonic);
    const server = generateKeyShare();
    this.agentPublic = agent.public;
    this.serverSecret = server.secret;
    this.groupKey = computeGroupKey(agent.public, server.public);
    this.walletAddress = base58.encode(this.groupKey);
  }

  /** What confirm_payment / confirm_withdrawal / x402_confirm stores as message_to_sign. */
  storeMessage(transactionId: string, message: Uint8Array): string {
    const encoded = b64(message);
    this.messages.set(transactionId, encoded);
    return encoded;
  }

  frostSignInit(params: { transaction_id: string; nonce_commitment: string }): Record<string, unknown> {
    const stored = this.messages.get(params.transaction_id);
    if (!stored) throw new Error(`no message stored for ${params.transaction_id}`);
    const serverNonce = generateNonce();
    const sessionId = `session-${this.sessions.size + 1}`;
    this.sessions.set(sessionId, {
      transactionId: params.transaction_id,
      agentCommitment: unb64(params.nonce_commitment),
      serverNonce,
    });
    return {
      session_id: sessionId,
      server_nonce_commitment: b64(serverNonce.commitment),
      group_key: b64(this.groupKey),
      message_to_sign: stored,
    };
  }

  /** Aggregates like frost_sign_complete; returns the final signature. */
  complete(params: { session_id: string; partial_sig: string }): CompletedSigning {
    const session = this.sessions.get(params.session_id);
    if (!session) throw new Error('unknown session');
    this.sessions.delete(params.session_id);
    const message = unb64(this.messages.get(session.transactionId)!);
    const server = partialSign(message, this.serverSecret, session.serverNonce, session.agentCommitment, this.groupKey);
    const agentPartial = unb64(params.partial_sig);
    if (!verifyPartialSig(agentPartial, session.agentCommitment, this.agentPublic, server.challenge)) {
      throw new Error('agent partial signature does not verify');
    }
    const signature = aggregateSignatures(server.groupNonce, agentPartial, server.partialSig);
    if (!ed25519.verify(signature, message, this.groupKey)) {
      throw new Error('aggregated signature does not verify');
    }
    const done = { transactionId: session.transactionId, message, signature };
    this.completed.push(done);
    return done;
  }

  /** The API's signing calls, answered by this fake server (as vi.fn, so a test can change one). */
  sdkMethods() {
    return {
      frostSignInit: vi.fn(async (p: { transaction_id: string; nonce_commitment: string }) => this.frostSignInit(p)),
      frostSignComplete: vi.fn(async (p: { session_id: string; partial_sig: string }) => {
        const done = this.complete(p);
        return { paid: true, transaction_id: done.transactionId, solana_signature: base58.encode(done.signature) };
      }),
      x402SignComplete: vi.fn(async (p: { session_id: string; partial_sig: string }) => {
        this.complete(p);
        return { signed_transaction: 'AQID' };
      }),
    };
  }
}
