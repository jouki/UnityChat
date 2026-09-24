-- Soundboard (schema.ts soundboardFavorites, soundboardUsage). Spustit ručně:
--   docker exec -i <postgres> psql -U postgres -d unitychat < backend/sql/2026-09-24-soundboard.sql
CREATE TABLE IF NOT EXISTS soundboard_favorites (
  account_id bigint      NOT NULL REFERENCES web_accounts(id) ON DELETE CASCADE,
  workspace  text        NOT NULL,
  sound_id   integer     NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT soundboard_favorites_pk PRIMARY KEY (account_id, workspace, sound_id)
);

CREATE TABLE IF NOT EXISTS soundboard_usage (
  account_id   bigint      NOT NULL REFERENCES web_accounts(id) ON DELETE CASCADE,
  workspace    text        NOT NULL,
  sound_id     integer     NOT NULL,
  count        integer     NOT NULL DEFAULT 0,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT soundboard_usage_pk PRIMARY KEY (account_id, workspace, sound_id)
);
