import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PgDialect } from 'drizzle-orm/pg-core';
import { notNoticeSql, messageCountSql } from './messageNotice.js';

test('messageNotice: výročí (content_raw.notice) se nepočítají jako zprávy', () => {
  const d = new PgDialect();
  assert.match(d.sqlToQuery(notNoticeSql).sql, /\("messages"\."content_raw"->'notice'\) IS NULL/);
  assert.match(d.sqlToQuery(messageCountSql).sql, /^\(count\(\*\) FILTER \(WHERE \("messages"\."content_raw"->'notice'\) IS NULL\)\)::int$/);
});
