/** Postgres SQLSTATE of an error, looking through drizzle's "Failed query" wrapper. 23505 unique, 23503 foreign key. */
export function pgCode(e: unknown): string | undefined {
  for (let x = e as { code?: unknown; cause?: unknown } | undefined; x; x = x.cause as typeof x) if (typeof x.code === 'string') return x.code;
  return undefined;
}
export function pgMessage(e: unknown): string {
  let x = e as { message?: string; cause?: unknown } | undefined;
  while (x?.cause) x = x.cause as typeof x;
  return x?.message ?? String(e);
}
