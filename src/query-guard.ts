/**
 * Query-level defense in depth.
 *
 * Even though the server refuses to start with a user that has write
 * permissions, every query still passes ALL of these filters — never trust a
 * single layer:
 *
 *   1. Exactly one statement (semicolons inside strings/comments don't count).
 *   2. The statement must start with SELECT, or WITH ... SELECT (CTE).
 *   3. Keyword blacklist (word-boundary aware, case-insensitive) including
 *      INTO (SELECT ... INTO creates a table) and sp_/xp_ prefixes.
 *   4. Optional table allowlist: every table referenced after FROM/JOIN must
 *      be on the list (schema-qualified names supported, CTE names exempt).
 *
 * Rejections carry the machine-readable rule that fired plus a clear message.
 */

import { QueryRejectedError } from './errors.js';
import { normalizeTableName } from './config.js';
import { tokenize, TokenizeError, type Token } from './tokenizer.js';

export const BLACKLISTED_KEYWORDS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'DROP',
  'CREATE',
  'ALTER',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'DENY',
  'EXEC',
  'EXECUTE',
  'OPENROWSET',
  'OPENQUERY',
  'OPENDATASOURCE',
  'BULK',
  'BACKUP',
  'RESTORE',
  'SHUTDOWN',
  'KILL',
  'RECONFIGURE',
  'WAITFOR',
  'INTO',
]);

const BLACKLISTED_PREFIXES = ['sp_', 'xp_'];

export interface GuardOptions {
  /** Normalized allowlist (see config.parseAllowedTables). Empty = no table restriction. */
  allowedTables?: string[];
}

export interface GuardResult {
  /** Tables referenced by the query (normalized, CTE names excluded). */
  tables: string[];
}

/**
 * Validate a query against all defense rules.
 * Throws QueryRejectedError naming the violated rule; returns table info on success.
 */
export function guardQuery(sql: string, options: GuardOptions = {}): GuardResult {
  if (!sql || sql.trim().length === 0) {
    throw new QueryRejectedError('empty-query', 'Rejected (rule: empty-query): the query is empty.');
  }

  let tokens: Token[];
  try {
    tokens = tokenize(sql);
  } catch (err) {
    if (err instanceof TokenizeError) {
      throw new QueryRejectedError(
        'unparsable',
        `Rejected (rule: unparsable): ${err.message}. Unterminated strings or comments are not allowed.`
      );
    }
    throw err;
  }

  if (tokens.length === 0) {
    throw new QueryRejectedError('empty-query', 'Rejected (rule: empty-query): the query contains no statement.');
  }

  // Rule 1 — single statement. Semicolons are punct tokens here, so literals
  // like WHERE note = 'a;b' can never trigger a false positive.
  const semicolonIdx = tokens.findIndex((t) => t.type === 'punct' && t.value === ';');
  if (semicolonIdx !== -1) {
    const rest = tokens.slice(semicolonIdx).filter((t) => !(t.type === 'punct' && t.value === ';'));
    if (rest.length > 0) {
      throw new QueryRejectedError(
        'multiple-statements',
        'Rejected (rule: multiple-statements): only a single statement is allowed per query.'
      );
    }
  }

  // Rule 2 — must start with SELECT or WITH (CTE).
  const first = tokens[0];
  const firstWord = first.type === 'word' ? first.value.toUpperCase() : '';
  if (firstWord !== 'SELECT' && firstWord !== 'WITH') {
    throw new QueryRejectedError(
      'not-a-select',
      'Rejected (rule: not-a-select): only SELECT statements (optionally starting with a WITH/CTE clause) are allowed.'
    );
  }

  // Rule 3 — keyword blacklist on word tokens (strings/comments already excluded).
  for (const token of tokens) {
    if (token.type !== 'word') continue;
    const upper = token.value.toUpperCase();
    if (BLACKLISTED_KEYWORDS.has(upper)) {
      throw new QueryRejectedError(
        'blacklisted-keyword',
        `Rejected (rule: blacklisted-keyword): the keyword "${upper}" is not allowed. ` +
          'This server only executes read-only SELECT queries.'
      );
    }
    const lower = token.value.toLowerCase();
    for (const prefix of BLACKLISTED_PREFIXES) {
      if (lower.startsWith(prefix)) {
        throw new QueryRejectedError(
          'blacklisted-procedure-prefix',
          `Rejected (rule: blacklisted-procedure-prefix): identifiers starting with "${prefix}" ` +
            `(found "${token.value}") are not allowed.`
        );
      }
    }
  }

  // Rule 4 — table allowlist.
  const cteNames = collectCteNames(tokens);
  const tables = extractTableNames(tokens).filter((t) => !cteNames.has(t));

  const allowed = options.allowedTables ?? [];
  if (allowed.length > 0) {
    for (const table of tables) {
      if (table.split('.').length > 2) {
        throw new QueryRejectedError(
          'cross-database-reference',
          `Rejected (rule: cross-database-reference): "${table}" uses a three-or-more part name. ` +
            'Cross-database references are not allowed when ALLOWED_TABLES is configured.'
        );
      }
      if (!isTableAllowed(table, allowed)) {
        throw new QueryRejectedError(
          'table-not-allowed',
          `Rejected (rule: table-not-allowed): table "${table}" is not on the configured ALLOWED_TABLES list.`
        );
      }
    }
  }

  return { tables };
}

/**
 * Check a normalized table name against the normalized allowlist.
 * Names without a schema are treated as schema "dbo" on both sides.
 */
