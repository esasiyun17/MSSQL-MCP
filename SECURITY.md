# Security Policy / Güvenlik Politikası

## 🇹🇷 Türkçe

### Desteklenen sürümler

| Sürüm | Destek |
|---|---|
| 1.x | ✅ Güvenlik yamaları |

### Güvenlik açığı bildirme

MSSQL-MCP'nin var oluş nedeni güvenliktir; bildirimleri ciddiyetle ele alıyoruz.

- Açığı **herkese açık bir issue olarak PAYLAŞMAYIN.**
- GitHub'ın **"Report a vulnerability"** (Security Advisories) özelliğini kullanın:
  <https://github.com/esasiyun17/MSSQL-MCP/security/advisories/new>
- Bildiriminizde şunlar yardımcı olur: etkilenen sürüm, yeniden üretme adımları
  (mümkünse örnek sorgu/konfigürasyon), etki değerlendirmeniz.
- 72 saat içinde ilk yanıtı vermeyi hedefliyoruz. Doğrulanan açıklar için düzeltme
  yayınlanana kadar koordineli gizlilik rica ederiz; düzeltme notlarında
  (isterseniz) adınızla teşekkür ederiz.

Özellikle ilgilendiğimiz sınıflar: sorgu filtresini (query guard) atlatma,
salt-okunurluk doğrulamasını yanıltma, kimlik bilgisi sızıntısı, tablo beyaz
listesini aşma.

## 🇬🇧 English

### Supported versions

| Version | Supported |
|---|---|
| 1.x | ✅ Security patches |

### Reporting a vulnerability

Security is the reason MSSQL-MCP exists; we take reports seriously.

- Please do **NOT open a public issue** for vulnerabilities.
- Use GitHub's **"Report a vulnerability"** (Security Advisories) feature:
  <https://github.com/esasiyun17/MSSQL-MCP/security/advisories/new>
- Helpful details: affected version, reproduction steps (sample query/config if
  possible), your impact assessment.
- We aim to respond within 72 hours. For confirmed issues we ask for
  coordinated disclosure until a fix ships; we're happy to credit you in the
  release notes if you wish.

Classes we care about most: query-guard bypasses, fooling the read-only
verification, credential leakage, table-allowlist escapes.
