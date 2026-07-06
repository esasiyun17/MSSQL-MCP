/**
 * Configuration loading and validation.
 *
 * All settings come from environment variables (or MCP config `env` blocks).
 * Credentials are kept in this module's return value only; they are never
 * logged and never included in error messages (see errors.ts / logger.ts).
 */

import { ConfigError } from './errors.js';

export interface ServerConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
  queryTimeoutMs: number;
  maxRows: number;
  /** Normalized allowlist entries (lowercase, brackets stripped). Empty = all tables allowed. */
  allowedTables: string[];
  logFile: string | null;
}

const DEFAULT_PORT = 1433;
const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ROWS = 1000;

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '') return defaultValue;
  const v = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new ConfigError(`Invalid boolean value: "${value}" (expected true/false)`);
}

function parsePositiveInt(value: string | undefined, defaultValue: number, name: string): number {
  if (value === undefined || value.trim() === '') return defaultValue;
  const n = Number(value.trim());
  if (!Number.isInteger(n) || n <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got "${value}"`);
  }
  return n;
}

/** Strip [brackets] / "quotes" from an identifier part and lowercase it. */
export function normalizeIdentifierPart(part: string): string {
  let p = part.trim();
  if (p.startsWith('[') && p.endsWith(']')) p = p.slice(1, -1).replace(/\]\]/g, ']');
  else if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1).replace(/""/g, '"');
  return p.toLowerCase();
}

/** Normalize a possibly schema-qualified table name: "dbo.[My Table]" -> "dbo.my table". */
export function normalizeTableName(name: string): string {
  return name
    .split('.')
    .map(normalizeIdentifierPart)
    .filter((p) => p.length > 0)
    .join('.');
}

export function parseAllowedTables(raw: string | undefined): string[] {
  if (!raw || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((t) => normalizeTableName(t))
    .filter((t) => t.length > 0);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const missing: string[] = [];
  for (const key of ['MSSQL_HOST', 'MSSQL_USER', 'MSSQL_PASSWORD', 'MSSQL_DATABASE']) {
    if (!env[key] || env[key]!.trim() === '') missing.push(key);
  }
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'See .env.example for the full list.'
    );
  }

  return {
    host: env.MSSQL_HOST!.trim(),
    port: parsePositiveInt(env.MSSQL_PORT, DEFAULT_PORT, 'MSSQL_PORT'),
    user: env.MSSQL_USER!.trim(),
    password: env.MSSQL_PASSWORD!,
    database: env.MSSQL_DATABASE!.trim(),
    encrypt: parseBool(env.MSSQL_ENCRYPT, true),
    trustServerCertificate: parseBool(env.MSSQL_TRUST_CERT, false),
    queryTimeoutMs: parsePositiveInt(env.QUERY_TIMEOUT_MS, DEFAULT_QUERY_TIMEOUT_MS, 'QUERY_TIMEOUT_MS'),
    maxRows: parsePositiveInt(env.MAX_ROWS, DEFAULT_MAX_ROWS, 'MAX_ROWS'),
    allowedTables: parseAllowedTables(env.ALLOWED_TABLES),
    logFile: env.LOG_FILE && env.LOG_FILE.trim() !== '' ? env.LOG_FILE.trim() : null,
  };
}
