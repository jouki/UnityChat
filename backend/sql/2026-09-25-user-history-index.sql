-- Chat historie z nabídky moda (lib/userHistory.ts): zprávy uživatele přes (platform, platform_user_id)
-- napříč všemi kanály, řazené podle času. Bez indexu by šlo o sekvenční průchod celého archivu.
-- ASC stačí — Postgres index projde pozpátku pro ORDER BY sent_at DESC.
-- Spustit ručně PŘED nasazením backendu (CONCURRENTLY = bez zámku zápisu ingestu; nesmí běžet v transakci):
--   docker exec -i <postgres> psql -U postgres -d unitychat < backend/sql/2026-09-25-user-history-index.sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_platform_user_sent_idx ON messages (platform, platform_user_id, sent_at);
