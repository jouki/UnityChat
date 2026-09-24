-- „Odhlásit se" odhlásí všechny platformy účtu (2026-09-24, lib/webAuth.ts signOutAccount):
-- identita zůstává kvůli návaznosti účtu, tokeny se zahodí, do dalšího přihlášení se nepočítá.
ALTER TABLE web_identities ADD COLUMN IF NOT EXISTS signed_out_at timestamptz;
