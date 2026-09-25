-- Moderace z UnityChatu, část 4 — odměna „Posílání GIFů" (spec 2026-09-25-moderace-odkazy-gify-design.md).
-- Idempotentní (IF NOT EXISTS). Spustit ručně PŘED nasazením backendu (dev se nasazuje hned):
--   docker exec -i <postgres> psql -U postgres -d unitychat < backend/sql/2026-09-25-gif-requests.sql

-- Médium stažené serverem (GIF / WebP / MP4, ≤ 10 MB). V DB, protože kontejner backendu nemá trvalý svazek.
-- Zamítnuté a propadlé se mažou hned; schválené zůstávají (retence archivu).
CREATE TABLE IF NOT EXISTS gif_media (
  id            text        PRIMARY KEY,
  kind          text        NOT NULL,
  content_type  text        NOT NULL,
  bytes         bytea       NOT NULL,
  size          integer     NOT NULL,
  sha256        text        NOT NULL,
  width         integer,
  height        integer,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Žádost o schválení GIFu. status: pending | approved | rejected | expired | deleted (schválený GIF smazaný modem).
-- První rozhodnutí vyhrává (UPDATE … WHERE status = 'pending' AND expires_at > now()).
CREATE TABLE IF NOT EXISTS gif_requests (
  id                 bigserial   PRIMARY KEY,
  channel            text        NOT NULL,
  workspace          text        NOT NULL,
  platform           text        NOT NULL,
  platform_channel   text        NOT NULL,
  user_id            text        NOT NULL,
  login              text        NOT NULL,
  message_id         text        NOT NULL,
  text_without_link  text        NOT NULL DEFAULT '',
  media_id           text        REFERENCES gif_media(id) ON DELETE SET NULL,
  kind               text        NOT NULL,
  width              integer,
  height             integer,
  meta               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status             text        NOT NULL DEFAULT 'pending',
  decided_by         text,
  decided_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS gif_requests_pending_idx ON gif_requests (status, expires_at);
CREATE INDEX IF NOT EXISTS gif_requests_channel_idx ON gif_requests (channel, created_at);
