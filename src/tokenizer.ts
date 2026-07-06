/**
 * Minimal T-SQL tokenizer for the query guard.
 *
 * This is NOT a full SQL parser. Its only job is to split a query into tokens
 * while correctly skipping the constructs that defeat plain regex filtering:
 *   - string literals:        'it''s; fine'
 *   - bracketed identifiers:  [Weird;Name]
 *   - quoted identifiers:     "Weird;Name"
 *   - line comments:          -- comment
 *   - block comments (including nesting, per T-SQL)
 *
 * Keyword checks and statement splitting then operate on tokens, so a
 * semicolon or the word DELETE inside a string literal is never a false
 * positive — and a real semicolon can never hide from the guard.
 */

export type TokenType =
  | 'word' // unquoted identifier or keyword: SELECT, dbo, sp_help
  | 'ident' // [bracketed] or "quoted" identifier (value without the quotes)
  | 'string' // 'literal' (value without the quotes)
  | 'number'
  | 'punct'; // single punctuation char: ; ( ) , . = etc.

export interface Token {
  type: TokenType;
  value: string;
  /** Offset of the token's first character in the original SQL text. */
  position: number;
}

export class TokenizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenizeError';
  }
}

const WORD_START = /[A-Za-z_@#À-￿]/;
const WORD_CHAR = /[A-Za-z0-9_@#$À-￿]/;

export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i];

    // Whitespace
    if (/\s/.test(c)) {
      i++;
      continue;
    }

    // Line comment
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }

    // Block comment (T-SQL block comments nest)
    if (c === '/' && sql[i + 1] === '*') {
      const start = i;
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      if (depth > 0) throw new TokenizeError(`Unterminated block comment at position ${start}`);
      continue;
    }

    // String literal (with '' escape); N'...' handled via the word path + this.
    if (c === "'") {
      const start = i;
      i++;
      let value = '';
      let closed = false;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            value += "'";
            i += 2;
          } else {
            i++;
            closed = true;
            break;
          }
        } else {
          value += sql[i];
          i++;
        }
      }
      if (!closed) throw new TokenizeError(`Unterminated string literal at position ${start}`);
      tokens.push({ type: 'string', value, position: start });
      continue;
    }

    // Bracketed identifier (]] escape)
    if (c === '[') {
      const start = i;
      i++;
      let value = '';
      let closed = false;
      while (i < n) {
        if (sql[i] === ']') {
          if (sql[i + 1] === ']') {
            value += ']';
            i += 2;
          } else {
            i++;
            closed = true;
            break;
          }
        } else {
          value += sql[i];
          i++;
        }
      }
      if (!closed) throw new TokenizeError(`Unterminated bracketed identifier at position ${start}`);
      tokens.push({ type: 'ident', value, position: start });
      continue;
    }

    // Quoted identifier ("" escape)
    if (c === '"') {
      const start = i;
      i++;
      let value = '';
      let closed = false;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            value += '"';
            i += 2;
          } else {
            i++;
            closed = true;
            break;
          }
        } else {
          value += sql[i];
          i++;
        }
      }
      if (!closed) throw new TokenizeError(`Unterminated quoted identifier at position ${start}`);
      tokens.push({ type: 'ident', value, position: start });
      continue;
    }

    // Number (enough fidelity for guarding: digits, dot, exponent, hex)
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] ?? ''))) {
      const start = i;
      if (c === '0' && (sql[i + 1] === 'x' || sql[i + 1] === 'X')) {
        i += 2;
        while (i < n && /[0-9A-Fa-f]/.test(sql[i])) i++;
      } else {
        while (i < n && /[0-9.eE+-]/.test(sql[i])) {
          // stop +/- unless directly after e/E (exponent sign)
          if ((sql[i] === '+' || sql[i] === '-') && !/[eE]/.test(sql[i - 1])) break;
          i++;
        }
      }
      tokens.push({ type: 'number', value: sql.slice(start, i), position: start });
      continue;
    }

    // Word (keyword / identifier / @variable / #temp)
    if (WORD_START.test(c)) {
      const start = i;
      i++;
      while (i < n && WORD_CHAR.test(sql[i])) i++;
      tokens.push({ type: 'word', value: sql.slice(start, i), position: start });
      continue;
    }

    // Anything else: single punctuation character
    tokens.push({ type: 'punct', value: c, position: i });
    i++;
  }

  return tokens;
}
