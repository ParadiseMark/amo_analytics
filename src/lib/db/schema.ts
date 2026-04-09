import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  bigint,
  bigserial,
  numeric,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  pgEnum,
  customType,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ─── pgvector custom type ────────────────────────────────────────────────────

export const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(1536)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map(Number);
  },
});

// ─── Enums ───────────────────────────────────────────────────────────────────

export const entityTypeEnum = pgEnum("entity_type", [
  "leads",
  "contacts",
  "companies",
  "tasks",
]);

export const noteTypeEnum = pgEnum("note_type", [
  "common",
  "call_in",
  "call_out",
  "service_message",
  "message_cashier",
  "extended_service_message",
  "geolocation_message",
  "invoice_message",
  "ai_activity",
  "mail_message",
]);

export const callDirectionEnum = pgEnum("call_direction", ["inbound", "outbound"]);

export const dealEventTypeEnum = pgEnum("deal_event_type", [
  "created",
  "status_change",
  "responsible_change",
  "price_change",
  "won",
  "lost",
  "deleted",
  "restored",
  "field_change",
]);

export const platformUserRoleEnum = pgEnum("platform_user_role", [
  "admin",
  "viewer",
]);

// ─── Platform users (our own auth, separate from AmoCRM users) ───────────────

export const platformUsers = pgTable("platform_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  role: platformUserRoleEnum("role").default("viewer").notNull(),
  telegramId: varchar("telegram_id", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ─── AmoCRM Accounts (one per connected AmoCRM instance) ─────────────────────

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  subdomain: varchar("subdomain", { length: 255 }).notNull().unique(),
  amoAccountId: integer("amo_account_id"),
  name: varchar("name", { length: 255 }),
  // Encrypted tokens (AES-256-GCM, stored as iv:authTag:ciphertext hex)
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }).notNull(),
  // Account settings: plan targets, thresholds, timezone
  settings: jsonb("settings").$type<AccountSettings>().default({}).notNull(),
  syncStatus: varchar("sync_status", { length: 32 }).default("pending").notNull(),
  needsReauth: boolean("needs_reauth").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Linking platform users to AmoCRM accounts (many-to-many with role)
export const platformUserAccounts = pgTable(
  "platform_user_accounts",
  {
    platformUserId: uuid("platform_user_id")
      .notNull()
      .references(() => platformUsers.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    role: platformUserRoleEnum("role").default("viewer").notNull(),
  },
  (t) => ({
    pk: uniqueIndex("pua_pk").on(t.platformUserId, t.accountId),
  })
);

// ─── AmoCRM reference data ────────────────────────────────────────────────────

export const users = pgTable(
  "users",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    amoId: integer("amo_id").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    email: varchar("email", { length: 255 }),
    role: varchar("role", { length: 64 }),
    isActive: boolean("is_active").default(true).notNull(),
    // Telegram link for bot notifications
    telegramId: varchar("telegram_id", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    amoIdIdx: uniqueIndex("users_amo_id_account").on(t.accountId, t.amoId),
  })
);

export const pipelines = pgTable(
  "pipelines",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    amoId: integer("amo_id").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    isMain: boolean("is_main").default(false).notNull(),
    isDeleted: boolean("is_deleted").default(false).notNull(),
    sort: integer("sort").default(0).notNull(),
  },
  (t) => ({
    amoIdIdx: uniqueIndex("pipelines_amo_id_account").on(t.accountId, t.amoId),
  })
);

export const pipelineStages = pgTable(
  "pipeline_stages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    pipelineId: bigint("pipeline_id", { mode: "number" })
      .notNull()
      .references(() => pipelines.id, { onDelete: "cascade" }),
    amoId: integer("amo_id").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    sort: integer("sort").default(0).notNull(),
    // 0 = normal, 1 = won (142), 2 = lost (143)
    type: integer("type").default(0).notNull(),
    color: varchar("color", { length: 16 }),
    isDeleted: boolean("is_deleted").default(false).notNull(),
  },
  (t) => ({
    amoIdIdx: uniqueIndex("stages_amo_id_account").on(t.accountId, t.amoId),
  })
);

export const customFieldDefinitions = pgTable(
  "custom_field_definitions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    amoId: integer("amo_id").notNull(),
    entityType: entityTypeEnum("entity_type").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    fieldType: varchar("field_type", { length: 64 }).notNull(),
    // For select/multiselect: [{id, value, sort}]
    enums: jsonb("enums").$type<FieldEnum[]>(),
    sort: integer("sort").default(0).notNull(),
    isSystem: boolean("is_system").default(false).notNull(),
  },
  (t) => ({
    amoIdIdx: uniqueIndex("cfd_amo_id_account").on(t.accountId, t.amoId),
  })
);

