import { pgTable, text, integer, boolean, timestamp, jsonb, doublePrecision, bigint, serial, uniqueIndex, index, primaryKey, unique, foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const now = () => sql`to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const studios = pgTable('studios', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  confirmedAt: text('confirmed_at'), // first owner sign-in; unconfirmed Studios are swept (auth/signup.ts)
  createdAt: text('created_at').notNull().default(now()),
});

/**
 * Every tenant row belongs to one Studio; defaults to the transaction's Studio (see db/tenancy.ts). Rows reference their
 * parents through (studio_id, id) so a row can never point into another Studio, and every table has an index led by studio_id.
 */
const studioId = () => text('studio_id').notNull().default(sql`current_setting('app.studio_id')`).references(() => studios.id, { onDelete: 'cascade' });

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  studioId: studioId(),
  email: text('email').notNull().unique(), // H1: a Team member belongs to one Studio
  name: text('name').notNull().default(''),
  role: text('role', { enum: ['owner', 'member'] }).notNull(),
  notifyDownloads: text('notify_downloads', { enum: ['off', 'digest', 'each'] }).notNull().default('digest'),
  createdAt: text('created_at').notNull().default(now()),
}, (t) => [index('users_studio').on(t.studioId)]);

export const clients = pgTable('clients', {
  id: text('id').primaryKey(),
  studioId: studioId(),
  stateVersion: integer('state_version').notNull().default(1),
  name: text('name').notNull(),
  emails: jsonb('emails').$type<string[]>().notNull(), // lowercase
  phone: text('phone').notNull().default(''),
  notes: text('notes').notNull().default(''),
  stripeCustomerId: text('stripe_customer_id'),
  referralCode: text('referral_code'),
}, (t) => [unique('clients_studio_id').on(t.studioId, t.id)]);

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  studioId: studioId(),
  clientId: text('client_id').notNull(),
  stateVersion: integer('state_version').notNull().default(1),
  bookingState: text('booking_state').notNull().default('inquiry'),
  productionState: text('production_state').notNull().default('not_started'),
  archivedAt: text('archived_at'),
  date: text('date'),
  currentRound: integer('current_round').notNull().default(1),
  selectionVersion: integer('selection_version').notNull().default(1),
  metadataJson: jsonb('metadata_json').$type<Record<string, unknown>>().notNull(),
}, (t) => [unique('projects_studio_id').on(t.studioId, t.id), foreignKey({ columns: [t.studioId, t.clientId], foreignColumns: [clients.studioId, clients.id] })]);

export const photos = pgTable('photos', {
  id: text('id').primaryKey(),
  studioId: studioId(),
  projectId: text('project_id'), // null for a Library photo that belongs to no project; the composite FK is skipped then (MATCH SIMPLE)
  relPath: text('rel_path').notNull(), // logical path within the project, e.g. raw/a.dng, finals/a.jpg
  draftRelPath: text('draft_rel_path'),
  live: boolean('live').notNull().default(true), // the live object exists and is what clients see
  stage: text('stage', { enum: ['culling', 'final'] }).notNull(),
  kind: text('kind', { enum: ['photo', 'video'] }).notNull(),
  sourcePhotoId: text('source_photo_id'),
  checksum: text('checksum').notNull(),
  width: integer('width'),
  height: integer('height'),
  capturedAt: text('captured_at'),
  sortOrder: integer('sort_order').notNull().default(0),
  section: text('section'),
  editState: text('edit_state', { enum: ['none', 'editing', 'done'] }).notNull().default('none'),
  inLibrary: boolean('in_library').notNull().default(true),
  status: text('status', { enum: ['uploading', 'processing', 'ready', 'failed'] }).notNull().default('ready'),
  keywords: jsonb('keywords').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  caption: text('caption'),
  createdAt: text('created_at').notNull().default(now()),
  readyAt: text('ready_at'),
  purgedAt: text('purged_at'),
}, (t) => [index('photos_studio_library').on(t.studioId, t.inLibrary, t.createdAt), uniqueIndex('photos_project_path').on(t.projectId, t.relPath), unique('photos_studio_id').on(t.studioId, t.id), foreignKey({ columns: [t.studioId, t.projectId], foreignColumns: [projects.studioId, projects.id] })]);

export const picks = pgTable('picks', {
  studioId: studioId(),
  projectId: text('project_id').notNull(),
  photoId: text('photo_id').notNull(),
  round: integer('round').notNull(),
  byEmail: text('by_email').notNull(),
  pickedAt: text('picked_at').notNull().default(now()),
  state: text('state', { enum: ['confirmed', 'pending'] }).notNull().default('pending'),
}, (t) => [uniqueIndex('picks_project_photo').on(t.projectId, t.photoId), index('picks_studio').on(t.studioId), foreignKey({ columns: [t.studioId, t.projectId], foreignColumns: [projects.studioId, projects.id] }), foreignKey({ columns: [t.studioId, t.photoId], foreignColumns: [photos.studioId, photos.id] })]);

export const slotGrants = pgTable('slot_grants', {
  id: text('id').primaryKey(),
  studioId: studioId(),
  projectId: text('project_id').notNull(),
  delta: integer('delta').notNull(),
  reason: text('reason', { enum: ['purchase', 'gift', 'refund', 'release'] }).notNull(),
  reference: text('reference'),
  actor: text('actor').notNull(),
  at: text('at').notNull().default(now()),
}, (t) => [uniqueIndex('slot_grants_reference').on(t.studioId, t.reference), foreignKey({ columns: [t.studioId, t.projectId], foreignColumns: [projects.studioId, projects.id] })]);

export const favorites = pgTable('favorites', {
  studioId: studioId(),
  photoId: text('photo_id').notNull(),
  sessionId: text('session_id').notNull(),
}, (t) => [uniqueIndex('favorites_one').on(t.photoId, t.sessionId), index('favorites_studio').on(t.studioId), foreignKey({ columns: [t.studioId, t.photoId], foreignColumns: [photos.studioId, photos.id] })]);

export const comments = pgTable('comments', {
  id: text('id').primaryKey(),
  studioId: studioId(),
  photoId: text('photo_id').notNull(),
  author: text('author').notNull(),
  stage: text('stage', { enum: ['culling', 'final'] }).notNull(),
  x: doublePrecision('x'), y: doublePrecision('y'), w: doublePrecision('w'), h: doublePrecision('h'), t: doublePrecision('t'),
  text: text('text').notNull(),
  createdAt: text('created_at').notNull().default(now()),
  resolvedAt: text('resolved_at'),
}, (t) => [index('comments_studio').on(t.studioId), foreignKey({ columns: [t.studioId, t.photoId], foreignColumns: [photos.studioId, photos.id] })]);

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  studioId: studioId(),
  kind: text('kind', { enum: ['client', 'admin', 'guest', 'plugin', 'mcp'] }).notNull(),
  subject: text('subject').notNull(), // token creator's email, or guest nickname
  projectId: text('project_id'),
  scope: text('scope').notNull().default('read'),
  tokenHash: text('token_hash'), // bearer token
  expiresAt: text('expires_at').notNull(),
  nickname: text('nickname'),
  createdAt: text('created_at').notNull().default(now()),
}, (t) => [uniqueIndex('sessions_token').on(t.tokenHash), index('sessions_studio').on(t.studioId)]);

export const invoices = pgTable('invoices', {
  id: text('id').primaryKey(),
  studioId: studioId(),
  projectId: text('project_id').notNull(),
  kind: text('kind', { enum: ['deposit', 'balance', 'final', 'extras', 'package', 'adjustment'] }).notNull(),
  amount: integer('amount').notNull(),
  tax: integer('tax').notNull().default(0),
  currency: text('currency').notNull(),
  stripeId: text('stripe_id'),
  paidAmount: integer('paid_amount').notNull().default(0),
  paidAt: text('paid_at'),
  paidVia: text('paid_via', { enum: ['stripe', 'manual'] }),
  refundedAmount: integer('refunded_amount').notNull().default(0),
  needsReview: boolean('needs_review').notNull().default(false),
  voidedAt: text('voided_at'),
  createdAt: text('created_at').notNull().default(now()),
}, (t) => [uniqueIndex('invoices_one_open_extras').on(t.projectId).where(sql`kind = 'extras' AND paid_at IS NULL AND voided_at IS NULL`), index('invoices_studio').on(t.studioId), foreignKey({ columns: [t.studioId, t.projectId], foreignColumns: [projects.studioId, projects.id] })]);

export const reservations = pgTable('reservations', {
  id: text('id').primaryKey(),
  studioId: studioId(),
  projectId: text('project_id').notNull(),
  kind: text('kind', { enum: ['call', 'shoot'] }).notNull(),
  adminId: text('admin_id'),
  startsAt: text('starts_at').notNull(),
  endsAt: text('ends_at').notNull(),
  localDate: text('local_date').notNull(),
  state: text('state', { enum: ['held', 'confirmed', 'expired', 'cancelled'] }).notNull(),
  expiresAt: text('expires_at'),
}, (t) => [index('reservations_date').on(t.localDate, t.state), index('reservations_studio').on(t.studioId), foreignKey({ columns: [t.studioId, t.projectId], foreignColumns: [projects.studioId, projects.id] })]);

/** Provider webhooks arrive before we know the Studio; not tenant-scoped. */
export const webhookInbox = pgTable('webhook_inbox', {
  provider: text('provider').notNull(),
  eventId: text('event_id').notNull(),
  objectId: text('object_id'),
  payload: jsonb('payload').$type<unknown>().notNull(),
  state: text('state', { enum: ['received', 'applied'] }).notNull().default('received'),
  receivedAt: text('received_at').notNull().default(now()),
}, (t) => [uniqueIndex('inbox_provider_event').on(t.provider, t.eventId)]);

export const jobs = pgTable('jobs', {
  id: text('id').primaryKey(),
  studioId: studioId(),
  kind: text('kind').notNull(),
  payload: jsonb('payload').$type<unknown>().notNull(),
  idempotencyKey: text('idempotency_key'),
  attempts: integer('attempts').notNull().default(0),
  nextAt: bigint('next_at', { mode: 'number' }).notNull(), // epoch ms
  leasedUntil: bigint('leased_until', { mode: 'number' }),
  state: text('state', { enum: ['pending', 'running', 'done', 'failed', 'needs_review'] }).notNull().default('pending'),
  lastError: text('last_error'),
  createdAt: text('created_at').notNull().default(now()),
}, (t) => [uniqueIndex('jobs_idempotency').on(t.studioId, t.idempotencyKey), index('jobs_due').on(t.state, t.nextAt)]);

export const events = pgTable('events', {
  id: serial('id').primaryKey(),
  studioId: studioId(),
  projectId: text('project_id'),
  actor: text('actor').notNull(),
  type: text('type').notNull(),
  payload: jsonb('payload').$type<unknown>().notNull().default({}),
  at: text('at').notNull().default(now()),
}, (t) => [index('events_project').on(t.projectId, t.at), index('events_studio').on(t.studioId)]);

export const settings = pgTable('settings', {
  studioId: studioId(),
  key: text('key').notNull(),
  value: jsonb('value').$type<unknown>().notNull(),
}, (t) => [primaryKey({ columns: [t.studioId, t.key] })]);

/**
 * Better Auth's core tables (columns from `npx auth generate`, better-auth 1.7.x). Not tenant tables: no RLS, and 0002_auth.sql
 * revokes them from og_app and og_system, so only the table-owner connection (the auth handler) can read them. checkTenancy enforces that.
 */
export const authUsers = pgTable('auth_users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().$onUpdate(() => new Date()).notNull(),
});

export const authSessions = pgTable('auth_sessions', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').$onUpdate(() => new Date()).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  studioId: text('studio_id').references(() => studios.id, { onDelete: 'cascade' }), // nullable and not RLS-scoped on purpose: see above
  kind: text('kind', { enum: ['admin', 'client'] }),
}, (t) => [index('auth_sessions_user_id_idx').on(t.userId)]);

export const authAccounts = pgTable('auth_accounts', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').$onUpdate(() => new Date()).notNull(),
}, (t) => [index('auth_accounts_user_id_idx').on(t.userId)]);

export const authVerifications = pgTable('auth_verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().$onUpdate(() => new Date()).notNull(),
}, (t) => [index('auth_verifications_identifier_idx').on(t.identifier)]);
