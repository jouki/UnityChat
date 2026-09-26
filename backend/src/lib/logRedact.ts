// Tajné query parametry nesmí do logu (Fastify loguje `req.url` u každého požadavku):
// token pro zamítnuté GIFy (`/media/gif/:id?t=`) a obecně token / access_token / key.
const SECRET_PARAMS = new Set(['t', 'token', 'access_token', 'key']);

/** URL (cesta + query) s hodnotami tajných parametrů nahrazenými `***`. Nerozparsovatelné query zůstane bez změny parametrů jiných jmen. */
export function redactUrl(url: string | undefined): string {
  const s = String(url ?? '');
  const q = s.indexOf('?');
  if (q < 0) return s;
  const hashAt = s.indexOf('#', q);
  const query = s.slice(q + 1, hashAt < 0 ? undefined : hashAt);
  const redacted = query.split('&').map((part) => {
    const eq = part.indexOf('=');
    const name = eq < 0 ? part : part.slice(0, eq);
    let key = name;
    try { key = decodeURIComponent(name.replace(/\+/g, ' ')); } catch { /* ponechat */ }
    return SECRET_PARAMS.has(key.toLowerCase()) ? `${name}=***` : part;
  }).join('&');
  return `${s.slice(0, q)}?${redacted}`;
}

interface ReqLike { method?: string; url?: string; hostname?: string; host?: string; ip?: string; socket?: { remoteAddress?: string; remotePort?: number } }

/** Serializer `req` pro pino/Fastify (stejná pole jako výchozí, URL bez tajemství). */
export function reqSerializer(req: ReqLike) {
  return {
    method: req.method,
    url: redactUrl(req.url),
    host: req.host ?? req.hostname,
    remoteAddress: req.ip ?? req.socket?.remoteAddress,
    remotePort: req.socket?.remotePort,
  };
}
