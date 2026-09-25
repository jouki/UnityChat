-- Chat historie z nabídky moda (lib/userHistory.ts): zprávy uživatele přes (platform, platform_user_id)
-- napříč všemi kanály, od nejnovější. Stránka zpráv = UNION ALL s LIMIT per identita → každá větev
-- projde index jen o stránku; INCLUDE (channel) = filtr záložky (channel IN …) a GROUP BY kanálů
-- bez čtení řádků tabulky (index-only scan, když je visibility map čerstvá).
-- Spustit ručně PŘED nasazením backendu (CONCURRENTLY = bez zámku zápisu ingestu; nesmí běžet v transakci):
--   docker exec -i <postgres> psql -U postgres -d unitychat < backend/sql/2026-09-25-user-history-index.sql
--
-- Po doběhnutí ověřit, že index je platný (CONCURRENTLY při chybě / přerušení nechá NEPLATNÝ index,
-- který se neudržuje ani nepoužívá, a IF NOT EXISTS by ho při dalším spuštění přeskočil):
--   SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE c.relname = 'messages_platform_user_sent_idx';
-- Když indisvalid = false:
--   DROP INDEX CONCURRENTLY IF EXISTS messages_platform_user_sent_idx;
-- a tenhle soubor spustit znovu.
CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_platform_user_sent_idx
  ON messages (platform, platform_user_id, sent_at DESC) INCLUDE (channel);
