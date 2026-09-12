import { sqliteTable, text, integer, real, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

const now = () => sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull().default(''),
  role: text('role', { enum: ['owner', 'member'] }).notNull(),
  notifyDownloads: text('notify_downloads', { enum: ['off', 'digest', 'each'] }).notNull().default('digest'),
  createdAt: text('created_at').notNull().default(now()),
});

export const clients = sqliteTable('clients', {
  id: text('id').primaryKey(),
  folderPath: text('folder_path').notNull(), // relative to PHOTOS_DIR
  available: integer('available', { mode: 'boolean' }).notNull().default(true),
  stateVersion: integer('state_version').notNull().default(1),
  name: text('name').notNull(),
  emails: text('emails', { mode: 'json' }).$type<string[]>().notNull(),
  stripeCustomerId: text('stripe_customer_id'),
  listmonkSubscriberId: integer('listmonk_subscriber_id'),
  referralCode: text('referral_code'),
}, (t) => ({ folderIdx: uniqueIndex('clients_folder').on(t.folderPath) }));

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  clientId: text('client_id').notNull().references(() => clients.id),
  folderPath: text('folder_path').notNull(),
  available: integer('available', { mode: 'boolean' }).notNull().default(true),
  transferPending: integer('transfer_pending', { mode: 'boolean' }).notNull().default(false),
  stateVersion: integer('state_version').notNull().default(1),
  bookingState: text('booking_state').notNull().default('inquiry'),
  productionState: text('production_state').notNull().default('not_started'),
  archivedAt: text('archived_at'),
  date: text('date'),
  currentRound: integer('current_round').notNull().default(1),
  lastIndexedAt: text('last_indexed_at'),
  metadataJson: text('metadata_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
}, (t) => ({ folderIdx: uniqueIndex('projects_folder').on(t.folderPath) }));

export const photos = sqliteTable('photos', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  relPath: text('rel_path').notNull(), // relative to project folder
  draftRelPath: text('draft_rel_path'),
  live: integer('live', { mode: 'boolean' }).notNull().default(true), // the file at rel_path exists and is what clients see
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
  missing: integer('missing', { mode: 'boolean' }).notNull().default(false),
}, (t) => ({ pathIdx: uniqueIndex('photos_project_path').on(t.projectId, t.relPath) }));

export const picks = sqliteTable('picks', {
  projectId: text('project_id').notNull().references(() => projects.id),
  photoId: text('photo_id').notNull().references(() => photos.id),
  round: integer('round').notNull(),
  byEmail: text('by_email').notNull(),
  pickedAt: text('picked_at').notNull().default(now()),
  state: text('state', { enum: ['confirmed', 'pending'] }).notNull().default('pending'),
}, (t) => ({ one: uniqueIndex('picks_project_photo').on(t.projectId, t.photoId) }));

export const slotGrants = sqliteTable('slot_grants', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  delta: integer('delta').notNull(),
  reason: text('reason', { enum: ['purchase', 'gift', 'refund', 'release'] }).notNull(),
  reference: text('reference'),
  actor: text('actor').notNull(),
  at: text('at').notNull().default(now()),
}, (t) => ({ ref: uniqueIndex('slot_grants_reference').on(t.reference) }));

export const favorites = sqliteTable('favorites', {
  photoId: text('photo_id').notNull().references(() => photos.id),
  sessionId: text('session_id').notNull(),
}, (t) => ({ one: uniqueIndex('favorites_one').on(t.photoId, t.sessionId) }));

export const comments = sqliteTable('comments', {
  id: text('id').primaryKey(),
  photoId: text('photo_id').notNull().references(() => photos.id),
  author: text('author').notNull(),
  stage: text('stage', { enum: ['culling', 'final'] }).notNull(),
  x: real('x'), y: real('y'), w: real('w'), h: real('h'), t: real('t'),
  text: text('text').notNull(),
  createdAt: text('created_at').notNull().default(now()),
  resolvedAt: text('resolved_at'),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
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
}, (t) => ({ login: uniqueIndex('sessions_login_token').on(t.loginTokenHash), tok: uniqueIndex('sessions_token').on(t.tokenHash) }));

export const invoices = sqliteTable('invoices', {
  id: text('id').primaryKey(),
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
  needsReview: integer('needs_review', { mode: 'boolean' }).notNull().default(false),
  voidedAt: text('voided_at'),
  createdAt: text('created_at').notNull().default(now()),
}, (t) => ({
  oneOpenExtras: uniqueIndex('invoices_one_open_extras').on(t.projectId).where(sql`kind = 'extras' AND paid_at IS NULL AND voided_at IS NULL`),
}));

export const reservations = sqliteTable('reservations', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  kind: text('kind', { enum: ['call', 'shoot'] }).notNull(),
  adminId: text('admin_id'),
  startsAt: text('starts_at').notNull(),
  endsAt: text('ends_at').notNull(),
  localDate: text('local_date').notNull(),
  state: text('state', { enum: ['held', 'confirmed', 'expired', 'cancelled'] }).notNull(),
  expiresAt: text('expires_at'),
}, (t) => ({ byDate: index('reservations_date').on(t.localDate, t.state) }));

export const webhookInbox = sqliteTable('webhook_inbox', {
  provider: text('provider').notNull(),
  eventId: text('event_id').notNull(),
  objectId: text('object_id'),
  payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
  state: text('state', { enum: ['received', 'applied'] }).notNull().default('received'),
  receivedAt: text('received_at').notNull().default(now()),
}, (t) => ({ one: uniqueIndex('inbox_provider_event').on(t.provider, t.eventId) }));

export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
  idempotencyKey: text('idempotency_key'),
  attempts: integer('attempts').notNull().default(0),
  nextAt: integer('next_at').notNull(), // epoch ms
  leasedUntil: integer('leased_until'),
  state: text('state', { enum: ['pending', 'running', 'done', 'failed', 'needs_review'] }).notNull().default('pending'),
  lastError: text('last_error'),
  createdAt: text('created_at').notNull().default(now()),
}, (t) => ({ key: uniqueIndex('jobs_idempotency').on(t.idempotencyKey), due: index('jobs_due').on(t.state, t.nextAt) }));

export const events = sqliteTable('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: text('project_id'),
  actor: text('actor').notNull(),
  type: text('type').notNull(),
  payload: text('payload', { mode: 'json' }).$type<unknown>().notNull().default({}),
  at: text('at').notNull().default(now()),
}, (t) => ({ byProject: index('events_project').on(t.projectId, t.at) }));

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
});
