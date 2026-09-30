import { sql, type SQL } from 'drizzle-orm';
import { messages } from '../db/schema.js';

/**
 * Výročí uložená z Twitch USERNOTICE (sub / resub / modiversary, ingest normalizeTwitchUsernotice →
 * content_raw.notice) nejsou zprávy uživatele: nepočítají se do počtů zpráv (Profil, top 20 chat logu,
 * hledání uživatelů). V seznamu zpráv v Profilu zůstávají jako událost.
 */
export const notNoticeSql: SQL = sql`(${messages.contentRaw}->'notice') IS NULL`;

/** count(*) jen běžných zpráv (bez výročí). */
export const messageCountSql = sql<number>`(count(*) FILTER (WHERE (${messages.contentRaw}->'notice') IS NULL))::int`;
