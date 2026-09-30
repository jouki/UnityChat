-- Instance OBS chatu (raw_profiles) navázané na kanál (2026-09-28): seznam instancí kanálu vidí a upravují streamer
-- a modi (ověří server); nepřipojené instance (channel NULL) fungují jako dřív (odkaz s id).
ALTER TABLE raw_profiles ADD COLUMN IF NOT EXISTS channel text;
ALTER TABLE raw_profiles ADD COLUMN IF NOT EXISTS claimed_by integer;
CREATE INDEX IF NOT EXISTS raw_profiles_channel_idx ON raw_profiles (channel, created_at) WHERE channel IS NOT NULL;
