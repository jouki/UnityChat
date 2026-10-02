-- Kolo štěstí pro podporovatele (spec docs/superpowers/specs/2026-10-02-kolo-stesti-design.md, lib/giveaway.ts).
CREATE TABLE IF NOT EXISTS giveaways (
  id bigserial PRIMARY KEY,
  channel text NOT NULL,
  prize text NOT NULL,
  confirm_minutes integer NOT NULL DEFAULT 15,
  status text NOT NULL,
  winner_account_id bigint REFERENCES web_accounts(id) ON DELETE SET NULL,
  winner_name text,
  winner_platform text,
  deadline timestamptz,
  draw_seq integer NOT NULL DEFAULT 0,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Jedno nekončené kolo na kanál (pojistka k zámku v procesu).
CREATE UNIQUE INDEX IF NOT EXISTS giveaways_one_active ON giveaways (channel) WHERE status IN ('open', 'pending', 'confirmed', 'expired');
CREATE INDEX IF NOT EXISTS giveaways_channel_idx ON giveaways (channel, id DESC);

CREATE TABLE IF NOT EXISTS giveaway_entries (
  giveaway_id bigint NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE,
  account_id bigint NOT NULL REFERENCES web_accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  platform text NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  excluded boolean NOT NULL DEFAULT false,
  won boolean NOT NULL DEFAULT false,
  PRIMARY KEY (giveaway_id, account_id)
);
