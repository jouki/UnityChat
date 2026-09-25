-- Změny přezdívek hlásí sama databáze (pg_notify 'uc_nickname') → backend LISTEN → SSE
-- nickname-change / nickname-delete všem klientům. Platí pro API i pro ruční opravu v DB
-- (pokyn usera 2026-09-25). Spustit ručně PŘED nasazením backendu, který přestal vysílat SSE sám:
--   docker exec -i <postgres> psql -U postgres -d unitychat < backend/sql/2026-09-25-nicknames-notify.sql
CREATE OR REPLACE FUNCTION uc_notify_nickname() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('uc_nickname', json_build_object('op', 'delete', 'platform', OLD.platform, 'username', OLD.username)::text);
    RETURN OLD;
  END IF;
  PERFORM pg_notify('uc_nickname', json_build_object('op', 'upsert', 'platform', NEW.platform, 'username', NEW.username,
    'nickname', NEW.nickname, 'color', NEW.color)::text);
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS nicknames_notify ON nicknames;
CREATE TRIGGER nicknames_notify AFTER INSERT OR UPDATE OR DELETE ON nicknames
  FOR EACH ROW EXECUTE FUNCTION uc_notify_nickname();
