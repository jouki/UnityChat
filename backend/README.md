# UnityChat Backend

API server for UnityChat. Stores users, cross-platform identities, chat messages, and stream events.

## Stack
- Node.js 22 + TypeScript (ESM)
- Fastify 5
- Drizzle ORM + PostgreSQL 18
- Zod for env validation
- Deployed via Coolify from monorepo (`backend/` subdirectory)

## Schema overview

| Table | Purpose |
|---|---|
| `users` | Canonical user record (one per person, not per platform) |
| `platform_identities` | Links a user to their Twitch/YouTube/Kick handles (many-to-one) |
| `messages` | All chat messages with UnityChat marker detection, reply context, raw segments |
| `events` | Stream events: raids, pins, first-time chatters, bans, timeouts |

## Development

```bash
npm install
cp .env.example .env
# edit .env, set DATABASE_URL to a local Postgres instance
npm run db:push    # apply schema to DB
npm run dev        # starts server on :3000 with hot reload
```

## Endpoints (v0.3.0)

- `GET /` — service info
- `GET /health` — liveness, uptime, SSE clients, `cwsConfigured`, `ingest` status
- `GET /health/db` — database connectivity check (503 if down)
- `GET /nicknames`, `PUT /nicknames`, `DELETE /nicknames`, `GET /nicknames/stream` (SSE)
- `POST /users/seen`, `GET /users`
- `GET /streamers/lookup`, streamer OAuth routes (`/streamers/oauth/*`)
- `GET /store/status` — Chrome Web Store item status (cached 10 min)
- `GET /chat/history` — chat history for the extension (see below)
- `GET /chat/stream` — live messages from the ingest as SSE (web version; see below)
- `POST /auth/:platform/start`, `POST /auth/exchange`, `GET /auth/me`, `POST /auth/logout`, `DELETE /auth/:platform`, `GET /auth/config` — web version login (v0.5.0, Bearer sessions; OAuth callbacks shared with `/streamers/oauth/*`)
- `POST /chat/send` — send a chat message with the logged-in user's token (Twitch Helix / Kick public API / YouTube liveChatMessages)

### Chat ingest + `GET /chat/history`

The server listens to Twitch (anonymous IRC), Kick (Pusher) and YouTube
(live_chat polling) itself and stores every public message in `messages`
with the **platform's own timestamp** (`sent_at`); `created_at` is the time the
server received it, so `created_at - sent_at` is ingest latency. Duplicates are
dropped by the unique index `(platform, platform_message_id)`. Messages are kept indefinitely
(`CHAT_RETENTION_DAYS=0`); a positive value enables hourly deletion of older rows.

Env:

```
CHAT_INGEST_CHANNELS=twitch:robdiesalot,kick:robdiesalot,youtube:robdiesalot   # empty = ingest off; more channels comma-separated
# Production (2026-09-19): + twitch:tensterakdary,youtube:tensterakdary,twitch:arcadebulls,youtube:arcadebulls
CHAT_RETENTION_DAYS=0   # days; 0 = keep indefinitely (deletion on request)
```

```
GET /chat/history?channel=robdiesalot&limit=100[&before=<sent_at_ms>:<id>]
```

- `channel` — Twitch login; YouTube/Kick names come from the `streamers` directory row (falls back to the same name).
- `limit` — 1..200, default 100.
- `before` — cursor from the previous page's `nextBefore` (`sent_at DESC, id DESC` ordering, stable across equal timestamps).
- Response: `{ ok, messages: [oldest → newest], nextBefore: string | null }`. Message shape matches what the
  extension's live providers emit (`platform, id, username, message, timestamp, color, badgesRaw, twitchEmotes,
  replyTo, kickContent, ytRuns, superChat, historical: true`).
- `Cache-Control: no-store`; 10 req/s per IP.

Tests: `npm test` (`node --test`, env from `.env.test`; the DB integration test runs only with `TEST_DATABASE_URL`).

## Database migrations

Using Drizzle Kit:

```bash
npm run db:generate  # generate migration from schema changes
npm run db:push      # apply schema directly (dev/scratch)
npm run db:studio    # visual DB browser
```

## Deployment

Deployed to Coolify as a single Docker application built from this directory's `Dockerfile`. Coolify injects `DATABASE_URL` as an env variable (points to the Coolify-managed `unitychat-db` Postgres instance on the same Docker network).

### `GET /chat/stream` (v0.4.0)

```
GET /chat/stream?channel=robdiesalot[&platforms=twitch,kick,youtube]
```

Server-Sent Events. `channel` is the Twitch login; Kick/YouTube names are
resolved through the `streamers` directory exactly like `/chat/history`.
`platforms` defaults to all three.

- `event: hello` — `{channels, platforms}` right after connecting
- `event: message` — same shape as a `/chat/history` item, with `historical: false`;
  emitted by the ingest **before** the batched DB insert (no flush delay)
- `: keepalive` comment every 15 s
- no replay on reconnect — the client reconciles through `/chat/history`
- max 5 concurrent streams per IP (429 otherwise)

### `GET /commands?channel=<twitch login>` (v0.5.1)

Chat commandy streamera pro našeptávání „!" v panelu i na webu — ze Židolišty
(RobJewsALot server `GET /integrations/:slug/chat-commands`, hlavička `X-Api-Key`).
Klíč zůstává na serveru (`ZIDOLISTA_API_KEY`), kanál → workspace přes
`ZIDOLISTA_WORKSPACES` (`robdiesalot=rob`). Odpověď `{ ok, channel, sources,
commands[{ name, trigger, triggers[], roles[], cooldownSeconds, source }] }`,
regex spouštěče se převádí na literál (`!topd ?reset` → `!topd reset`), cache 60 s,
při výpadku Židolišty poslední známý stav (`stale: true`). 10 req/s/IP.

