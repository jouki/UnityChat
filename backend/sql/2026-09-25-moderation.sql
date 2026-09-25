-- Moderace z UnityChatu (spec 2026-09-25-moderace-odkazy-gify-design.md, část 1).
-- Sloupce pro smazané zprávy + log akcí moderátora.
-- Spustit ručně PŘED pushem backendu (dev se nasazuje hned):
--   docker exec -i <postgres> psql -U postgres -d unitychat < backend/sql/2026-09-25-moderation.sql
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at     timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_by     text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_reason text;

CREATE TABLE IF NOT EXISTS moderation_actions (
  id                 bigserial   PRIMARY KEY,
  channel            text        NOT NULL,
  account_id         bigint      REFERENCES web_accounts(id) ON DELETE SET NULL,
  actor              text        NOT NULL,
  action             text        NOT NULL,
  platform           text        NOT NULL,
  target_login       text,
  target_message_id  text,
  params             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  result             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS moderation_actions_channel_idx ON moderation_actions (channel, created_at DESC);
