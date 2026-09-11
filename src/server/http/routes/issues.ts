import { Hono } from 'hono';
import type { AppEnv } from '../session.js';
import { requireKind } from '../access.js';
import { currentIssues } from '../../fs/index.js';

export const issueRoutes = () => new Hono<AppEnv>().get('/api/issues', requireKind('admin'), (c) => c.json(currentIssues()));
