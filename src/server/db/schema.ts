import { pgTable, text, integer, boolean, jsonb, doublePrecision, bigint, serial, uniqueIndex, index, primaryKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const now = () => sql`to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const studios = pgTable('studios', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull().default(now()),
});

/** Every tenant row belongs to one Studio; defaults to the transaction's Studio (see db/tenancy.ts). */
const studioId = () => text('studio_id').notNull().default(sql`current_setting('app.studio_id')`).references(() => studios.id, { onDelete: 'cascade' });

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  studioId: studioId(),
  email: text('email').notNull().unique(), // H1: a Team member belongs to one Studio
  name: text('name').notNull().default(''),
  role: text('role', { enum: ['owner', 'member'] }).notNull(),
  notifyDownloads: text('notify_downloads', { enum: ['off', 'digest', 'each'] }).notNull().default('digest'),
  createdAt: text('created_at').notNull().default(now()),
});

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
});

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  studioId: studioId(),
  clientId: text('client_id').notNull().references(() => clients.id),
  stateVersion: integer('state_version').notNull().default(1),
  bookingState: text('booking_state').notNull().default('inquiry'),
  productionState: text('production_state').notNull().default('not_started'),
  archivedAt: text('archived_at'),
  date: text('date'),
  currentRound: integer('current_round').notNull().default(1),
  selectionVersion: integer('selection_version').notNull().default(1),
  metadataJson: jsonb('metadata_json').$type<Record<string, unknown>>().notNull(),
});

export const photos = pgTable('photos', {
  id: text('id').primaryKey(),
  studioId: studioId(),
  projectId: text('project_id').notNull().references(() => projects.id),
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
}, (t) => [uniqueIndex('photos_project_path').on(t.projectId, t.relPath)]);

export const picks = pgTable('picks', {
  studioId: studioId(),
  projectId: text('project_id').notNull().references(() => projects.id),
  photoId: text('photo_id').notNull().references(() => photos.id),
  round: integer('round').notNull(),
  byEmail: text('by_email').notNull(),
  pickedAt: text('picked_at').notNull().default(now()),
  state: text('state', { enum: ['confirmed', 'pending'] }).notNull().default('pending'),
}, (t) => [uniqueIndex('picks_project_photo').on(t.projectId, t.photoId)]);

export const slotGrants = pgTable('slot_grants', {
  id: text('id').primaryKey(),
  studioId: studioId(),
  projectId: text('project_id').notNull().references(() => projects.id),
  delta: integer('delta').notNull(),
  reason: text('reason', { enum: ['purchase', 'gift', 'refund', 'release'] }).notNull(),
  reference: text('reference'),
  actor: text('actor').notNull(),
  at: text('at').notNull().default(now()),
}, (t) => [uniqueIndex('slot_grants_reference').on(t.reference)]);

export const favorites = pgTable('favorites', {
  studioId: studioId(),
  photoId: text('photo_id').notNull().references(() => photos.id),
  sessionId: text('session_id').notNull(),
}, (t) => [uniqueIndex('favorites_one').on(t.photoId, t.sessionId)]);

export const comments = pgTable('comments', {
  id: text('id').primaryKey(),
  studioId: studioId(),
  photoId: text('photo_id').notNull().references(() => photos.id),
  author: text('author').notNull(),
  stage: text('stage', { enum: ['culling', 'final'] }).notNull(),
  x: doublePrecision('x'), y: doublePrecision('y'), w: doublePrecision('w'), h: doublePrecision('h'), t: doublePrecision('t'),
  text: text('text').notNull(),
  createdAt: text('created_at').notNull().default(now()),
  resolvedAt: text('resolved_at'),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  studioId: studioId(),
  kind: text('kind', { enum: ['client', 'admin', 'guest', 'plugin', 'mcp'] }).notNull(),
  subject: text('subject').notNull(), // email, or guest nickname
  projectId: text('project_id'),
  scope: text('scope').notNull().default('read'),
  loginTokenHash: text('login_token_hash'), // magic link, cleared on redeem
  tokenHash: text('token_hash'), // session/bearer token
  expiresAt: text('expires_at').notNull(),
  redeemedAt: text('redeemed_at'),
  nickname: text('nickname'),
  createdAt: text('created_at').notNull().default(now()),
}, (t) => [uniqueIndex('sessions_login_token').on(t.loginTokenHash), uniqueIndex('sessions_token').on(t.tokenHash)]);

export const invoices = pgTable('invoices', {
  id: text('id').primaryKey(),
  studioId: studioId(),
  projectId: text('project_id').notNull().references(() => projects.id),
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
}, (t) => [uniqueIndex('invoices_one_open_extras').on(t.projectId).where(sql`kind = 'extras' AND paid_at IS NULL AND voided_at IS NULL`)]);

export const reservations = pgTable('reservations', {
  id: text('id').primaryKey(),
  studioId: studioId(),
  projectId: text('project_id').notNull().references(() => projects.id),
  kind: text('kind', { enum: ['call', 'shoot'] }).notNull(),
  adminId: text('admin_id'),
  startsAt: text('starts_at').notNull(),
  endsAt: text('ends_at').notNull(),
  localDate: text('local_date').notNull(),
  state: text('state', { enum: ['held', 'confirmed', 'expired', 'cancelled'] }).notNull(),
  expiresAt: text('expires_at'),
}, (t) => [index('reservations_date').on(t.localDate, t.state)]);

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
}, (t) => [index('events_project').on(t.projectId, t.at)]);

export const settings = pgTable('settings', {
  studioId: studioId(),
  key: text('key').notNull(),
  value: jsonb('value').$type<unknown>().notNull(),
}, (t) => [primaryKey({ columns: [t.studioId, t.key] })]);
