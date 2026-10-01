import { createHash, randomBytes } from 'node:crypto';

// Bearer tokens (plugin, later guest/mcp) are stored as hashes only. People sign in through Better Auth.
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