export function isTableAllowed(table: string, allowedTables: string[]): boolean {
  const [qSchema, qTable] = splitSchemaTable(table);
  return allowedTables.some((entry) => {
    const [eSchema, eTable] = splitSchemaTable(entry);
    return eSchema === qSchema && eTable === qTable;
  });
}

function splitSchemaTable(name: string): [string, string] {
  const parts = name.split('.');
  if (parts.length === 1) return ['dbo', parts[0]];
  return [parts[parts.length - 2], parts[parts.length - 1]];
}

/** Keywords that terminate a FROM list (so aliases/commas stop being table refs). */
const FROM_LIST_TERMINATORS = new Set([
  'WHERE',
  'GROUP',
  'ORDER',
  'HAVING',
  'UNION',
  'EXCEPT',
  'INTERSECT',
  'OPTION',
  'SELECT',
  'ON',
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'CROSS',
  'OUTER',
  'PIVOT',
  'UNPIVOT',
  'FOR',
]);

/**
 * Extract table names referenced after FROM/JOIN (including comma-separated
 * FROM lists and tables inside derived-table subqueries). Returned names are
 * normalized (lowercase, quoting stripped) and may be schema-qualified.
 */
export function extractTableNames(tokens: Token[]): string[] {
  const tables = new Set<string>();
  let i = 0;

  const isNamePart = (t: Token | undefined): boolean =>
    t !== undefined && (t.type === 'word' || t.type === 'ident');

  const readName = (start: number): { name: string; next: number } | null => {
    if (!isNamePart(tokens[start])) return null;
    const parts: string[] = [tokens[start].value];
    let j = start + 1;
    while (
      tokens[j]?.type === 'punct' &&
      tokens[j].value === '.' &&
      isNamePart(tokens[j + 1])
    ) {
      parts.push(tokens[j + 1].value);
      j += 2;
    }
    return { name: normalizeTableName(parts.map((p) => `[${p.replace(/\]/g, ']]')}]`).join('.')), next: j };
  };

  while (i < tokens.length) {
    const t = tokens[i];
    const isFrom = t.type === 'word' && t.value.toUpperCase() === 'FROM';
    const isJoin = t.type === 'word' && t.value.toUpperCase() === 'JOIN';
    if (!isFrom && !isJoin) {
      i++;
      continue;
    }

    // Capture the table reference(s) that follow. JOIN takes exactly one;
    // FROM may have a comma-separated list.
    let j = i + 1;
    let expectMore = true;
    while (expectMore) {
      expectMore = false;

      // Derived table / subquery: skip the paren, its inner FROMs are found
      // by the outer scan because we walk every token exactly once via `i`.
      if (tokens[j]?.type === 'punct' && tokens[j].value === '(') break;

      const ref = readName(j);
      if (!ref) break;
      tables.add(ref.name);
      j = ref.next;

      // Table-valued function call: name(...) — keep the name (strict:
      // unknown TVFs then fail the allowlist) and skip its argument list.
      if (tokens[j]?.type === 'punct' && tokens[j].value === '(') {
        j = skipParens(tokens, j);
      }

      // Skip optional alias: [AS] alias
      if (tokens[j]?.type === 'word' && tokens[j].value.toUpperCase() === 'AS') j++;
      if (
        isNamePart(tokens[j]) &&
        !(tokens[j].type === 'word' && FROM_LIST_TERMINATORS.has(tokens[j].value.toUpperCase())) &&
        !(tokens[j].type === 'word' && tokens[j].value.toUpperCase() === 'WITH')
      ) {
        j++;
      }
      // Skip optional table hint: WITH (NOLOCK, ...)
      if (tokens[j]?.type === 'word' && tokens[j].value.toUpperCase() === 'WITH') {
        j++;
        if (tokens[j]?.type === 'punct' && tokens[j].value === '(') j = skipParens(tokens, j);
      }

      // Comma at the same level continues a FROM list (comma joins).
      if (isFrom && tokens[j]?.type === 'punct' && tokens[j].value === ',') {
        j++;
        expectMore = true;
      }
    }
    i++;
  }

  return [...tables];
}

/** Given index of a '(' token, return the index just past its matching ')'. */
function skipParens(tokens: Token[], openIdx: number): number {
  let depth = 0;
  let j = openIdx;
  while (j < tokens.length) {
    if (tokens[j].type === 'punct' && tokens[j].value === '(') depth++;
    else if (tokens[j].type === 'punct' && tokens[j].value === ')') {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return j;
}

/**
 * Collect CTE names declared in a leading WITH clause, so
 * `WITH recent AS (SELECT ...) SELECT * FROM recent` doesn't fail the
 * table allowlist on the CTE's name.
 */
export function collectCteNames(tokens: Token[]): Set<string> {
  const names = new Set<string>();
  const first = tokens[0];
  if (!(first?.type === 'word' && first.value.toUpperCase() === 'WITH')) return names;

  let i = 1;
  while (i < tokens.length) {
    const nameTok = tokens[i];
    if (!nameTok || (nameTok.type !== 'word' && nameTok.type !== 'ident')) break;
    names.add(normalizeTableName(`[${nameTok.value.replace(/\]/g, ']]')}]`));
    i++;

    // Optional column list: (col1, col2)
    if (tokens[i]?.type === 'punct' && tokens[i].value === '(') i = skipParens(tokens, i);

    if (!(tokens[i]?.type === 'word' && tokens[i].value.toUpperCase() === 'AS')) break;
    i++;

    if (!(tokens[i]?.type === 'punct' && tokens[i].value === '(')) break;
    i = skipParens(tokens, i);

    if (tokens[i]?.type === 'punct' && tokens[i].value === ',') {
      i++;
      continue;
    }
    break;
  }

  return names;
}
