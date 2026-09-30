-- Opravy ze závěrečného auditu GIF knihovny (2026-09-27, .superpowers/sdd/2026-09-26-gif-knihovna/audit-*.md).
-- Idempotentní (IF NOT EXISTS). Navazuje na 2026-09-25-gif-requests.sql … 2026-09-27-gif-purge.sql.
-- Backend běží i bez tohoto skriptu (jen pomaleji); spustit ručně:
--   docker exec -i <postgres> psql -U postgres -d unitychat < backend/sql/2026-09-27-gif-audit.sql

-- C1: GET /gif/held hledá žádosti podle původní zprávy (platform, message_id), poslední žádost první.
-- Bez indexu seq scan gif_requests (roste bez retence) na každé veřejné volání.
CREATE INDEX IF NOT EXISTS gif_requests_message_idx ON gif_requests (platform, message_id, id DESC);
