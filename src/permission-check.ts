/**
 * Startup read-only verification.
 *
 * Before any query tool is exposed, the connected user must ACTIVELY prove it
 * is read-only. Three independent checks — all of them must pass:
 *
 *   1. Server roles   — IS_SRVROLEMEMBER for sysadmin, serveradmin, dbcreator,
 *                       securityadmin.
 *   2. Database roles — IS_ROLEMEMBER for db_owner, db_datawriter,
 *                       db_ddladmin, db_securityadmin.
 *   3. Effective permissions — sys.fn_my_permissions(NULL, 'DATABASE') must
 *                       not contain INSERT, UPDATE, DELETE, ALTER,
 *                       CREATE TABLE, EXECUTE or CONTROL. This catches write
 *                       permissions GRANTed directly (outside any role) that
 *                       the role checks alone would miss.
 *
 * evaluateReadOnly() is a pure function over a permission snapshot so it can
 * be unit-tested without a live database; fetchPermissionSnapshot() is the
 * thin data-access layer.
 */

import type sql from 'mssql';

export const FORBIDDEN_SERVER_ROLES = ['sysadmin', 'serveradmin', 'dbcreator', 'securityadmin'] as const;

export const FORBIDDEN_DATABASE_ROLES = ['db_owner', 'db_datawriter', 'db_ddladmin', 'db_securityadmin'] as const;

export const FORBIDDEN_PERMISSIONS = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'ALTER',
  'CREATE TABLE',
  'EXECUTE',
  'CONTROL',
] as const;

export interface PermissionSnapshot {
  /** IS_SRVROLEMEMBER results per role: 1 = member, 0 = not, null = unknown login. */
  serverRoles: Record<string, number | boolean | null>;
  /** IS_ROLEMEMBER results per role: 1 = member, 0/null = not a member. */
  databaseRoles: Record<string, number | boolean | null>;
  /** permission_name values from sys.fn_my_permissions(NULL, 'DATABASE'). */
  databasePermissions: string[];
}

export interface CheckDetail {
  check: 'server-roles' | 'database-roles' | 'effective-permissions';
  passed: boolean;
  violations: string[];
}

export interface VerificationResult {
  readOnly: boolean;
  /** Flat list of every offending role/permission, e.g. ["db_datawriter", "INSERT"]. */
  violations: string[];
  checks: CheckDetail[];
}

function isMember(value: number | boolean | null | undefined): boolean {
  return value === 1 || value === true;
}

/** Pure evaluation of a permission snapshot against the read-only policy. */
export function evaluateReadOnly(snapshot: PermissionSnapshot): VerificationResult {
  const serverViolations = FORBIDDEN_SERVER_ROLES.filter((role) => isMember(snapshot.serverRoles[role]));
  const dbViolations = FORBIDDEN_DATABASE_ROLES.filter((role) => isMember(snapshot.databaseRoles[role]));

  const grantedUpper = new Set(snapshot.databasePermissions.map((p) => p.trim().toUpperCase()));
  const permViolations = FORBIDDEN_PERMISSIONS.filter((p) => grantedUpper.has(p));

  const checks: CheckDetail[] = [
    { check: 'server-roles', passed: serverViolations.length === 0, violations: serverViolations },
    { check: 'database-roles', passed: dbViolations.length === 0, violations: dbViolations },
    { check: 'effective-permissions', passed: permViolations.length === 0, violations: [...permViolations] },
  ];

  const violations = [...serverViolations, ...dbViolations, ...permViolations];
  return { readOnly: violations.length === 0, violations, checks };
}

/** Query the live server for the three permission snapshots. */
export async function fetchPermissionSnapshot(pool: sql.ConnectionPool): Promise<PermissionSnapshot> {
  const serverRolesSql =
    'SELECT ' +
    FORBIDDEN_SERVER_ROLES.map((r) => `IS_SRVROLEMEMBER('${r}') AS [${r}]`).join(', ');
  const dbRolesSql =
    'SELECT ' + FORBIDDEN_DATABASE_ROLES.map((r) => `IS_ROLEMEMBER('${r}') AS [${r}]`).join(', ');
  const permsSql = "SELECT permission_name FROM sys.fn_my_permissions(NULL, 'DATABASE')";

  const [serverRes, dbRes, permsRes] = await Promise.all([
    pool.request().query(serverRolesSql),
    pool.request().query(dbRolesSql),
    pool.request().query(permsSql),
  ]);

  return {
    serverRoles: serverRes.recordset[0] ?? {},
    databaseRoles: dbRes.recordset[0] ?? {},
    databasePermissions: permsRes.recordset.map((row: { permission_name: string }) => row.permission_name),
  };
}

/** Bilingual (TR + EN), actionable rejection message listing every violation. */
export function buildRejectionMessage(violations: string[]): string {
  const list = violations.join(', ');
  return (
    `Bu kullanıcının yazma yetkileri var (tespit edilen: ${list}). ` +
    'Güvenlik nedeniyle MSSQL-MCP yalnızca salt-okunur kullanıcılarla çalışır. ' +
    'Lütfen salt-okunur bir kullanıcı oluşturup onu kullanın. ' +
    'Hazır script: scripts/create-readonly-user.sql\n\n' +
    `This user has write privileges (detected: ${list}). ` +
    'For safety, MSSQL-MCP only works with read-only users. ' +
    'Please create a read-only user and use that instead. ' +
    'Ready-made script: scripts/create-readonly-user.sql'
  );
}
