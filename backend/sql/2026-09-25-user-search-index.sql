-- `/user <text>` — našeptávač uživatelů kanálu pro moda (lib/userSearch.ts, GET /moderation/users/search).
-- Hledá v messages.platform_username v rozsahu kanálu (channel IN …) bez diakritiky a velikosti přes uc_fold().
--
-- PŘEDPOKLAD: sql/2026-09-25-chat-log-search.sql už běžel (pg_trgm, unaccent, funkce uc_fold a trigramový
-- index messages_username_fold_trgm = fulltext „kdekoli ve jméně“). Bez uc_fold route vrací 500.
-- Kdyby CREATE EXTENSION pg_trgm na produkci nešel: fulltext funguje dál přes seq scan (LIKE '%…%'
-- s filtrem kanálu, dnes ~35 tis. řádků = jednotky ms), jen bez indexu.
--
-- Spustit ručně PŘED nasazením backendu (CONCURRENTLY = bez zámku zápisu ingestu; nesmí běžet v transakci):
--   docker exec -i <postgres> psql -U postgres -d unitychat < backend/sql/2026-09-25-user-search-index.sql
--
-- Po doběhnutí ověřit, že indexy jsou platné (přerušený CONCURRENTLY nechá NEPLATNÝ index, který IF NOT
-- EXISTS při dalším spuštění přeskočí):
--   SELECT c.relname, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE c.relname IN ('messages_channel_username_fold_prefix_idx', 'nicknames_nickname_fold_trgm');
-- Když indisvalid = false: DROP INDEX CONCURRENTLY IF EXISTS <jméno>; a tenhle soubor spustit znovu.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Prefix („začíná na“, výchozí režim): btree s text_pattern_ops umí LIKE 'abc%' (i pro 1–2 znaky, kde trigram
-- nepomůže). Kanál první → rozsah kanálu + prefix jména v jednom průchodu indexem.
CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_channel_username_fold_prefix_idx
  ON messages (channel, uc_fold(platform_username) text_pattern_ops);

-- UC přezdívky (hledá se i podle nich, prefix i kdekoli) — tabulka je malá, index jen ať neroste seq scan.
CREATE INDEX CONCURRENTLY IF NOT EXISTS nicknames_nickname_fold_trgm
  ON nicknames USING gin (uc_fold(nickname) gin_trgm_ops);
