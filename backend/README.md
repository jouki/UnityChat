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

## Endpoints (v0.1.0)

- `GET /` — service info
- `GET /health` — basic liveness, returns uptime
- `GET /health/db` — database connectivity check (503 if down)

More endpoints will be added as features land.

## Database migrations

Using Drizzle Kit:

```bash
npm run db:generate  # generate migration from schema changes
npm run db:push      # apply schema directly (dev/scratch)
npm run db:studio    # visual DB browser
```

## Deployment

Deployed to Coolify as a single Docker application built from this directory's `Dockerfile`. Coolify injects `DATABASE_URL` as an env variable (points to the Coolify-managed `unitychat-db` Postgres instance on the same Docker network).
