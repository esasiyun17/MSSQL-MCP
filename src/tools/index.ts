/**
 * MCP tool registration.
 *
 * If the startup read-only verification FAILED (the user has write
 * privileges), only `verify_connection` is registered — the server exposes no
 * query capability at all. Every query tool additionally re-checks the
 * verification via state.ensureReadOnly() as a second line of defense.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ServerState } from '../state.js';
import { executeStreamedQuery } from '../connection.js';
import { guardQuery } from '../query-guard.js';
import { buildRejectionMessage } from '../permission-check.js';
import { jsonResult, errorResult, parseTableRef, assertTableAllowed } from './shared.js';

export function registerVerifyConnectionTool(server: McpServer, state: ServerState): void {
  server.registerTool(
    'verify_connection',
    {
      title: 'Verify connection & read-only status',
      description:
        'Verify the database connection and report the read-only verification result: ' +
        'which checks ran (server roles, database roles, effective permissions), which passed, ' +
        'and any write privileges that were detected. Use this to diagnose why the server ' +
        'refuses to expose query tools.',
    },
    async () => {
      const outcome = await state.verify();
      if (outcome.status === 'error') {
        return errorResult(`Connection failed: ${outcome.message}`);
      }
      const report = {
        connected: true,
        host: state.config.host,
        database: state.config.database,
        user: state.config.user,
        readOnly: outcome.status === 'passed',
        checks: outcome.result.checks,
        violations: outcome.result.violations,
        ...(outcome.status === 'failed' ? { message: buildRejectionMessage(outcome.result.violations) } : {}),
      };
      return jsonResult(report);
    }
  );
}

function registerListTablesTool(server: McpServer, state: ServerState): void {
  server.registerTool(
    'list_tables',
    {
      title: 'List tables',
      description:
        'List all tables in the database as schema.table with approximate row counts ' +
        '(taken from sys.partitions metadata — no COUNT(*) is executed). ' +
        'If a table allowlist is configured, only allowed tables are returned.',
    },
    async () => {
      try {
        await state.ensureReadOnly();
        return await state.logger.timed('list_tables', undefined, async () => {
          const result = await state.pool.request().query(
            `SELECT s.name AS [schema], t.name AS [table],
                    SUM(CASE WHEN p.index_id IN (0, 1) THEN p.rows ELSE 0 END) AS [row_count]
             FROM sys.tables t
             JOIN sys.schemas s ON t.schema_id = s.schema_id
             LEFT JOIN sys.partitions p ON t.object_id = p.object_id AND p.index_id IN (0, 1)
             GROUP BY s.name, t.name
             ORDER BY s.name, t.name`
          );
          let tables = result.recordset as Array<{ schema: string; table: string; row_count: number }>;
          const allowed = state.config.allowedTables;
          if (allowed.length > 0) {
            tables = tables.filter((t) => {
              try {
                const ref = parseTableRef(`[${t.schema}].[${t.table}]`);
                assertTableAllowed(ref, allowed);
                return true;
              } catch {
                return false;
              }
            });
          }
          return { ...jsonResult({ tableCount: tables.length, tables }), rowCount: tables.length };
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}

function registerDescribeTableTool(server: McpServer, state: ServerState): void {
  server.registerTool(
    'describe_table',
    {
      title: 'Describe table',
      description:
        'Describe a table: columns (name, type, nullability, identity), primary key, ' +
        'foreign keys and indexes, read from INFORMATION_SCHEMA / sys catalog views. ' +
        'Accepts "Table" or "schema.Table". Subject to the table allowlist if configured.',
      inputSchema: {
        table: z.string().describe('Table name, optionally schema-qualified, e.g. "dbo.Orders"'),
      },
    },
    async ({ table }: { table: string }) => {
      try {
        await state.ensureReadOnly();
        const ref = parseTableRef(table);
        assertTableAllowed(ref, state.config.allowedTables);

        return await state.logger.timed('describe_table', ref.normalized, async () => {
          const request = () => state.pool.request().input('table', ref.quoted);

          const [columns, pk, fks, indexCols] = await Promise.all([
            request().query(
              `SELECT c.name AS [column], ty.name AS [type], c.max_length, c.precision, c.scale,
                      c.is_nullable, c.is_identity
               FROM sys.columns c
               JOIN sys.types ty ON c.user_type_id = ty.user_type_id
               WHERE c.object_id = OBJECT_ID(@table)
               ORDER BY c.column_id`
            ),
            request().query(
              `SELECT kc.name AS constraint_name, col.name AS [column], ic.key_ordinal
               FROM sys.key_constraints kc
               JOIN sys.index_columns ic
                 ON kc.parent_object_id = ic.object_id AND kc.unique_index_id = ic.index_id
               JOIN sys.columns col ON ic.object_id = col.object_id AND ic.column_id = col.column_id
               WHERE kc.[type] = 'PK' AND kc.parent_object_id = OBJECT_ID(@table)
               ORDER BY ic.key_ordinal`
            ),
            request().query(
              `SELECT fk.name AS constraint_name, pc.name AS [column],
                      OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS referenced_schema,
                      OBJECT_NAME(fk.referenced_object_id) AS referenced_table,
                      rc.name AS referenced_column
               FROM sys.foreign_keys fk
               JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
               JOIN sys.columns pc
                 ON fkc.parent_object_id = pc.object_id AND fkc.parent_column_id = pc.column_id
               JOIN sys.columns rc
                 ON fkc.referenced_object_id = rc.object_id AND fkc.referenced_column_id = rc.column_id
               WHERE fk.parent_object_id = OBJECT_ID(@table)`
            ),
            request().query(
              `SELECT i.name AS index_name, i.type_desc, i.is_unique, i.is_primary_key,
                      col.name AS [column], ic.key_ordinal
               FROM sys.indexes i
               JOIN sys.index_columns ic
                 ON i.object_id = ic.object_id AND i.index_id = ic.index_id AND ic.is_included_column = 0
               JOIN sys.columns col ON ic.object_id = col.object_id AND ic.column_id = col.column_id
               WHERE i.object_id = OBJECT_ID(@table) AND i.name IS NOT NULL
               ORDER BY i.name, ic.key_ordinal`
            ),
          ]);

          if (columns.recordset.length === 0) {
            return {
              ...errorResult(`Table "${ref.normalized}" was not found (or is not visible to this user).`),
              rowCount: 0,
            };
          }

          // Aggregate index columns client-side (avoids STRING_AGG, so older
          // SQL Server versions work too).
          interface IndexInfo {
            name: string;
            type: string;
            unique: boolean;
            primaryKey: boolean;
            columns: string[];
          }
          const indexes = new Map<string, IndexInfo>();
          for (const row of indexCols.recordset) {
            const entry: IndexInfo = indexes.get(row.index_name) ?? {
              name: row.index_name,
              type: row.type_desc,
              unique: !!row.is_unique,
              primaryKey: !!row.is_primary_key,
              columns: [],
            };
            entry.columns.push(row.column);
            indexes.set(row.index_name, entry);
          }

          return {
            ...jsonResult({
              table: ref.normalized,
              columns: columns.recordset,
              primaryKey: pk.recordset,
              foreignKeys: fks.recordset,
              indexes: [...indexes.values()],
            }),
            rowCount: columns.recordset.length,
          };
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}

function registerSampleRowsTool(server: McpServer, state: ServerState): void {
  server.registerTool(
    'sample_rows',
    {
      title: 'Sample rows',
      description:
        'Return the first N rows of a table (default 5, maximum 50) to inspect its content. ' +
        'Accepts "Table" or "schema.Table". Subject to the table allowlist if configured.',
      inputSchema: {
        table: z.string().describe('Table name, optionally schema-qualified, e.g. "dbo.Orders"'),
        count: z.number().int().min(1).max(50).optional().describe('Number of rows to return (1-50, default 5)'),
      },
    },
    async ({ table, count }: { table: string; count?: number }) => {
      try {
        await state.ensureReadOnly();
        const ref = parseTableRef(table);
        assertTableAllowed(ref, state.config.allowedTables);
        const n = Math.min(Math.max(count ?? 5, 1), 50);
        const sqlText = `SELECT TOP (${n}) * FROM ${ref.quoted}`;

        return await state.logger.timed('sample_rows', sqlText, async () => {
          const result = await executeStreamedQuery(state.pool, sqlText, n);
          return {
            ...jsonResult({
              table: ref.normalized,
              columns: result.columns,
              rows: result.rows,
              rowCount: result.rowCount,
              durationMs: result.durationMs,
            }),
            rowCount: result.rowCount,
          };
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}

function registerRunQueryTool(server: McpServer, state: ServerState): void {
  server.registerTool(
    'run_query',
    {
      title: 'Run read-only SQL query',
      description:
        'Execute a single read-only SELECT statement (WITH/CTE supported) against the database. ' +
        'Every query is validated first: exactly one statement, SELECT-only, no write/exec keywords, ' +
        'optional table allowlist. Results are truncated at the configured MAX_ROWS ' +
        '(reported via the "truncated" flag) and a query timeout applies. ' +
        'Rejected queries name the exact rule that was violated.',
      inputSchema: {
        sql: z.string().describe('A single T-SQL SELECT statement (CTEs allowed)'),
      },
    },
    async ({ sql: sqlText }: { sql: string }) => {
      try {
        await state.ensureReadOnly();
        guardQuery(sqlText, { allowedTables: state.config.allowedTables });

        return await state.logger.timed('run_query', sqlText, async () => {
          const result = await executeStreamedQuery(state.pool, sqlText, state.config.maxRows);
          return {
            ...jsonResult({
              columns: result.columns,
              rows: result.rows,
              rowCount: result.rowCount,
              truncated: result.truncated,
              ...(result.truncated
                ? { note: `Result truncated at MAX_ROWS=${state.config.maxRows}. Refine the query (e.g. add TOP or filters) to see more specific data.` }
                : {}),
              durationMs: result.durationMs,
            }),
            rowCount: result.rowCount,
            truncated: result.truncated,
          };
        });
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}

/** Register the full query tool set (only called when verification did not fail). */
export function registerQueryTools(server: McpServer, state: ServerState): void {
  registerListTablesTool(server, state);
  registerDescribeTableTool(server, state);
  registerSampleRowsTool(server, state);
  registerRunQueryTool(server, state);
}
