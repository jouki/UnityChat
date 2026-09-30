-- GIF knihovna, Task 2 — tagy, perceptuální hash, návrhy duplikátů (spec docs/superpowers/specs/2026-09-26-gif-knihovna-design.md,
-- plán docs/superpowers/plans/2026-09-26-gif-knihovna.md Task 2). Idempotentní (IF NOT EXISTS). Navazuje na 2026-09-26-gif-library.sql.
-- Spustit ručně PŘED nasazením backendu (dev se nasazuje hned):
--   docker exec -i <postgres> psql -U postgres -d unitychat < backend/sql/2026-09-26-gif-phash.sql

-- Tagy (ze stránky Tenor / Giphy při stažení, úprava přes integraci Židolišty): malá písmena, ≤ 20, každý ≤ 40 znaků.
ALTER TABLE gif_media ADD COLUMN IF NOT EXISTS tags            text[]      NOT NULL DEFAULT '{}'::text[];
-- Perceptuální hash: pole dHashů (16 hex) z 8 snímků rovnoměrně v čase; NULL = zatím nespočítáno nebo selhalo.
ALTER TABLE gif_media ADD COLUMN IF NOT EXISTS phash           text[];
-- Kdy se hash počítal (i neúspěšně — pak phash NULL a znovu se nezkouší); NULL = čeká na dopočet na pozadí.
ALTER TABLE gif_media ADD COLUMN IF NOT EXISTS phash_at        timestamptz;
-- Kdy se médium porovnalo s ostatními médii kanálu (návrhy duplikátů); NULL = ještě ne.
ALTER TABLE gif_media ADD COLUMN IF NOT EXISTS dup_checked_at  timestamptz;

-- Knihovna kanálu řazená podle použití (GET /gifs/library, GET /integrations/:slug/gifs).
CREATE INDEX IF NOT EXISTS gif_media_library_idx
  ON gif_media (channel, use_count DESC, (COALESCE(last_used_at, 'epoch'::timestamptz)) DESC, id DESC) WHERE status = 'approved';
-- Dopočet hashů a kontrola duplikátů na pozadí.
CREATE INDEX IF NOT EXISTS gif_media_phash_todo_idx ON gif_media (created_at) WHERE phash_at IS NULL;
CREATE INDEX IF NOT EXISTS gif_media_dupcheck_todo_idx ON gif_media (created_at) WHERE dup_checked_at IS NULL AND phash IS NOT NULL;

-- Návrhy duplikátů (jen v rámci kanálu). a = starší médium („první"), b = novější („druhý").
-- status: pending (čeká na mody) | kept_both („nechat oba", znovu se nenavrhne). Nechat první/druhý = sloučení,
-- druhé médium se smaže a řádek zmizí kaskádou (audit v moderation_actions).
CREATE TABLE IF NOT EXISTS gif_duplicates (
  id          bigserial   PRIMARY KEY,
  channel     text        NOT NULL,
  a           text        NOT NULL REFERENCES gif_media(id) ON DELETE CASCADE,
  b           text        NOT NULL REFERENCES gif_media(id) ON DELETE CASCADE,
  score       real        NOT NULL,
  status      text        NOT NULL DEFAULT 'pending',
  created_at  timestamptz NOT NULL DEFAULT now(),
  decided_at  timestamptz,
  decided_by  text,
  CHECK (a <> b)
);
-- Dvojice jen jednou (bez ohledu na pořadí).
CREATE UNIQUE INDEX IF NOT EXISTS gif_duplicates_pair_uq ON gif_duplicates (LEAST(a, b), GREATEST(a, b));
CREATE INDEX IF NOT EXISTS gif_duplicates_channel_idx ON gif_duplicates (channel, status, created_at);
