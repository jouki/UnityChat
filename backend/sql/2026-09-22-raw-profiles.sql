-- Profily browser source (schema.ts rawProfiles). Spustit ručně:
--   docker exec -i <postgres> psql -U postgres -d unitychat < backend/sql/2026-09-22-raw-profiles.sql
CREATE TABLE IF NOT EXISTS raw_profiles (
  id         text PRIMARY KEY,
  settings   jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
