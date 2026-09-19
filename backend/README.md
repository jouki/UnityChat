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

### Chat ingest + `GET /chat/history`

The server listens to Twitch (anonymous IRC), Kick (Pusher) and YouTube
(live_chat polling) itself and stores every public message in `messages`
with the **platform's own timestamp** (`sent_at`); `created_at` is the time the
server received it, so `created_at - sent_at` is ingest latency. Duplicates are
dropped by the unique index `(platform, platform_message_id)`. Messages older
than `CHAT_RETENTION_DAYS` are deleted hourly.

Env:

```
CHAT_INGEST_CHANNELS=twitch:robdiesalot,kick:robdiesalot,youtube:robdiesalot   # empty = ingest off
CHAT_RETENTION_DAYS=7
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
