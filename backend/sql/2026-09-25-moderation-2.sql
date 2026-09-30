-- Moderace z UnityChatu, část 2 (spec 2026-09-25-moderace-odkazy-gify-design.md: kontextová nabídka
-- na jméno — timeout / ban / unban / varování / permit). Idempotentní (IF NOT EXISTS).
-- Spustit ručně PŘED nasazením backendu (dev se nasazuje hned, souhlas usera):
--   docker exec -i <postgres> psql -U postgres -d unitychat < backend/sql/2026-09-25-moderation-2.sql

-- Známé bany / timeouty v kanálu (vlastní akce + Twitch CLEARCHAT z ingestu). Jeden řádek na
-- (UC kanál, platforma, uživatel); unban řádek smaže. until NULL = permanentní ban.
-- youtube_ban_id: liveChatBans.delete potřebuje id banu z insertu.
CREATE TABLE IF NOT EXISTS moderation_bans (
  channel         text        NOT NULL,
  platform        text        NOT NULL,
  target_user_id  text        NOT NULL,
  target_login    text        NOT NULL,
  until           timestamptz,
  youtube_ban_id  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, platform, target_user_id)
);

-- Povolení odkazů (permit) — zapisuje nabídka moda, čte filtr odkazů v části 3.
CREATE TABLE IF NOT EXISTS link_permits (
  id              bigserial   PRIMARY KEY,
  channel         text        NOT NULL,
  platform        text        NOT NULL,
  target_user_id  text        NOT NULL,
  target_login    text        NOT NULL,
  until           timestamptz NOT NULL,
  "by"            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS link_permits_target_idx ON link_permits (channel, platform, target_user_id);

-- Varování pro uživatele UnityChatu (napříč platformami): okno s důvodem, které musí potvrdit.
CREATE TABLE IF NOT EXISTS account_warnings (
  id               bigserial   PRIMARY KEY,
  account_id       bigint      NOT NULL REFERENCES web_accounts(id) ON DELETE CASCADE,
  channel          text        NOT NULL,
  reason           text        NOT NULL,
  "by"             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  acknowledged_at  timestamptz
);
CREATE INDEX IF NOT EXISTS account_warnings_pending_idx ON account_warnings (account_id) WHERE acknowledged_at IS NULL;
