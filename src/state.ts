/**
 * Shared server state: the connection pool plus the (memoized) read-only
 * verification outcome. Every query tool calls ensureReadOnly() before
 * touching the database — verification is not just a startup event, it gates
 * each tool invocation.
 */

import type sql from 'mssql';
import type { ServerConfig } from './config.js';
import type { AuditLogger } from './logger.js';
import { connectPool } from './connection.js';
import {
  evaluateReadOnly,
  fetchPermissionSnapshot,
  buildRejectionMessage,
  type VerificationResult,
} from './permission-check.js';
import { ConnectionError, ReadOnlyVerificationError, toSafeMessage } from './errors.js';

export type VerificationOutcome =
  | { status: 'passed'; result: VerificationResult }
  | { status: 'failed'; result: VerificationResult }
  | { status: 'error'; message: string };

export class ServerState {
  private verificationPromise: Promise<VerificationOutcome> | null = null;

  constructor(
    readonly config: ServerConfig,
    readonly pool: sql.ConnectionPool,
    readonly logger: AuditLogger
  ) {}

  /** Run (or reuse) the read-only verification. Connection errors are retried on the next call. */
  verify(): Promise<VerificationOutcome> {
    if (!this.verificationPromise) {
      this.verificationPromise = this.doVerify();
    }
    return this.verificationPromise;
  }

  private async doVerify(): Promise<VerificationOutcome> {
    try {
      await connectPool(this.pool);
      const snapshot = await fetchPermissionSnapshot(this.pool);
      const result = evaluateReadOnly(snapshot);
      return result.readOnly ? { status: 'passed', result } : { status: 'failed', result };
    } catch (err) {
      // Transient (e.g. network) failure: allow a retry on the next tool call.
      this.verificationPromise = null;
      return { status: 'error', message: toSafeMessage(err) };
    }
  }

  /** Throws unless the connected user passed all read-only checks. */
  async ensureReadOnly(): Promise<void> {
    const outcome = await this.verify();
    if (outcome.status === 'passed') return;
    if (outcome.status === 'failed') {
      throw new ReadOnlyVerificationError(
        buildRejectionMessage(outcome.result.violations),
        outcome.result.violations
      );
    }
    throw new ConnectionError(outcome.message);
  }
}
