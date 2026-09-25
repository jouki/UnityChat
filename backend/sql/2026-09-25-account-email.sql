-- QR dono: ověřený e-mail účtu, rozpracovaná ověření, log odeslaných e-mailů, poslední přezdívka.
-- (schema.ts accountEmails, emailVerifications, emailSendLog, accountDonatePrefs). Spustit ručně:
--   docker exec -i <postgres> psql -U postgres -d unitychat < backend/sql/2026-09-25-account-email.sql
CREATE TABLE IF NOT EXISTS account_emails (
  account_id  bigint      PRIMARY KEY REFERENCES web_accounts(id) ON DELETE CASCADE,
  email       text        NOT NULL,
  verified_at timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS email_verifications (
  account_id   bigint      PRIMARY KEY REFERENCES web_accounts(id) ON DELETE CASCADE,
  email        text        NOT NULL,
  code_hash    text        NOT NULL,
  expires_at   timestamptz NOT NULL,
  attempts     integer     NOT NULL DEFAULT 0,
  sends        integer     NOT NULL DEFAULT 0,
  last_sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS email_send_log (
  id         bigserial   PRIMARY KEY,
  account_id bigint,
  email      text        NOT NULL,
  ip_hash    text        NOT NULL,
  provider   text        NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_send_log_sent_idx ON email_send_log (sent_at);
CREATE TABLE IF NOT EXISTS account_donate_prefs (
  account_id    bigint      PRIMARY KEY REFERENCES web_accounts(id) ON DELETE CASCADE,
  last_nickname text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
