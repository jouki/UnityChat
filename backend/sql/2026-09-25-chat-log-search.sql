-- Chat Log (dashboard Židolišty): fulltext v celém archivu bez diakritiky a velikosti písmen.
-- Spustit ručně PŘED nasazením routes/chatLog.ts:
--   docker exec -i <postgres> psql -U postgres -d unitychat < backend/sql/2026-09-25-chat-log-search.sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
-- unaccent() není IMMUTABLE (závisí na search_path) → obal s pevným slovníkem, ať jde indexovat.
CREATE OR REPLACE FUNCTION uc_fold(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT lower(public.unaccent('public.unaccent'::regdictionary, $1)) $$;
CREATE INDEX IF NOT EXISTS messages_content_fold_trgm ON messages USING gin (uc_fold(content) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS messages_username_fold_trgm ON messages USING gin (uc_fold(platform_username) gin_trgm_ops);
