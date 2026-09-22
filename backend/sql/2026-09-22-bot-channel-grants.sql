-- Souhlas broadcastera s botem v kanálu (Twitch scope channel:bot → odznak „Chat Bot").
-- Tokeny se neukládají — Twitch si souhlas pamatuje sám; tady jen záznam pro stav v UI.
--   docker exec -i <postgres> psql -U postgres -d unitychat < backend/sql/2026-09-22-bot-channel-grants.sql
CREATE TABLE IF NOT EXISTS bot_channel_grants (
  workspace        text NOT NULL,
  platform         text NOT NULL,
  login            text NOT NULL,
  platform_user_id text NOT NULL,
  granted_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bot_channel_grants_pk PRIMARY KEY (workspace, platform)
);
