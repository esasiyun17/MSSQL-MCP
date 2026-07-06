import { describe, it, expect } from 'vitest';
import { guardQuery, extractTableNames, collectCteNames } from './query-guard.js';
import { QueryRejectedError } from './errors.js';
import { tokenize } from './tokenizer.js';

function rejectionRule(sql: string, allowedTables: string[] = []): string {
  try {
    guardQuery(sql, { allowedTables });
  } catch (err) {
    if (err instanceof QueryRejectedError) return err.rule;
    throw err;
  }
  throw new Error(`Expected query to be rejected but it passed: ${sql}`);
}

describe('guardQuery — statement shape', () => {
  it('accepts a simple SELECT', () => {
    expect(() => guardQuery('SELECT TOP 10 * FROM dbo.Customers WHERE City = N\'İstanbul\'')).not.toThrow();
  });

  it('accepts a CTE (WITH ... SELECT)', () => {
    const sql = `WITH monthly AS (
      SELECT YEAR(OrderDate) y, MONTH(OrderDate) m, SUM(Total) total
      FROM dbo.Orders GROUP BY YEAR(OrderDate), MONTH(OrderDate)
    )
    SELECT * FROM monthly ORDER BY y, m`;
    expect(() => guardQuery(sql)).not.toThrow();
  });

  it('allows a single trailing semicolon', () => {
    expect(() => guardQuery('SELECT 1 AS one;')).not.toThrow();
  });

  it('rejects multiple statements separated by semicolons', () => {
    expect(rejectionRule('SELECT 1; SELECT 2')).toBe('multiple-statements');
  });

  it('rejects a write statement smuggled after a semicolon', () => {
    expect(rejectionRule("SELECT * FROM t; DELETE FROM t")).toBe('multiple-statements');
  });

  it('does NOT treat a semicolon inside a string literal as a statement separator', () => {
    expect(() => guardQuery("SELECT * FROM dbo.Notes WHERE Body = 'a;b;c'")).not.toThrow();
  });

  it('rejects statements that do not start with SELECT or WITH', () => {
    expect(rejectionRule('BEGIN TRAN')).toBe('not-a-select');
    expect(rejectionRule('DECLARE @x INT')).toBe('not-a-select');
  });

  it('rejects an empty query', () => {
    expect(rejectionRule('   ')).toBe('empty-query');
  });

  it('rejects unterminated strings/comments as unparsable', () => {
    expect(rejectionRule("SELECT 'unterminated")).toBe('unparsable');
    expect(rejectionRule('SELECT 1 /* never closed')).toBe('unparsable');
  });
});

describe('guardQuery — keyword blacklist', () => {
  it.each(['INSERT INTO t VALUES (1)', 'UPDATE t SET a = 1', 'DELETE FROM t', 'MERGE t USING s ON 1=1', 'DROP TABLE t', 'TRUNCATE TABLE t'])(
    'rejects write statement: %s',
    (sql) => {
      const rule = rejectionRule(sql);
      expect(['not-a-select', 'blacklisted-keyword']).toContain(rule);
    }
  );

  it('rejects blacklisted keywords even inside a SELECT', () => {
    expect(rejectionRule('SELECT * FROM t WHERE EXISTS (SELECT 1 FROM u) UNION ALL SELECT 1 WAITFOR DELAY \'0:0:5\'')).toBe(
      'blacklisted-keyword'
    );
  });

  it('rejects EXEC and EXECUTE', () => {
    expect(rejectionRule('SELECT 1 EXEC xp_cmdshell')).toBe('blacklisted-keyword');
    expect(rejectionRule("SELECT * FROM t WHERE EXECUTE ('x') = 1")).toBe('blacklisted-keyword');
  });

  it('rejects SELECT ... INTO (creates a table)', () => {
    expect(rejectionRule('SELECT * INTO #backup FROM dbo.Customers')).toBe('blacklisted-keyword');
  });

  it('rejects sp_ / xp_ prefixed identifiers', () => {
    expect(rejectionRule('SELECT * FROM t WHERE c = sp_helptext')).toBe('blacklisted-procedure-prefix');
    expect(rejectionRule('SELECT xp_cmdshell FROM t')).toBe('blacklisted-procedure-prefix');
  });

  it('rejects OPENROWSET / OPENQUERY / OPENDATASOURCE', () => {
    expect(rejectionRule("SELECT * FROM OPENROWSET('SQLNCLI', 'x', 'SELECT 1')")).toBe('blacklisted-keyword');
    expect(rejectionRule("SELECT * FROM OPENQUERY(lnk, 'SELECT 1')")).toBe('blacklisted-keyword');
  });

  it('is case-insensitive', () => {
    expect(rejectionRule('select 1 shutdown')).toBe('blacklisted-keyword');
    expect(rejectionRule('SeLeCt 1 kIlL 5')).toBe('blacklisted-keyword');
  });

  it('does NOT flag blacklisted words inside string literals', () => {
    expect(() => guardQuery("SELECT 'DELETE FROM users; DROP TABLE x' AS advice FROM dbo.Tips")).not.toThrow();
  });

  it('does NOT flag blacklisted words inside comments', () => {
    expect(() => guardQuery('SELECT 1 -- TODO: DELETE this later\nFROM dbo.T')).not.toThrow();
    expect(() => guardQuery('SELECT 1 /* UPDATE: reviewed */ FROM dbo.T')).not.toThrow();
  });

  it('does NOT flag bracketed identifiers that look like keywords', () => {
    expect(() => guardQuery('SELECT [Delete], [Update] FROM dbo.AuditLog')).not.toThrow();
  });
});

