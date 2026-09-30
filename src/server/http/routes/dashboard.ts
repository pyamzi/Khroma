import { Hono } from 'hono';
import type { AppEnv } from '../session.js';
import { requireKind } from '../access.js';
import { dashboard } from '../../domain/dashboard.js';
export const dashboardRoutes = () => new Hono<AppEnv>().get('/api/dashboard', requireKind('admin'), async (c) => c.json(await dashboard(c.get('db'))));
