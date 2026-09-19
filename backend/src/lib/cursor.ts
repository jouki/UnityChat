/** Kurzor stránkování: "<sent_at_ms>:<id>" poslední (nejstarší) zprávy stránky. */
export function encodeCursor(sentAtMs: number, id: number): string {
  return `${sentAtMs}:${id}`;
}

export function decodeCursor(s: string): { sentAtMs: number; id: number } | null {
  const m = /^(\d{1,16}):(\d{1,16})$/.exec(s || '');
  if (!m) return null;
  return { sentAtMs: Number(m[1]), id: Number(m[2]) };
}
