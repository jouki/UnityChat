import type { FastifyInstance } from 'fastify';
import { fetchStoreStatus, isConfigured, type StoreStatus } from '../lib/cwsApi.js';

/**
 * Stav položky v Chrome Web Store pro landing page.
 *
 * Stránka z toho kreslí řádek „nová verze čeká na schválení“, který zmizí,
 * jakmile Google verzi pustí ven. Volá se při každém načtení stránky, proto
 * cache — CWS API nemá zveřejněné limity a nemá smysl ho bít kvůli údaji,
 * který se mění řádově v hodinách.
 */

const CACHE_MS = 10 * 60 * 1000;
const STALE_MS = 60 * 60 * 1000;

let cache: { data: StoreStatus; at: number } | null = null;
let inFlight: Promise<StoreStatus> | null = null;

export default async function storeRoutes(app: FastifyInstance) {
  app.get('/store/status', async (_req, reply) => {
    if (!isConfigured()) {
      reply.code(503);
      return { ok: false, error: 'CWS API není nakonfigurované' };
    }

    const fresh = cache && Date.now() - cache.at < CACHE_MS;
    if (fresh) {
      reply.header('Cache-Control', 'public, max-age=300');
      return { ok: true, ...cache!.data, cached: true };
    }

    try {
      // Souběžné požadavky sdílí jedno volání API místo aby každý spustil svoje.
      inFlight ??= fetchStoreStatus().finally(() => { inFlight = null; });
      const data = await inFlight;
      cache = { data, at: Date.now() };
      reply.header('Cache-Control', 'public, max-age=300');
      return { ok: true, ...data, cached: false };
    } catch (err) {
      app.log.error({ err }, 'CWS fetchStatus selhal');

      // Výpadek API nemá shodit řádek na stránce — dokud je co nabídnout,
      // vrátíme poslední známý stav a označíme ho jako zastaralý.
      if (cache && Date.now() - cache.at < STALE_MS) {
        reply.header('Cache-Control', 'public, max-age=60');
        return { ok: true, ...cache.data, cached: true, stale: true };
      }

      reply.code(502);
      return { ok: false, error: 'Nepodařilo se načíst stav ze Chrome Web Store' };
    }
  });
}
