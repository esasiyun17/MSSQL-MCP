/*
  =============================================================================
  MSSQL-MCP için salt-okunur kullanıcı oluşturma scripti
  Read-only user creation script for MSSQL-MCP
  =============================================================================

  TR: Bu script bir LOGIN + USER oluşturur ve kullanıcıya YALNIZCA
      db_datareader rolü verir (okuma izni). Yazma, DDL, EXECUTE gibi hiçbir
      yetki verilmez. MSSQL-MCP başlarken bu kullanıcının gerçekten
      salt-okunur olduğunu ayrıca doğrular.

      Kullanım:
        1. Aşağıdaki yer tutucuları değiştirin:
           - YOUR_LOGIN_NAME  -> oluşturulacak giriş adı (örn. mcp_reader)
           - YOUR_STRONG_PASSWORD -> güçlü bir parola
           - YOUR_DATABASE    -> erişilecek veritabanı adı
        2. Scripti sysadmin (veya yeterli yetkili) bir hesapla çalıştırın.

  EN: This script creates a LOGIN + USER and grants ONLY the db_datareader
      role (read access). No write, DDL or EXECUTE permission is granted.
      MSSQL-MCP additionally verifies at startup that the user really is
      read-only.

      Usage:
        1. Replace the placeholders below:
           - YOUR_LOGIN_NAME  -> the login to create (e.g. mcp_reader)
           - YOUR_STRONG_PASSWORD -> a strong password
           - YOUR_DATABASE    -> the database to access
        2. Run the script as sysadmin (or an account with enough privileges).
  =============================================================================
*/

-- 1) Sunucu seviyesinde LOGIN oluştur / Create the server-level LOGIN
USE [master];
GO

CREATE LOGIN [YOUR_LOGIN_NAME]
    WITH PASSWORD = 'YOUR_STRONG_PASSWORD',
    CHECK_POLICY = ON,          -- parola politikası uygulansın / enforce password policy
    DEFAULT_DATABASE = [YOUR_DATABASE];
GO

-- 2) Hedef veritabanında USER oluştur / Create the USER in the target database
USE [YOUR_DATABASE];
GO

CREATE USER [YOUR_LOGIN_NAME] FOR LOGIN [YOUR_LOGIN_NAME];
GO

-- 3) YALNIZCA okuma rolü ver / Grant ONLY the read role
--    db_datareader: tüm tablolarda SELECT / SELECT on all tables
ALTER ROLE [db_datareader] ADD MEMBER [YOUR_LOGIN_NAME];
GO

/*
  TR: İSTEĞE BAĞLI — erişimi belirli tablolarla sınırlamak isterseniz
      db_datareader yerine tablo bazında SELECT verin (ve MSSQL-MCP tarafında
      ALLOWED_TABLES ortam değişkenini de ayarlayın):

  EN: OPTIONAL — to restrict access to specific tables, grant per-table
      SELECT instead of db_datareader (and also set the ALLOWED_TABLES
      environment variable on the MSSQL-MCP side):

      -- ALTER ROLE [db_datareader] DROP MEMBER [YOUR_LOGIN_NAME];
      -- GRANT SELECT ON [dbo].[Customers] TO [YOUR_LOGIN_NAME];
      -- GRANT SELECT ON [dbo].[Orders]    TO [YOUR_LOGIN_NAME];
*/

-- 4) Doğrulama / Verification
--    TR: Aşağıdaki sorgular yeni kullanıcıyla çalıştırıldığında yazma
--        izinlerinin OLMADIĞINI göstermelidir.
--    EN: Run these as the new user; they must show NO write permissions.

-- EXECUTE AS USER = 'YOUR_LOGIN_NAME';
-- SELECT IS_ROLEMEMBER('db_datareader') AS is_reader;          -- 1 beklenir / expect 1
-- SELECT IS_ROLEMEMBER('db_datawriter') AS is_writer;          -- 0 beklenir / expect 0
-- SELECT permission_name FROM sys.fn_my_permissions(NULL, 'DATABASE');
--   -- Listede INSERT/UPDATE/DELETE/ALTER/CREATE TABLE/EXECUTE/CONTROL
--   -- OLMAMALI / must NOT appear in the list
-- REVERT;
