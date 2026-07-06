/**
 * Connection pool management and streamed query execution.
 *
 * One shared pool for the whole server (tools never open their own
 * connections). Queries run in streaming mode so MAX_ROWS is enforced at the
 * driver level: we cancel the request once the limit is reached instead of
 * buffering an unbounded result set — no TOP clause is injected into the
 * user's SQL.
 */

import sql from 'mssql';
import type { ServerConfig } from './config.js';
import { ConnectionError, QueryExecutionError, toSafeMessage } from './errors.js';

export function createPool(config: ServerConfig): sql.ConnectionPool {
  return new sql.ConnectionPool({
    server: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionTimeout: 15_000,
    requestTimeout: config.queryTimeoutMs,
    options: {
      encrypt: config.encrypt,
      trustServerCertificate: config.trustServerCertificate,
      readOnlyIntent: true,
    },
    pool: { min: 0, max: 4 },
  });
}

export async function connectPool(pool: sql.ConnectionPool): Promise<void> {
  try {
    if (!pool.connected && !pool.connecting) {
      await pool.connect();
    }
  } catch (err) {
    throw new ConnectionError(`Could not connect to SQL Server: ${toSafeMessage(err)}`);
  }
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

/**
 * Execute a (pre-validated) SELECT in streaming mode, cutting the result off
 * at maxRows. When the limit is hit the request is cancelled server-side and
 * `truncated: true` is reported.
 */
export function executeStreamedQuery(
  pool: sql.ConnectionPool,
  sqlText: string,
  maxRows: number
): Promise<QueryResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const request = pool.request();
    request.stream = true;
    request.arrayRowMode = true;

    const columns: string[] = [];
    const rows: unknown[][] = [];
    let truncated = false;
    let settled = false;

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(new QueryExecutionError(toSafeMessage(err)));
    };

    request.on('recordset', (meta: unknown) => {
      // With arrayRowMode the metadata is an array of column descriptors;
      // fall back to object keys for safety across driver versions.
      columns.length = 0;
      if (Array.isArray(meta)) {
        for (const col of meta as Array<{ name?: string }>) columns.push(col?.name ?? '');
      } else if (meta && typeof meta === 'object') {
        columns.push(...Object.keys(meta as Record<string, unknown>));
      }
    });

    request.on('row', (row: unknown[]) => {
      if (truncated) return;
      if (rows.length >= maxRows) {
        truncated = true;
        request.cancel();
        return;
      }
      rows.push(row);
    });

    request.on('error', (err: Error & { code?: string }) => {
      // Cancelling at the row limit surfaces as ECANCEL — that is expected.
      if (truncated && err.code === 'ECANCEL') return;
      fail(err);
    });

    request.on('done', () => {
      if (settled) return;
      settled = true;
      resolve({
        columns,
        rows,
        rowCount: rows.length,
        truncated,
        durationMs: Date.now() - start,
      });
    });

    request.query(sqlText);
  });
}
