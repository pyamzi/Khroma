import { z } from 'zod';
import { newId } from './ids.js';

export const ClientJson = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid().optional(),
  stateVersion: z.number().int().default(1),
  name: z.string().min(1),
  emails: z.array(z.string().email()).default([]),
  phone: z.string().default(''),
  stripeCustomerId: z.string().nullable().default(null),
  listmonkSubscriberId: z.number().nullable().default(null),
  referralCode: z.string().nullable().default(null),
  notes: z.string().default(''),
});
export type ClientJson = z.infer<typeof ClientJson>;

export const ProjectJson = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid().optional(),
  stateVersion: z.number().int().default(1),
  title: z.string().min(1),
  state: z.object({ booking: z.string(), production: z.string(), archivedAt: z.string().nullable() })
    .default({ booking: 'inquiry', production: 'not_started', archivedAt: null }),
  date: z.string().nullable().default(null),
  package: z.string().nullable().default(null),
  assignedTo: z.string().nullable().default(null),
  folders: z.object({ culling: z.string(), finals: z.string() }).default({ culling: 'raw', finals: 'finals' }),
  allowance: z.object({ included: z.number().int().min(0), extraPrice: z.number().int().min(0), slots: z.number().int().min(0) })
    .default({ included: 0, extraPrice: 0, slots: 0 }),
  downloads: z.enum(['client', 'password', 'none']).default('client'),
  comments: z.object({ culling: z.boolean(), finals: z.boolean() }).default({ culling: true, finals: true }),
  notifyOnPublish: z.boolean().default(false),
  sharePassword: z.string().nullable().default(null),
  music: z.string().nullable().default(null),
  cover: z.string().nullable().default(null),
  expiresAt: z.string().nullable().default(null),
  offers: z.record(z.boolean()).default({}),
  portfolioRelease: z.boolean().default(false),
  showOffers: z.boolean().default(true),
  sharedFiles: z.array(z.string()).default([]),
  integrations: z.object({ docusealSubmissionId: z.string().nullable() }).default({ docusealSubmissionId: null }),
});
export type ProjectJson = z.infer<typeof ProjectJson>;

/** Projections of SQLite. External edits to these are restored, never applied. */
export const MACHINE_FIELDS = ['id', 'schemaVersion', 'stateVersion', 'state', 'allowance', 'sharePassword', 'integrations'] as const satisfies readonly (keyof ProjectJson)[];

export function defaultClientJson(name: string): ClientJson { return ClientJson.parse({ schemaVersion: 1, id: newId(), name }); }
export function defaultProjectJson(title: string): ProjectJson { return ProjectJson.parse({ schemaVersion: 1, id: newId(), title }); }

export function splitFields(p: ProjectJson): { human: Partial<ProjectJson>; machine: Partial<ProjectJson> } {
  const human: Record<string, unknown> = {}; const machine: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) ((MACHINE_FIELDS as readonly string[]).includes(k) ? machine : human)[k] = v;
  return { human: human as Partial<ProjectJson>, machine: machine as Partial<ProjectJson> };
}
