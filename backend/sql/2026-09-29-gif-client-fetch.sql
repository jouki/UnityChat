-- Stažení GIFu prohlížečem odesílatele (spec 2026-09-29): zdroj média + předvolba účtu.
ALTER TABLE gif_media ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'server';
CREATE TABLE IF NOT EXISTS account_gif_prefs (
  account_id   bigint PRIMARY KEY REFERENCES web_accounts(id) ON DELETE CASCADE,
  client_fetch text NOT NULL DEFAULT 'ask',
  updated_at   timestamptz NOT NULL DEFAULT now()
);
