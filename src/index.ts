#!/usr/bin/env node
/**
 * MSSQL-MCP — security-first, read-only MCP server for Microsoft SQL Server.
 *
 * Startup sequence:
 *   1. Load and validate configuration from environment variables.
 *   2. Connect the pool and ACTIVELY verify the user is read-only
 *      (server roles + database roles + effective permissions).
 *   3. If verification FAILS → expose only `verify_connection` and print a
 *      bilingual (TR/EN), actionable error to stderr. No query tools.
 *      If verification cannot run yet (e.g. DB temporarily unreachable) →
 *      register all tools, but each one re-verifies before doing anything.
 *   4. Serve over stdio (Claude Desktop / Claude Code compatible).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createPool } from './connection.js';
import { AuditLogger } from './logger.js';
import { ServerState } from './state.js';
import { registerVerifyConnectionTool, registerQueryTools } from './tools/index.js';
import { registerSecrets, toSafeMessage } from './errors.js';

const SERVER_NAME = 'mssql-mcp';
const SERVER_VERSION = '1.0.0';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`[mssql-mcp] Configuration error / Yapılandırma hatası: ${toSafeMessage(err)}`);
    process.exit(1);
  }

  // Make sure the password can never appear in errors, logs or stack traces.
  registerSecrets([config.password]);

  const pool = createPool(config);
  pool.on('error', (err) => {
    console.error(`[mssql-mcp] pool error: ${toSafeMessage(err)}`);
  });

  const logger = new AuditLogger(config.logFile);
  const state = new ServerState(config, pool, logger);

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerVerifyConnectionTool(server, state);

  // Active read-only verification BEFORE exposing any query capability.
  const outcome = await state.verify();
  if (outcome.status === 'passed') {
    console.error(
      '[mssql-mcp] Read-only verification passed — all checks OK. / Salt-okunurluk doğrulaması başarılı.'
    );
    registerQueryTools(server, state);
  } else if (outcome.status === 'failed') {
    // Write privileges detected: expose NO query tools at all.
    console.error(`[mssql-mcp] READ-ONLY VERIFICATION FAILED / SALT-OKUNURLUK DOĞRULAMASI BAŞARISIZ`);
    console.error(
      buildStartupFailureBanner(outcome.result.violations)
    );
  } else {
    console.error(
      `[mssql-mcp] Could not verify yet (connection problem): ${outcome.message}\n` +
        '[mssql-mcp] Tools are registered but every call re-attempts verification before running. / ' +
        'Bağlantı kurulamadığı için doğrulama ertelendi; her araç çağrısı önce doğrulamayı yeniden dener.'
    );
    registerQueryTools(server, state);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[mssql-mcp] ${SERVER_NAME} v${SERVER_VERSION} serving on stdio (db: ${config.database}@${config.host})`);
}

function buildStartupFailureBanner(violations: string[]): string {
  const list = violations.join(', ');
  return [
    `[mssql-mcp] Bu kullanıcının yazma yetkileri var (tespit edilen: ${list}).`,
    '[mssql-mcp] Güvenlik nedeniyle MSSQL-MCP yalnızca salt-okunur kullanıcılarla çalışır.',
    '[mssql-mcp] Lütfen salt-okunur bir kullanıcı oluşturup onu kullanın. Hazır script: scripts/create-readonly-user.sql',
    `[mssql-mcp] This user has write privileges (detected: ${list}).`,
    '[mssql-mcp] For safety, MSSQL-MCP only works with read-only users.',
    '[mssql-mcp] Please create a read-only user. Ready-made script: scripts/create-readonly-user.sql',
    '[mssql-mcp] Only the verify_connection tool is available in this state. / Bu durumda yalnızca verify_connection aracı kullanılabilir.',
  ].join('\n');
}

main().catch((err) => {
  console.error(`[mssql-mcp] fatal: ${toSafeMessage(err)}`);
  process.exit(1);
});