// ─── Core CRM entities ────────────────────────────────────────────────────────

export const deals = pgTable(
  "deals",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    amoId: integer("amo_id").notNull(),
    name: varchar("name", { length: 500 }),
    price: numeric("price", { precision: 15, scale: 2 }).default("0"),
    statusId: integer("status_id"),
    pipelineAmoId: integer("pipeline_amo_id"),
    stageAmoId: integer("stage_amo_id"),
    responsibleUserAmoId: integer("responsible_user_amo_id"),
    // Full custom field values blob
    customFields: jsonb("custom_fields").$type<CustomFieldValue[]>(),
    tags: jsonb("tags").$type<string[]>(),
    isDeleted: boolean("is_deleted").default(false).notNull(),
    // 0 = open, 1 = won, 2 = lost
    closedStatus: integer("closed_status"),
    createdAt: timestamp("created_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    // First action timestamp (for response_time metric)
    firstActionAt: timestamp("first_action_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
    // pgvector embedding of deal name (for semantic search)
    embedding: vector("embedding"),
  },
  (t) => ({
    amoIdIdx: uniqueIndex("deals_amo_id_account").on(t.accountId, t.amoId),
    managerPeriodIdx: index("deals_manager_period").on(
      t.accountId,
      t.responsibleUserAmoId,
      t.createdAt
    ),
    funnelIdx: index("deals_funnel").on(
      t.accountId,
      t.pipelineAmoId,
      t.stageAmoId,
      t.closedAt
    ),
  })
);

export const contacts = pgTable(
  "contacts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    amoId: integer("amo_id").notNull(),
    name: varchar("name", { length: 500 }),
    responsibleUserAmoId: integer("responsible_user_amo_id"),
    customFields: jsonb("custom_fields").$type<CustomFieldValue[]>(),
    isDeleted: boolean("is_deleted").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    amoIdIdx: uniqueIndex("contacts_amo_id_account").on(t.accountId, t.amoId),
  })
);

export const companies = pgTable(
  "companies",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    amoId: integer("amo_id").notNull(),
    name: varchar("name", { length: 500 }),
    responsibleUserAmoId: integer("responsible_user_amo_id"),
    customFields: jsonb("custom_fields").$type<CustomFieldValue[]>(),
    isDeleted: boolean("is_deleted").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    amoIdIdx: uniqueIndex("companies_amo_id_account").on(t.accountId, t.amoId),
  })
);

export const tasks = pgTable(
  "tasks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    amoId: integer("amo_id").notNull(),
    entityType: entityTypeEnum("entity_type"),
    entityAmoId: integer("entity_amo_id"),
    responsibleUserAmoId: integer("responsible_user_amo_id"),
    taskTypeId: integer("task_type_id"),
    text: text("text"),
    completeTill: timestamp("complete_till", { withTimezone: true }),
    isCompleted: boolean("is_completed").default(false).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    isDeleted: boolean("is_deleted").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    amoIdIdx: uniqueIndex("tasks_amo_id_account").on(t.accountId, t.amoId),
    managerIdx: index("tasks_manager").on(
      t.accountId,
      t.responsibleUserAmoId,
      t.createdAt
    ),
  })
);

export const notes = pgTable(
  "notes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    amoId: integer("amo_id").notNull(),
    entityType: entityTypeEnum("entity_type"),
    entityAmoId: integer("entity_amo_id"),
    responsibleUserAmoId: integer("responsible_user_amo_id"),
    noteType: noteTypeEnum("note_type"),
    // Varies by note type: {text}, {phone, duration}, etc.
    content: jsonb("content"),
    // Extracted plain text for pgvector embeddings
    textContent: text("text_content"),
    // pgvector embedding of text_content
    embedding: vector("embedding"),
    isDeleted: boolean("is_deleted").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    amoIdIdx: uniqueIndex("notes_amo_id_account").on(t.accountId, t.amoId),
    entityIdx: index("notes_entity").on(t.accountId, t.entityType, t.entityAmoId),
  })
);

export const calls = pgTable(
  "calls",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    amoId: integer("amo_id").notNull(),
    direction: callDirectionEnum("direction"),
    durationSeconds: integer("duration_seconds"),
    callStatus: integer("call_status"),
    phone: varchar("phone", { length: 64 }),
    responsibleUserAmoId: integer("responsible_user_amo_id"),
    entityAmoId: integer("entity_amo_id"),
    entityType: entityTypeEnum("entity_type"),
    recordingUrl: text("recording_url"),
    createdAt: timestamp("created_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    amoIdIdx: uniqueIndex("calls_amo_id_account").on(t.accountId, t.amoId),
    managerIdx: index("calls_manager").on(
      t.accountId,
      t.responsibleUserAmoId,
      t.createdAt
    ),
  })
);

