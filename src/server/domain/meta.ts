import { z } from 'zod';

/** One plain path segment: no separators, no dot names. */
const FolderName = z.string().min(1).max(200).regex(/^[^/\\]+$/).refine((s) => !s.startsWith('.'), { message: 'invalid folder name' });

/** The human-editable part of a Project, stored in projects.metadata_json. Unknown keys are stripped. */
export const ProjectMeta = z.object({
  title: z.string().min(1),
  date: z.string().nullable().default(null),
  package: z.string().nullable().default(null),
  assignedTo: z.string().nullable().default(null),
  folders: z.object({ culling: FolderName, finals: FolderName }).default({ culling: 'raw', finals: 'finals' }),
  allowance: z.object({ included: z.number().int().min(0), extraPrice: z.number().int().min(0) }).default({ included: 0, extraPrice: 0 }),
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
  integrations: z.object({ docusealSubmissionId: z.string().nullable() }).default({ docusealSubmissionId: null }),
});
export type ProjectMeta = z.infer<typeof ProjectMeta>;

export function defaultProjectMeta(title: string): ProjectMeta { return ProjectMeta.parse({ title }); }
