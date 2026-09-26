-- GIF — náhled a dvě varianty „Trvale zahodit“ (spec docs/superpowers/specs/2026-09-27-gif-nahled-zahozeni-design.md).
-- Idempotentní (IF NOT EXISTS). Navazuje na 2026-09-25-gif-requests.sql, 2026-09-26-gif-library.sql, 2026-09-26-gif-phash.sql.
-- Spustit ručně PŘED nasazením backendu (dev se nasazuje hned):
--   docker exec -i <postgres> psql -U postgres -d unitychat < backend/sql/2026-09-27-gif-purge.sql
--
-- gif_media.status je text bez CHECK constraintu / enumu (2026-09-26-gif-library.sql) → nové stavy nepotřebují ALTER:
--   withdrawn   „Zahodit, zprávy nechat“: mimo knihovnu i zamítnuté, soubor zůstává, staré zprávy ho ukazují veřejně
--   purging     „Zahodit i se zprávami“: zprávy schované (gif_removed), soubor + záznam se smažou v purge_at (7 dní)
--   unavailable stažený GIF po „Odstranit ze serveru“: bytes prázdné, záznam zůstává (štítek „[GIF nedostupný]“, dedup)
-- Unikátní indexy (channel, sha256) a (channel, source_url_norm) platí jen pro approved — zahozená média je neblokují
-- a dedup (findMedia) je pozná podle sha256 / URL a nový odkaz automaticky zamítne.

-- Kdy a kým zahozeno, kdy se smaže (jen purging), stav před zahozením (obnova: approved → knihovna, rejected → zamítnuté).
ALTER TABLE gif_media ADD COLUMN IF NOT EXISTS purged_at            timestamptz;
ALTER TABLE gif_media ADD COLUMN IF NOT EXISTS purged_by            text;
ALTER TABLE gif_media ADD COLUMN IF NOT EXISTS purge_at             timestamptz;
ALTER TABLE gif_media ADD COLUMN IF NOT EXISTS status_before_purge  text;

-- Záložka Zamítnuté: sekce „Stažené GIFy“ (withdrawn) a „Ke smazání“ (purging), nejnovější zahození první.
CREATE INDEX IF NOT EXISTS gif_media_discarded_idx
  ON gif_media (channel, status, purged_at DESC, id DESC) WHERE status IN ('withdrawn', 'purging');
-- Retenční tick (1×/h): purging s purge_at <= now.
CREATE INDEX IF NOT EXISTS gif_media_purge_due_idx ON gif_media (purge_at) WHERE status = 'purging';
