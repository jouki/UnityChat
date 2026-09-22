-- Identity chat bota Židolišty (schema.ts botIdentities). Spustit ručně:
--   docker exec -i <postgres> psql -U postgres -d unitychat < backend/sql/2026-09-22-bot-identities.sql
CREATE TABLE IF NOT EXISTS bot_identities (
  workspace               text NOT NULL,
  platform                text NOT NULL,
  platform_user_id        text NOT NULL,
  login                   text NOT NULL,
  display_name            text,
  avatar_url              text,
  access_token_encrypted  bytea NOT NULL,
  refresh_token_encrypted bytea,
  token_iv                bytea NOT NULL,
  token_auth_tag          bytea NOT NULL,
  refresh_iv              bytea,
  refresh_auth_tag        bytea,
  expires_at              timestamptz,
  scopes                  text[],
  key_version             integer NOT NULL DEFAULT 1,
  state                   text NOT NULL DEFAULT 'online',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bot_identities_pk PRIMARY KEY (workspace, platform)
);
