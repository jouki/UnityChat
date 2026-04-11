import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '../config.js';
import * as schema from './schema.js';

const client = postgres(config.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
});

export const db = drizzle(client, { schema });

export async function pingDb(): Promise<boolean> {
  try {
    await client`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export async function closeDb(): Promise<void> {
  await client.end({ timeout: 5 });
}