describe('guardQuery — table allowlist', () => {
  const allowed = ['dbo.customers', 'dbo.orders', 'sales.invoices'];

  it('accepts queries touching only allowed tables', () => {
    expect(() =>
      guardQuery('SELECT c.Name, o.Total FROM dbo.Customers c JOIN dbo.Orders o ON o.CustomerId = c.Id', {
        allowedTables: allowed,
      })
    ).not.toThrow();
  });

  it('treats schema-less names as dbo', () => {
    expect(() => guardQuery('SELECT * FROM Customers', { allowedTables: allowed })).not.toThrow();
  });

  it('rejects a table that is not on the list', () => {
    expect(rejectionRule('SELECT * FROM dbo.Salaries', allowed)).toBe('table-not-allowed');
  });

  it('rejects a disallowed table hidden in a JOIN', () => {
    expect(rejectionRule('SELECT * FROM dbo.Customers c JOIN dbo.Salaries s ON s.Id = c.Id', allowed)).toBe(
      'table-not-allowed'
    );
  });

  it('rejects a disallowed table in a comma-separated FROM list', () => {
    expect(rejectionRule('SELECT * FROM dbo.Customers, dbo.Salaries', allowed)).toBe('table-not-allowed');
  });

  it('rejects a disallowed table inside a derived-table subquery', () => {
    expect(rejectionRule('SELECT * FROM (SELECT * FROM dbo.Salaries) x', allowed)).toBe('table-not-allowed');
  });

  it('supports bracketed schema-qualified names', () => {
    expect(() => guardQuery('SELECT * FROM [dbo].[Customers]', { allowedTables: allowed })).not.toThrow();
    expect(rejectionRule('SELECT * FROM [dbo].[Salaries]', allowed)).toBe('table-not-allowed');
  });

  it('does not treat CTE names as tables', () => {
    const sql = 'WITH recent AS (SELECT * FROM dbo.Orders) SELECT * FROM recent';
    expect(() => guardQuery(sql, { allowedTables: allowed })).not.toThrow();
  });

  it('rejects three-part (cross-database) names when the allowlist is active', () => {
    expect(rejectionRule('SELECT * FROM OtherDb.dbo.Customers', allowed)).toBe('cross-database-reference');
  });

  it('applies no table restriction when the allowlist is empty', () => {
    expect(() => guardQuery('SELECT * FROM dbo.Anything')).not.toThrow();
  });
});

describe('extractTableNames / collectCteNames', () => {
  it('extracts normalized, schema-qualified names from FROM and JOINs', () => {
    const tokens = tokenize(
      'SELECT * FROM [dbo].[Customers] c LEFT JOIN Sales.Invoices i ON i.CustomerId = c.Id JOIN Orders o ON o.Id = i.OrderId'
    );
    expect(extractTableNames(tokens).sort()).toEqual(['dbo.customers', 'orders', 'sales.invoices']);
  });

  it('extracts tables with WITH (NOLOCK) hints and aliases', () => {
    const tokens = tokenize('SELECT * FROM dbo.Orders AS o WITH (NOLOCK), dbo.Customers c');
    expect(extractTableNames(tokens).sort()).toEqual(['dbo.customers', 'dbo.orders']);
  });

  it('collects CTE names including multiple CTEs', () => {
    const tokens = tokenize(
      'WITH a AS (SELECT 1 x), b (col) AS (SELECT 2) SELECT * FROM a JOIN b ON 1 = 1'
    );
    expect([...collectCteNames(tokens)].sort()).toEqual(['a', 'b']);
  });
});
