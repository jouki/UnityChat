-- Odznak podporovatele — individuální volba účtu (pokyn usera 2026-09-30): odznak UnityChat u vlastních zpráv
-- na Twitchi nahradí globální odznak Twitche (jinak má vlastní slot vedle ostatních). Ostatní volby (varianta,
-- tempo, intenzita, odstupy) zůstávají společné pro kanál (channel_prefs, jen mod / streamer v dev módu).
CREATE TABLE IF NOT EXISTS account_badge_prefs (
  account_id     bigint PRIMARY KEY REFERENCES web_accounts(id) ON DELETE CASCADE,
  replace_global boolean NOT NULL DEFAULT false,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
