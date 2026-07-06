/**
 * Error types and credential-safe error sanitization.
 *
 * Every error surfaced to the MCP client or written to a log passes through
 * sanitizeErrorMessage() so a password can never leak via driver messages or
 * stack traces.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class ConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectionError';
  }
}

/** Thrown when the startup read-only verification rejects the user. */
export class ReadOnlyVerificationError extends Error {
  readonly violations: string[];

  constructor(message: string, violations: string[]) {
    super(message);
    this.name = 'ReadOnlyVerificationError';
    this.violations = violations;
  }
}

/** Thrown by the query guard when a query violates a defense rule. */
export class QueryRejectedError extends Error {
  /** Machine-readable identifier of the rule that fired, e.g. "multiple-statements". */
  readonly rule: string;

  constructor(rule: string, message: string) {
    super(message);
    this.name = 'QueryRejectedError';
    this.rule = rule;
  }
}

export class QueryExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryExecutionError';
  }
}

let secretsToRedact: string[] = [];

/** Register secret values (currently the DB password) that must never appear in output. */
export function registerSecrets(secrets: string[]): void {
  secretsToRedact = secrets.filter((s) => s.length > 0);
}

/** Replace any registered secret occurring in a string with ***. */
export function sanitizeErrorMessage(message: string): string {
  let out = message;
  for (const secret of secretsToRedact) {
    out = out.split(secret).join('***');
  }
  return out;
}

/** Produce a safe, human-readable message from an unknown thrown value. */
export function toSafeMessage(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return sanitizeErrorMessage(raw);
}
