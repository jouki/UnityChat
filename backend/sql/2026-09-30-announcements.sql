-- UnityChat Announcement v historii chatu (pokyn usera 2026-09-30): dřív jen živá SSE událost,
-- po obnovení zmizel a místo něj se ukázala běžná odpověď StreamElements. Teď se ukládá a
-- /chat/history ho vrací mezi zprávami; potlačená odpověď bota má v content_raw.anncHidden jeho id.
CREATE TABLE IF NOT EXISTS announcements (
  id         text        NOT NULL,
  channel    text        NOT NULL,
  workspace  text        NOT NULL,
  at         timestamptz NOT NULL,
  payload    jsonb       NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, channel)
);
CREATE INDEX IF NOT EXISTS announcements_channel_at_idx ON announcements (channel, at DESC);
