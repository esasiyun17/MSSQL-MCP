import { describe, it, expect } from 'vitest';
import {
  evaluateReadOnly,
  buildRejectionMessage,
  type PermissionSnapshot,
} from './permission-check.js';

function snapshot(overrides: Partial<PermissionSnapshot> = {}): PermissionSnapshot {
  return {
    serverRoles: { sysadmin: 0, serveradmin: 0, dbcreator: 0, securityadmin: 0 },
    databaseRoles: { db_owner: 0, db_datawriter: 0, db_ddladmin: 0, db_securityadmin: 0 },
    databasePermissions: ['CONNECT', 'SELECT', 'VIEW DEFINITION'],
    ...overrides,
  };
}

describe('evaluateReadOnly', () => {
  it('passes a clean db_datareader-style user', () => {
    const result = evaluateReadOnly(snapshot());
    expect(result.readOnly).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it('rejects a sysadmin', () => {
    const result = evaluateReadOnly(snapshot({ serverRoles: { sysadmin: 1 } }));
    expect(result.readOnly).toBe(false);
    expect(result.violations).toContain('sysadmin');
    expect(result.checks.find((c) => c.check === 'server-roles')?.passed).toBe(false);
  });

  it.each(['serveradmin', 'dbcreator', 'securityadmin'])('rejects forbidden server role: %s', (role) => {
    const result = evaluateReadOnly(snapshot({ serverRoles: { [role]: 1 } }));
    expect(result.readOnly).toBe(false);
    expect(result.violations).toContain(role);
  });

  it.each(['db_owner', 'db_datawriter', 'db_ddladmin', 'db_securityadmin'])(
    'rejects forbidden database role: %s',
    (role) => {
      const result = evaluateReadOnly(snapshot({ databaseRoles: { [role]: 1 } }));
      expect(result.readOnly).toBe(false);
      expect(result.violations).toContain(role);
      expect(result.checks.find((c) => c.check === 'database-roles')?.passed).toBe(false);
    }
  );

  it('rejects direct-GRANT write permissions even when NO forbidden role is present', () => {
    // The key scenario: INSERT granted directly to the user, role checks alone would miss it.
    const result = evaluateReadOnly(
      snapshot({ databasePermissions: ['CONNECT', 'SELECT', 'INSERT'] })
    );
    expect(result.readOnly).toBe(false);
    expect(result.violations).toEqual(['INSERT']);
    expect(result.checks.find((c) => c.check === 'effective-permissions')?.passed).toBe(false);
  });

  it.each(['UPDATE', 'DELETE', 'ALTER', 'CREATE TABLE', 'EXECUTE', 'CONTROL'])(
    'rejects forbidden effective permission: %s',
    (perm) => {
      const result = evaluateReadOnly(snapshot({ databasePermissions: ['CONNECT', 'SELECT', perm] }));
      expect(result.readOnly).toBe(false);
      expect(result.violations).toContain(perm);
    }
  );

  it('matches permissions case-insensitively', () => {
    const result = evaluateReadOnly(snapshot({ databasePermissions: ['connect', 'select', 'insert'] }));
    expect(result.readOnly).toBe(false);
    expect(result.violations).toContain('INSERT');
  });

  it('does not reject harmless permissions like SELECT / CONNECT / VIEW DEFINITION', () => {
    const result = evaluateReadOnly(
      snapshot({ databasePermissions: ['CONNECT', 'SELECT', 'VIEW DEFINITION', 'VIEW DATABASE STATE'] })
    );
    expect(result.readOnly).toBe(true);
  });

  it('treats NULL role results (unknown login/role) as not-a-member', () => {
    const result = evaluateReadOnly(
      snapshot({
        serverRoles: { sysadmin: null, serveradmin: null, dbcreator: null, securityadmin: null },
        databaseRoles: { db_owner: null, db_datawriter: null, db_ddladmin: null, db_securityadmin: null },
      })
    );
    expect(result.readOnly).toBe(true);
  });

  it('accumulates violations from multiple checks', () => {
    const result = evaluateReadOnly(
      snapshot({
        databaseRoles: { db_datawriter: 1 },
        databasePermissions: ['CONNECT', 'SELECT', 'INSERT', 'UPDATE', 'DELETE'],
      })
    );
    expect(result.readOnly).toBe(false);
    expect(result.violations).toEqual(expect.arrayContaining(['db_datawriter', 'INSERT', 'UPDATE', 'DELETE']));
  });
});

describe('buildRejectionMessage', () => {
  it('is bilingual, names the violations and points to the helper script', () => {
    const msg = buildRejectionMessage(['db_datawriter', 'INSERT']);
    expect(msg).toContain('db_datawriter');
    expect(msg).toContain('INSERT');
    // Turkish part
    expect(msg).toContain('yazma yetkileri');
    expect(msg).toContain('salt-okunur');
    // English part
    expect(msg).toContain('write privileges');
    expect(msg).toContain('read-only');
    // Actionable pointer
    expect(msg).toContain('scripts/create-readonly-user.sql');
  });
});
