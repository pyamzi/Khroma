import type { Context } from 'hono';
import { AdminError } from '../domain/admin.js';
import { TeamError } from '../domain/settings.js';
import { Conflict, SelectionError } from '../domain/selection.js';
import { TransitionError } from '../domain/transitions.js';
import { CommentError } from '../domain/comments.js';
import { LibraryError } from '../domain/library.js';

const STATUS: Record<string, 400 | 403 | 404 | 409 | 413 | 415 | 422> = { not_found: 404, exists: 409, too_large: 413, unsupported: 415, forbidden: 403, invalid: 400 };

/** Domain errors become 4xx JSON; anything else propagates. */
export function fail(c: Context, e: unknown): Response {
  if (e instanceof Conflict) return c.json({ error: 'conflict', selectionVersion: e.selectionVersion }, 409);
  if (e instanceof AdminError || e instanceof TeamError || e instanceof SelectionError || e instanceof TransitionError || e instanceof CommentError || e instanceof LibraryError) {
    return c.json({ error: e.code }, STATUS[e.code] ?? 422);
  }
  throw e;
}
