-- Nastavení kanálu společné pro všechny (pokyn usera 2026-09-30): zatím varianta odznaku dárce (donorBadge),
-- nastavuje mod / streamer (PUT /moderation/channel-prefs), čtou všichni (GET /channel/prefs), změna jde SSE `channel-prefs`.
CREATE TABLE IF NOT EXISTS channel_prefs (
  channel    text        PRIMARY KEY,
  prefs      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
