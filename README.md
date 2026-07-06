# MSSQL-MCP

[![npm](https://img.shields.io/npm/v/@esasiyun17/mssql-mcp)](https://www.npmjs.com/package/@esasiyun17/mssql-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)

**Microsoft SQL Server için güvenlik öncelikli, salt-okunur MCP (Model Context Protocol) sunucusu.**

**Security-first, read-only MCP (Model Context Protocol) server for Microsoft SQL Server.**

🇹🇷 [Türkçe](#-türkçe) · 🇬🇧 [English](#-english)

---

## 🇹🇷 Türkçe

### Bu proje nedir?

MSSQL-MCP, LLM'leri (Claude gibi) kurumsal Microsoft SQL Server veritabanlarına **güvenle** bağlamak için tasarlanmış bir MCP sunucusudur. LLM doğal dil sorusunu SQL'e çevirir, MSSQL-MCP bu SQL'i katmanlı güvenlik filtrelerinden geçirip yalnızca okuma amaçlıysa çalıştırır.

### Neden? — LLM'i veritabanına doğrudan bağlamanın riskleri

Bir LLM'e veritabanı erişimi vermek güçlüdür ama tehlikelidir:

- LLM yanlışlıkla (veya prompt injection ile kasıtlı olarak) `DELETE`, `UPDATE`, `DROP` gibi yıkıcı sorgular üretebilir.
- "Salt-okunur olduğunu varsaydığınız" kullanıcı, fark etmediğiniz bir `GRANT` yüzünden yazma yetkisine sahip olabilir.
- Sınırsız bir `SELECT` bile milyonlarca satır çekip sunucuyu kilitleyebilir.
- `xp_cmdshell`, `OPENROWSET` gibi kapılar veritabanının çok ötesine geçer.

### Güvenlik felsefesi: salt-okunur doğrulama + savunma derinliği

MSSQL-MCP tek bir güvenlik katmanına güvenmez:

**Katman 1 — Başlangıçta aktif salt-okunurluk doğrulaması.** Sunucu açılırken bağlanan kullanıcının salt-okunur olduğunu *aktif olarak kanıtlamasını* ister. Üç bağımsız kontrolün TÜMÜ geçmelidir:

| Kontrol | Nasıl | Neden |
|---|---|---|
| Sunucu rolleri | `IS_SRVROLEMEMBER`: `sysadmin`, `serveradmin`, `dbcreator`, `securityadmin` | Sunucu yöneticisi hesaplar her şeyi yapabilir |
| Veritabanı rolleri | `IS_ROLEMEMBER`: `db_owner`, `db_datawriter`, `db_ddladmin`, `db_securityadmin` | Yazma/DDL yetkisi veren standart roller |
| Efektif izinler | `sys.fn_my_permissions(NULL, 'DATABASE')` içinde `INSERT`, `UPDATE`, `DELETE`, `ALTER`, `CREATE TABLE`, `EXECUTE`, `CONTROL` aranır | Rol üyeliği olmadan doğrudan `GRANT` ile verilmiş yazma izinlerini yalnızca bu kontrol yakalar |

Doğrulama başarısızsa sunucu **hiçbir sorgu aracı açmaz**; hangi yetkilerin sorun olduğunu listeleyen, yol gösterici bir hata döner (yalnızca `verify_connection` aracı kalır).

**Katman 2 — Sorgu seviyesinde savunma derinliği.** Kullanıcı salt-okunur olsa BİLE her sorgu şu filtrelerden geçer:

1. **Tek statement:** Noktalı virgülle ayrılmış çoklu statement reddedilir. String literal içindeki `;` yanlış pozitif üretmez — düz regex değil, string/yorum/köşeli parantez bilinçli bir tokenizer kullanılır.
2. **Yalnızca SELECT:** Statement `SELECT` veya `WITH ... SELECT` (CTE) ile başlamalıdır.
3. **Kara liste** (kelime sınırı duyarlı, büyük/küçük harf duyarsız): `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `DROP`, `CREATE`, `ALTER`, `TRUNCATE`, `GRANT`, `REVOKE`, `DENY`, `EXEC`, `EXECUTE`, `sp_*`, `xp_*`, `OPENROWSET`, `OPENQUERY`, `OPENDATASOURCE`, `BULK`, `BACKUP`, `RESTORE`, `SHUTDOWN`, `KILL`, `RECONFIGURE`, `WAITFOR`, `INTO` (`SELECT ... INTO` tablo yaratır — reddedilir).
4. **Tablo beyaz listesi (opsiyonel):** `ALLOWED_TABLES` tanımlıysa `FROM`/`JOIN` sonrası geçen her tablo listede olmalıdır (şema önekli adlar desteklenir; CTE adları muaftır).
5. **Zaman aşımı ve satır limiti:** Her sorguya `QUERY_TIMEOUT_MS` uygulanır; sonuçlar sürücü seviyesinde stream edilip `MAX_ROWS`'ta kesilir ve `truncated: true` bildirilir (sorgunuza `TOP` enjekte edilmez).
6. Reddedilen her sorguda **hangi kuralın tetiklendiği** açıkça söylenir.

Ek güvenlik varsayılanları: bağlantı havuzu tek ve paylaşımlıdır, kimlik bilgileri asla loglanmaz ve hata mesajlarından temizlenir, TLS varsayılan olarak açıktır.

### Kurulum

```bash
# npx ile (önerilen) — kurulum gerektirmez, her çalıştırmada güncel sürümü kullanır
npx -y @esasiyun17/mssql-mcp

# veya kalıcı kurulum
npm install -g @esasiyun17/mssql-mcp
```

#### Kaynak koddan kurulum (air-gap / kapalı ağ ortamları)

İnternet erişimi olmayan ortamlarda `npx` çalışmaz. Repoyu klonlayıp (veya
arşiv olarak taşıyıp) yerinde derleyin:

```bash
git clone https://github.com/esasiyun17/MSSQL-MCP.git
cd MSSQL-MCP
npm install
npm run build
```

Ardından MCP yapılandırmasında `npx` yerine doğrudan `node` + tam yol kullanın:

```json
{
  "mcpServers": {
    "mssql": {
      "command": "node",
      "args": ["/tam/yol/MSSQL-MCP/dist/index.js"],
      "env": { "MSSQL_HOST": "...", "MSSQL_USER": "...", "MSSQL_PASSWORD": "...", "MSSQL_DATABASE": "..." }
    }
  }
}
```

> İpucu: `npm install` adımı için bağımlılıkları internet erişimli bir makinede
> indirip `node_modules` ile birlikte taşıyabilir veya `npm pack` çıktısını
> kullanabilirsiniz.

### Salt-okunur kullanıcı oluşturma

Sunucu, yazma yetkisi olan kullanıcılarla **çalışmayı reddeder**. Hazır script ile salt-okunur kullanıcı oluşturun:

```sql
-- scripts/create-readonly-user.sql dosyasını açın,
-- YOUR_LOGIN_NAME / YOUR_STRONG_PASSWORD / YOUR_DATABASE değerlerini değiştirip
-- sysadmin bir hesapla çalıştırın. Özet:
CREATE LOGIN [mcp_reader] WITH PASSWORD = 'YOUR_STRONG_PASSWORD';
USE [YOUR_DATABASE];
CREATE USER [mcp_reader] FOR LOGIN [mcp_reader];
ALTER ROLE [db_datareader] ADD MEMBER [mcp_reader];
```

### Claude Desktop / Claude Code yapılandırması

`claude_desktop_config.json` (Claude Desktop) veya `.mcp.json` (Claude Code):

```json
{
  "mcpServers": {
    "mssql": {
      "command": "npx",
      "args": ["-y", "@esasiyun17/mssql-mcp"],
      "env": {
        "MSSQL_HOST": "192.168.1.10",
        "MSSQL_PORT": "1433",
        "MSSQL_USER": "mcp_reader",
        "MSSQL_PASSWORD": "YOUR_PASSWORD",
        "MSSQL_DATABASE": "ErpDb",
        "MSSQL_ENCRYPT": "true",
        "MSSQL_TRUST_CERT": "false",
        "MAX_ROWS": "1000",
        "ALLOWED_TABLES": "dbo.Customers,dbo.Orders,dbo.OrderLines"
      }
    }
  }
}
```

Claude Code CLI ile:

```bash
claude mcp add mssql -e MSSQL_HOST=192.168.1.10 -e MSSQL_USER=mcp_reader \
  -e MSSQL_PASSWORD=YOUR_PASSWORD -e MSSQL_DATABASE=ErpDb -- npx -y @esasiyun17/mssql-mcp
```

### Ortam değişkenleri

| Değişken | Zorunlu | Varsayılan | Açıklama |
|---|---|---|---|
| `MSSQL_HOST` | ✅ | — | Sunucu IP veya hostname |
| `MSSQL_PORT` | | `1433` | TCP port |
| `MSSQL_USER` | ✅ | — | SQL auth kullanıcı adı (salt-okunur olmalı) |
| `MSSQL_PASSWORD` | ✅ | — | Parola (asla loglanmaz) |
| `MSSQL_DATABASE` | ✅ | — | Veritabanı adı |
| `MSSQL_ENCRYPT` | | `true` | TLS şifreleme |
| `MSSQL_TRUST_CERT` | | `false` | Self-signed sertifika kabulü |
| `QUERY_TIMEOUT_MS` | | `30000` | Sorgu zaman aşımı (ms) |
| `MAX_ROWS` | | `1000` | Satır limiti; aşımda sonuç kesilir ve bildirilir |
| `ALLOWED_TABLES` | | *(boş = tümü)* | Virgülle ayrılmış tablo beyaz listesi, örn. `dbo.Customers,dbo.Orders` |
| `LOG_FILE` | | *(kapalı)* | JSON-satırı denetim logu dosya yolu |

### Araçlar

| Araç | Açıklama |
|---|---|
| `verify_connection` | Bağlantı durumu + salt-okunurluk doğrulama raporu (hangi kontroller geçti/kaldı) |
| `list_tables` | `şema.tablo` listesi + yaklaşık satır sayıları (`sys.partitions` üzerinden, `COUNT(*)` çalıştırılmaz) |
| `describe_table(table)` | Kolonlar, tipler, null'luk, PK/FK, index listesi |
| `sample_rows(table, count)` | İlk N satır (varsayılan 5, en fazla 50) |
| `run_query(sql)` | Tüm filtrelerden geçen tek bir SELECT'i çalıştırır |

Örnek kullanım (Claude'a doğal dille):

> "Veritabanındaki tabloları listele" → `list_tables`
> "Orders tablosunun yapısını göster" → `describe_table("dbo.Orders")`
> "Geçen ayın en çok satan 5 ürünü?" → `run_query("SELECT TOP 5 ...")`

`run_query` çıktısı: `columns`, `rows`, `rowCount`, `truncated`, `durationMs`.

### Denetim logu

`LOG_FILE` tanımlıysa her araç çağrısı bir JSON satırı olarak yazılır: zaman damgası, araç adı, sorgu metni, süre (ms), satır sayısı, hata. **Kimlik bilgileri asla loglanmaz.**

### Yol haritası

- Windows Authentication (v1 yalnızca SQL auth destekler — kapsam bilinçli dar tutuldu)

### Katkı

PR ve issue'lara açığız! Özellikle: yeni guard senaryoları için test, farklı SQL Server sürümleriyle uyumluluk raporları, dokümantasyon iyileştirmeleri. Tek kırmızı çizgi: **yazma yeteneği ekleyen hiçbir katkı kabul edilmez** — salt-okunurluk bu projenin kimliğidir. Güvenlik açıkları için [SECURITY.md](SECURITY.md).

---

## 🇬🇧 English

### What is this?

MSSQL-MCP is an MCP server designed to connect LLMs (like Claude) to enterprise Microsoft SQL Server databases **safely**. The LLM translates natural-language questions into SQL; MSSQL-MCP runs that SQL only after it passes layered security filters that guarantee it is read-only.

### Why? — The risks of wiring an LLM straight into your database

Giving an LLM database access is powerful but dangerous:

- The LLM can produce destructive queries (`DELETE`, `UPDATE`, `DROP`) by accident — or deliberately, via prompt injection.
- The user you *assumed* was read-only may have write access through a forgotten `GRANT`.
- Even an unbounded `SELECT` can pull millions of rows and choke the server.
- Escape hatches like `xp_cmdshell` and `OPENROWSET` reach far beyond the database.

### Security philosophy: read-only verification + defense in depth

MSSQL-MCP never trusts a single layer:

**Layer 1 — Active read-only verification at startup.** When the server starts, the connecting user must *actively prove* it is read-only. ALL three independent checks must pass:

| Check | How | Why |
|---|---|---|
| Server roles | `IS_SRVROLEMEMBER`: `sysadmin`, `serveradmin`, `dbcreator`, `securityadmin` | Server-admin accounts can do anything |
| Database roles | `IS_ROLEMEMBER`: `db_owner`, `db_datawriter`, `db_ddladmin`, `db_securityadmin` | The standard roles that grant write/DDL |
| Effective permissions | `sys.fn_my_permissions(NULL, 'DATABASE')` scanned for `INSERT`, `UPDATE`, `DELETE`, `ALTER`, `CREATE TABLE`, `EXECUTE`, `CONTROL` | Only this catches write permissions GRANTed directly, outside any role |

If verification fails the server exposes **no query tools at all**; it returns an actionable error listing exactly which privileges are the problem (only `verify_connection` remains available).

**Layer 2 — Query-level defense in depth.** EVEN IF the user is read-only, every query passes these filters:

1. **Single statement only:** multiple semicolon-separated statements are rejected. A `;` inside a string literal is not a false positive — a tokenizer aware of strings, comments and bracketed identifiers is used, not a plain regex.
2. **SELECT only:** the statement must start with `SELECT` or `WITH ... SELECT` (CTE).
3. **Keyword blacklist** (word-boundary aware, case-insensitive): `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `DROP`, `CREATE`, `ALTER`, `TRUNCATE`, `GRANT`, `REVOKE`, `DENY`, `EXEC`, `EXECUTE`, `sp_*`, `xp_*`, `OPENROWSET`, `OPENQUERY`, `OPENDATASOURCE`, `BULK`, `BACKUP`, `RESTORE`, `SHUTDOWN`, `KILL`, `RECONFIGURE`, `WAITFOR`, `INTO` (`SELECT ... INTO` creates a table — rejected).
4. **Optional table allowlist:** when `ALLOWED_TABLES` is set, every table appearing after `FROM`/`JOIN` must be on the list (schema-qualified names supported; CTE names are exempt).
5. **Timeout & row cap:** `QUERY_TIMEOUT_MS` applies to every query; results are streamed at the driver level and cut off at `MAX_ROWS` with `truncated: true` reported (no `TOP` is injected into your SQL).
6. Every rejected query states **exactly which rule fired**.

Additional safe defaults: one shared connection pool, credentials are never logged and are scrubbed from error messages, TLS is on by default.

### Installation

```bash
# via npx (recommended) — no install step, always runs the latest version
npx -y @esasiyun17/mssql-mcp

# or install globally
npm install -g @esasiyun17/mssql-mcp
```

#### Installing from source (air-gapped / offline environments)

`npx` won't work without internet access. Clone the repo (or carry it over as
an archive) and build in place:

```bash
git clone https://github.com/esasiyun17/MSSQL-MCP.git
cd MSSQL-MCP
npm install
npm run build
```

Then point your MCP configuration at `node` + the absolute path instead of `npx`:

```json
{
  "mcpServers": {
    "mssql": {
      "command": "node",
      "args": ["/absolute/path/MSSQL-MCP/dist/index.js"],
      "env": { "MSSQL_HOST": "...", "MSSQL_USER": "...", "MSSQL_PASSWORD": "...", "MSSQL_DATABASE": "..." }
    }
  }
}
```

> Tip: for the `npm install` step you can download dependencies on a machine
> with internet access and carry the `node_modules` folder over, or use the
> output of `npm pack`.

### Creating a read-only user

The server **refuses to run** with users that hold write privileges. Use the bundled script to create a read-only user:

```sql
-- Open scripts/create-readonly-user.sql, replace
-- YOUR_LOGIN_NAME / YOUR_STRONG_PASSWORD / YOUR_DATABASE and run as sysadmin. Summary:
CREATE LOGIN [mcp_reader] WITH PASSWORD = 'YOUR_STRONG_PASSWORD';
USE [YOUR_DATABASE];
CREATE USER [mcp_reader] FOR LOGIN [mcp_reader];
ALTER ROLE [db_datareader] ADD MEMBER [mcp_reader];
```

### Claude Desktop / Claude Code configuration

`claude_desktop_config.json` (Claude Desktop) or `.mcp.json` (Claude Code):

```json
{
  "mcpServers": {
    "mssql": {
      "command": "npx",
      "args": ["-y", "@esasiyun17/mssql-mcp"],
      "env": {
        "MSSQL_HOST": "192.168.1.10",
        "MSSQL_PORT": "1433",
        "MSSQL_USER": "mcp_reader",
        "MSSQL_PASSWORD": "YOUR_PASSWORD",
        "MSSQL_DATABASE": "ErpDb",
        "MSSQL_ENCRYPT": "true",
        "MSSQL_TRUST_CERT": "false",
        "MAX_ROWS": "1000",
        "ALLOWED_TABLES": "dbo.Customers,dbo.Orders,dbo.OrderLines"
      }
    }
  }
}
```

With the Claude Code CLI:

```bash
claude mcp add mssql -e MSSQL_HOST=192.168.1.10 -e MSSQL_USER=mcp_reader \
  -e MSSQL_PASSWORD=YOUR_PASSWORD -e MSSQL_DATABASE=ErpDb -- npx -y @esasiyun17/mssql-mcp
```

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MSSQL_HOST` | ✅ | — | Server IP or hostname |
| `MSSQL_PORT` | | `1433` | TCP port |
| `MSSQL_USER` | ✅ | — | SQL auth user name (must be read-only) |
| `MSSQL_PASSWORD` | ✅ | — | Password (never logged) |
| `MSSQL_DATABASE` | ✅ | — | Database name |
| `MSSQL_ENCRYPT` | | `true` | TLS encryption |
| `MSSQL_TRUST_CERT` | | `false` | Accept self-signed certificates |
| `QUERY_TIMEOUT_MS` | | `30000` | Per-query timeout (ms) |
| `MAX_ROWS` | | `1000` | Row cap; results are truncated and flagged |
| `ALLOWED_TABLES` | | *(empty = all)* | Comma-separated table allowlist, e.g. `dbo.Customers,dbo.Orders` |
| `LOG_FILE` | | *(off)* | Path for the JSON-lines audit log |

### Tools

| Tool | Description |
|---|---|
| `verify_connection` | Connection status + read-only verification report (which checks passed/failed) |
| `list_tables` | `schema.table` list + approximate row counts (via `sys.partitions`, no `COUNT(*)`) |
| `describe_table(table)` | Columns, types, nullability, PK/FK, index list |
| `sample_rows(table, count)` | First N rows (default 5, max 50) |
| `run_query(sql)` | Runs a single SELECT after all defense filters |

Example usage (natural language, via Claude):

> "List the tables in the database" → `list_tables`
> "Show me the structure of Orders" → `describe_table("dbo.Orders")`
> "Top 5 products by revenue last month?" → `run_query("SELECT TOP 5 ...")`

`run_query` output: `columns`, `rows`, `rowCount`, `truncated`, `durationMs`.

### Audit log

When `LOG_FILE` is set, every tool call is appended as one JSON line: timestamp, tool name, query text, duration (ms), row count, error. **Credentials are never logged.**

### Roadmap

- Windows Authentication (v1 supports SQL auth only — scope kept deliberately narrow)

### Contributing

PRs and issues welcome! Especially: tests for new guard scenarios, compatibility reports for different SQL Server versions, documentation improvements. One hard line: **no contribution that adds write capability will be accepted** — read-only is this project's identity. For vulnerabilities see [SECURITY.md](SECURITY.md).

## License / Lisans

[MIT](LICENSE) © esasiyun17
