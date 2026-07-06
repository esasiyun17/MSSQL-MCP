/**
 * Helpers shared by all MCP tools: safe table-name parsing, allowlist
 * enforcement and uniform result/error formatting.
 */

import { QueryRejectedError, toSafeMessage } from '../errors.js';
import { normalizeTableName } from '../config.js';
import { isTableAllowed } from '../query-guard.js';
import { tokenize, TokenizeError } from '../tokenizer.js';

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(err: unknown): ToolResult {
  return { content: [{ type: 'text', text: toSafeMessage(err) }], isError: true };
}

export interface TableRef {
  /** Normalized "schema.table" (schema defaults to dbo). */
  normalized: string;
  /** Safely bracket-quoted "[schema].[table]" for embedding in SQL. */
  quoted: string;
}

/**
 * Parse a user-supplied table name ("Orders", "dbo.Orders", "[dbo].[My Table]")
 * into a safe, bracket-quoted reference. Rejects anything that is not a plain
 * one- or two-part identifier — this is what makes it safe to embed in SQL.
 */
export function parseTableRef(input: string): TableRef {
  let tokens;
  try {
    tokens = tokenize(input);
  } catch (err) {
    if (err instanceof TokenizeError) {
      throw new QueryRejectedError('invalid-table-name', `Invalid table name: ${err.message}`);
    }
    throw err;
  }

  const parts: string[] = [];
  let expectName = true;
  for (const token of tokens) {
    if (expectName && (token.type === 'word' || token.type === 'ident')) {
      parts.push(token.value);
      expectName = false;
    } else if (!expectName && token.type === 'punct' && token.value === '.') {
      expectName = true;
    } else {
      throw new QueryRejectedError(
        'invalid-table-name',
        `Invalid table name "${input}": expected "table" or "schema.table".`
      );
    }
  }
  if (expectName || parts.length === 0 || parts.length > 2) {
    throw new QueryRejectedError(
      'invalid-table-name',
      `Invalid table name "${input}": expected "table" or "schema.table".`
    );
  }

  const [schema, table] = parts.length === 2 ? parts : ['dbo', parts[0]];
  const quote = (p: string) => `[${p.replace(/\]/g, ']]')}]`;
  return {
    normalized: normalizeTableName(`${quote(schema)}.${quote(table)}`),
    quoted: `${quote(schema)}.${quote(table)}`,
  };
}

/** Enforce ALLOWED_TABLES (no-op when the list is empty). */
export function assertTableAllowed(ref: TableRef, allowedTables: string[]): void {
  if (allowedTables.length === 0) return;
  if (!isTableAllowed(ref.normalized, allowedTables)) {
    throw new QueryRejectedError(
      'table-not-allowed',
      `Rejected (rule: table-not-allowed): table "${ref.normalized}" is not on the configured ALLOWED_TABLES list.`
    );
  }
}
