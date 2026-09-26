-- GIF knihovna — dedup, zamítnuté GIFy, tokenový přístup, retence (spec docs/superpowers/specs/2026-09-26-gif-knihovna-design.md,
-- plán docs/superpowers/plans/2026-09-26-gif-knihovna.md Task 1). Idempotentní (IF NOT EXISTS / podmíněné UPDATE).
-- Spustit ručně PŘED nasazením backendu (dev se nasazuje hned):
--   docker exec -i <postgres> psql -U postgres -d unitychat < backend/sql/2026-09-26-gif-library.sql

-- Médium: kanál (knihovna je per kanál), normalizovaná URL zdroje (dedup před stažením), stav a počítadla.
-- status: pending (čeká na první rozhodnutí) | approved (v knihovně, veřejné) | rejected (jen s tokenem, retence 14 dní).
ALTER TABLE gif_media ADD COLUMN IF NOT EXISTS channel          text;
ALTER TABLE gif_media ADD COLUMN IF NOT EXISTS source_url_norm  text;
ALTER TABLE gif_media ADD COLUMN IF NOT EXISTS status           text        NOT NULL DEFAULT 'pending';
ALTER TABLE gif_media ADD COLUMN IF NOT EXISTS approved_at      timestamptz;
ALTER TABLE gif_media ADD COLUMN IF NOT EXISTS rejected_at      timestamptz;
ALTER TABLE gif_media ADD COLUMN IF NOT EXISTS rejected_by      text;
ALTER TABLE gif_media ADD COLUMN IF NOT EXISTS vault            boolean     NOT NULL DEFAULT false;
ALTER TABLE gif_media ADD COLUMN IF NOT EXISTS use_count        integer     NOT NULL DEFAULT 0;
ALTER TABLE gif_media ADD COLUMN IF NOT EXISTS last_used_at     timestamptz;

-- Doplnění starých řádků (jen kde ještě chybí): kanál ze žádosti.
UPDATE gif_media m SET channel = r.channel
  FROM gif_requests r WHERE r.media_id = m.id AND m.channel IS NULL;
-- Do knihovny (approved) jen média s aspoň jednou žádostí `approved` (GIF je v chatu vidět).
UPDATE gif_media m SET status = 'approved',
       approved_at = COALESCE(m.approved_at, (SELECT min(r.decided_at) FROM gif_requests r WHERE r.media_id = m.id AND r.status = 'approved')),
       use_count = GREATEST(m.use_count, (SELECT count(*) FROM gif_requests r WHERE r.media_id = m.id AND r.status IN ('approved', 'deleted'))),
       last_used_at = COALESCE(m.last_used_at, (SELECT max(r.decided_at) FROM gif_requests r WHERE r.media_id = m.id AND r.status IN ('approved', 'deleted')))
  WHERE m.status = 'pending'
    AND EXISTS (SELECT 1 FROM gif_requests r WHERE r.media_id = m.id AND r.status = 'approved');
-- Média, jejichž všechny žádosti mají zprávu smazanou modem (status deleted) → zamítnutá (retence 14 dní).
-- Podmínka „všechny deleted" platí i při opakovaném spuštění: médium schválené ze Zamítnutých má vždy i žádost rejected.
UPDATE gif_media m SET status = 'rejected', approved_at = NULL,
       rejected_at = COALESCE(m.rejected_at, (SELECT max(r.decided_at) FROM gif_requests r WHERE r.media_id = m.id), now()),
       rejected_by = COALESCE(m.rejected_by, 'backfill')
  WHERE m.status IN ('pending', 'approved')
    AND EXISTS (SELECT 1 FROM gif_requests r WHERE r.media_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM gif_requests r WHERE r.media_id = m.id AND r.status <> 'deleted');

-- Schválené duplikáty obsahu (před dedupem) — ponechat nejstarší schválené, ostatní jako čekající alias
-- (staré zprávy na ně odkazují přes content_raw.gif.mediaId, musí zůstat veřejné; dedup najde schválené).
UPDATE gif_media m SET status = 'pending'
  WHERE m.status = 'approved'
    AND EXISTS (SELECT 1 FROM gif_media o
                WHERE o.status = 'approved' AND o.channel = m.channel AND o.sha256 = m.sha256 AND o.id <> m.id
                  AND (COALESCE(o.approved_at, o.created_at), o.id) < (COALESCE(m.approved_at, m.created_at), m.id));

-- Dedup: stejná URL / stejný obsah = jeden schválený GIF na kanál (souběh řeší setMediaApproved).
CREATE UNIQUE INDEX IF NOT EXISTS gif_media_channel_url_approved_uq
  ON gif_media (channel, source_url_norm) WHERE status = 'approved' AND source_url_norm IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS gif_media_channel_sha_approved_uq
  ON gif_media (channel, sha256) WHERE status = 'approved' AND channel IS NOT NULL;
CREATE INDEX IF NOT EXISTS gif_media_channel_url_idx ON gif_media (channel, source_url_norm);
CREATE INDEX IF NOT EXISTS gif_media_channel_sha_idx ON gif_media (channel, sha256);
-- Zamítnuté GIFy kanálu (seznam pro mody) + retence.
CREATE INDEX IF NOT EXISTS gif_media_rejected_idx ON gif_media (channel, rejected_at) WHERE status = 'rejected';

-- FIFO fronta čekajících žádostí kanálu.
CREATE INDEX IF NOT EXISTS gif_requests_channel_pending_idx ON gif_requests (channel, created_at, id) WHERE status = 'pending';

-- Kolikrát byl GIF zamítnut konkrétnímu uživateli (3.+ pokus = automaticky zamítnuto).
CREATE TABLE IF NOT EXISTS gif_rejections (
  channel   text        NOT NULL,
  media_id  text        NOT NULL REFERENCES gif_media(id) ON DELETE CASCADE,
  platform  text        NOT NULL,
  user_id   text        NOT NULL,
  count     integer     NOT NULL DEFAULT 0,
  last_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, media_id, platform, user_id)
);

-- „Automaticky zahazovat 12 h" — GIF od všech (mod na kartě žádosti).
CREATE TABLE IF NOT EXISTS gif_bans (
  channel   text        NOT NULL,
  media_id  text        NOT NULL REFERENCES gif_media(id) ON DELETE CASCADE,
  until     timestamptz NOT NULL,
  by        text,
  PRIMARY KEY (channel, media_id)
);

-- Tokeny pro zamítnutá média (/media/gif/:id?t=). V DB jen SHA-256 hash tokenu.
-- account_id = token moda (ověří se, že je stále mod kanálu média); integration_slug = token Židolišty (dashboard).
CREATE TABLE IF NOT EXISTS gif_access_tokens (
  id                bigserial   PRIMARY KEY,
  account_id        bigint      REFERENCES web_accounts(id) ON DELETE CASCADE,
  integration_slug  text,
  token_hash        text        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz,
  CHECK ((account_id IS NULL) <> (integration_slug IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS gif_access_tokens_hash_uq ON gif_access_tokens (token_hash);
CREATE INDEX IF NOT EXISTS gif_access_tokens_account_idx ON gif_access_tokens (account_id) WHERE revoked_at IS NULL;
