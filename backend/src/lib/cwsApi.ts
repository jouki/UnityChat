/**
 * Chrome Web Store API v2 — čtení stavu položky.
 *
 * Slouží endpointu /store/status, ze kterého si landing page bere informaci,
 * jestli nějaká verze čeká na schválení. Klíč zůstává na serveru; v prohlížeči
 * by být nemohl.
 *
 * POZN. k duplicitě: `scripts/cws.mjs` v kořeni repa dělá totéž (a navíc umí
 * upload/publish pro CI). Sdílet kód nejde — backend se builduje z `backend/`
 * jako Docker base directory, takže `scripts/` není v build kontextu. Duplikace
 * ~40 řádků JWT logiky je proto vědomá. Když se změní způsob autentizace,
 * je potřeba upravit obě místa.
 *
 * V1 API končí 15. 10. 2026, tohle jede na v2.
 */

import { createSign } from 'node:crypto';
import { config } from '../config.js';

const API = 'https://chromewebstore.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';

export type StoreStatus = {
  /** Verze, kterou dostávají uživatelé. Null, když položka ještě není venku. */
  published: string | null;
  /** Verze čekající na schválení. Null, když nic nečeká. */
  pending: string | null;
  /** Google nahlásil porušení policy / položka byla stažena. */
  warned: boolean;
  takenDown: boolean;
  /** Kdy se stav naposled načetl z API (ISO). */
  fetchedAt: string;
};

type ServiceAccountKey = {
  client_email: string;
  private_key: string;
  token_uri: string;
};

function b64url(input: string): string {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function loadKey(): ServiceAccountKey {
  if (!config.CWS_SERVICE_ACCOUNT) {
    throw new Error('CWS_SERVICE_ACCOUNT není nastavený');
  }
  return JSON.parse(config.CWS_SERVICE_ACCOUNT) as ServiceAccountKey;
}

/** Access token z podepsaného JWT. Tokeny žijí hodinu, cachujeme je zvlášť. */
let tokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.token;
  }

  const key = loadKey();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    scope: SCOPE,
    aud: key.token_uri,
    iat: now,
    exp: now + 3600,
  }));

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(key.private_key, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const res = await fetch(key.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
  });

  if (!res.ok) {
    throw new Error(`Výměna JWT za token selhala: HTTP ${res.status}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return data.access_token;
}

type RevisionStatus = {
  state?: string;
  distributionChannels?: Array<{ crxVersion?: string }>;
};

function versionOf(revision: RevisionStatus | undefined): string | null {
  return revision?.distributionChannels?.[0]?.crxVersion ?? null;
}

export async function fetchStoreStatus(): Promise<StoreStatus> {
  const token = await getAccessToken();
  const url = `${API}/v2/publishers/${config.CWS_PUBLISHER_ID}/items/${config.CWS_ITEM_ID}:fetchStatus`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`fetchStatus selhal: HTTP ${res.status}`);
  }

  const data = await res.json() as {
    publishedItemRevisionStatus?: RevisionStatus;
    submittedItemRevisionStatus?: RevisionStatus;
    warned?: boolean;
    takenDown?: boolean;
  };

  return {
    published: versionOf(data.publishedItemRevisionStatus),
    pending: versionOf(data.submittedItemRevisionStatus),
    warned: Boolean(data.warned),
    takenDown: Boolean(data.takenDown),
    fetchedAt: new Date().toISOString(),
  };
}

/** Je endpoint vůbec nakonfigurovaný? Bez klíče nemá smysl volat API. */
export function isConfigured(): boolean {
  return Boolean(config.CWS_SERVICE_ACCOUNT && config.CWS_PUBLISHER_ID);
}