// ─── Deal event log (every change) ───────────────────────────────────────────

export const dealEvents = pgTable(
  "deal_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    dealAmoId: integer("deal_amo_id").notNull(),
    eventType: dealEventTypeEnum("event_type").notNull(),
    fromValue: text("from_value"),
    toValue: text("to_value"),
    userAmoId: integer("user_amo_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    dealIdx: index("deal_events_deal").on(t.accountId, t.dealAmoId, t.occurredAt),
    accountTimeIdx: index("deal_events_account_time").on(t.accountId, t.occurredAt),
  })
);

// ─── Sync state ───────────────────────────────────────────────────────────────

export const syncCursors = pgTable(
  "sync_cursors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    entityType: varchar("entity_type", { length: 64 }).notNull(),
    // Unix timestamp used as AmoCRM filter cursor
    lastAmoUpdatedAt: integer("last_amo_updated_at"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    totalSynced: integer("total_synced").default(0).notNull(),
    status: varchar("status", { length: 32 }).default("idle").notNull(),
  },
  (t) => ({
    accountEntityIdx: uniqueIndex("sync_cursors_account_entity").on(
      t.accountId,
      t.entityType
    ),
  })
);

// ─── Report definitions (custom report builder) ───────────────────────────────

export const reportDefinitions = pgTable("report_definitions", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  createdByPlatformUserId: uuid("created_by_platform_user_id").references(
    () => platformUsers.id,
    { onDelete: "set null" }
  ),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  // Full report DSL: { data_source, filters, group_by, metrics, chart, schedule }
  config: jsonb("config").$type<ReportConfig>().notNull(),
  isShared: boolean("is_shared").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const reportSnapshots = pgTable("report_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  reportId: uuid("report_id")
    .notNull()
    .references(() => reportDefinitions.id, { onDelete: "cascade" }),
  generatedAt: timestamp("generated_at", { withTimezone: true }).defaultNow().notNull(),
  data: jsonb("data").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

// ─── Bottleneck alerts ────────────────────────────────────────────────────────

export const bottleneckAlerts = pgTable(
  "bottleneck_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    alertType: varchar("alert_type", { length: 64 }).notNull(),
    // e.g. 'stage_bottleneck', 'low_win_rate', 'stuck_deals', 'manager_below_avg'
    entityType: varchar("entity_type", { length: 32 }),
    entityAmoId: integer("entity_amo_id"),
    severity: varchar("severity", { length: 16 }).default("warning").notNull(),
    data: jsonb("data"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    accountIdx: index("alerts_account").on(t.accountId, t.createdAt),
  })
);

// ─── Relations ────────────────────────────────────────────────────────────────

export const accountsRelations = relations(accounts, ({ many }) => ({
  users: many(users),
  pipelines: many(pipelines),
  deals: many(deals),
  syncCursors: many(syncCursors),
  platformUserAccounts: many(platformUserAccounts),
}));

export const pipelinesRelations = relations(pipelines, ({ one, many }) => ({
  account: one(accounts, { fields: [pipelines.accountId], references: [accounts.id] }),
  stages: many(pipelineStages),
}));

export const dealsRelations = relations(deals, ({ one }) => ({
  account: one(accounts, { fields: [deals.accountId], references: [accounts.id] }),
}));

// ─── TypeScript types for JSONB columns ──────────────────────────────────────

export type AccountSettings = {
  timezone?: string;
  currency?: string;
  planTargets?: Record<string, number>; // { [userAmoId]: monthlyRevenuePlan }
  stuckDaysThreshold?: number; // default: 2x average
  bottleneckMultiplier?: number; // default: 1.5x average
};

export type CustomFieldValue = {
  field_id: number;
  field_name?: string;
  field_type?: string;
  values: Array<{
    value?: string | number | boolean;
    enum_id?: number;
    enum_value?: string;
  }>;
};

export type FieldEnum = {
  id: number;
  value: string;
  sort: number;
};

export type ReportConfig = {
  dataSource: string;
  filters?: Array<{ field: string; op: string; value: unknown }>;
  groupBy?: string[];
  metrics?: Array<{ field: string; agg: string; label?: string }>;
  sort?: Array<{ field: string; dir: "asc" | "desc" }>;
  chart?: { type: string; xAxis?: string; yAxis?: string };
  schedule?: { cron?: string; recipients?: string[] };
};
