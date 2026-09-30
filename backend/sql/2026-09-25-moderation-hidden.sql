-- „Jen UC skrýt“ (moderace část 1, Task 6b): zpráva zůstává na platformě, UnityChat ji
-- nevykreslí (lib/messageHides.ts, toClientMessage → hidden: true bez obsahu).
-- Spustit ručně PŘED pushem backendu (dev se nasazuje hned):
--   docker exec -i <postgres> psql -U postgres -d unitychat < backend/sql/2026-09-25-moderation-hidden.sql
ALTER TABLE messages ADD COLUMN IF NOT EXISTS hidden_at timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS hidden_by text;
