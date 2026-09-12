import type { Context } from 'hono';
import { FilesError } from '../domain/files.js';
import { AdminError } from '../domain/admin.js';
import { IdentityError } from '../domain/identity.js';
import { TeamError } from '../domain/settings.js';
import { Conflict, SelectionError } from '../domain/selection.js';
import { TransitionError } from '../domain/transitions.js';
import { CommentError } from '../domain/comments.js';
import { PathError } from '../fs/paths.js';

const STATUS: Record<string, 400 | 403 | 404 | 409 | 413 | 415 | 422> = { not_found: 404, exists: 409, needs_confirm: 409, too_large: 413, unsupported: 415, forbidden: 403, invalid: 400 };

/** Domain errors become 4xx JSON; anything else propagates. */
export function fail(c: Context, e: unknown): Response {
  if (e instanceof Conflict) return c.json({ error: 'conflict', selectionVersion: e.selectionVersion }, 409);
  if (e instanceof PathError) return c.json({ error: 'invalid path' }, 400);
  if (e instanceof FilesError || e instanceof AdminError || e instanceof IdentityError || e instanceof TeamError || e instanceof SelectionError || e instanceof TransitionError || e instanceof CommentError) {
    return c.json({ error: e.code }, STATUS[e.code] ?? 422);
  }
  throw e;
}
