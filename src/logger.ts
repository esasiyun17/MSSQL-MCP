/**
 * Optional JSON-lines audit logger.
 *
 * When LOG_FILE is configured, every tool invocation is appended as one JSON
 * object per line: timestamp, tool name, query text, duration, row count and
 * error (if any). Credentials are never logged — entries only ever contain
 * the fields listed here, and error text is sanitized before it reaches us.
 */

import { appendFile } from 'node:fs/promises';

export interface AuditEntry {
  timestamp: string;
  tool: string;
  query?: string;
  durationMs: number;
  rowCount?: number;
  truncated?: boolean;
  error?: string;
}

export class AuditLogger {
  constructor(private readonly logFile: string | null) {}

  async log(entry: AuditEntry): Promise<void> {
    if (!this.logFile) return;
    try {
      await appendFile(this.logFile, JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
      // Logging must never break query handling; report to stderr only.
      console.error(`[mssql-mcp] audit log write failed: ${(err as Error).message}`);
    }
  }

  /** Convenience wrapper: time an operation and write one audit entry. */
  async timed<T extends { rowCount?: number; truncated?: boolean }>(
    tool: string,
    query: string | undefined,
    fn: () => Promise<T>
  ): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      await this.log({
        timestamp: new Date().toISOString(),
        tool,
        query,
        durationMs: Date.now() - start,
        rowCount: result.rowCount,
        truncated: result.truncated,
      });
      return result;
    } catch (err) {
      await this.log({
        timestamp: new Date().toISOString(),
        tool,
        query,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}
