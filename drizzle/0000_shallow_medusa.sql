-- Enable pgvector extension (already available in Supabase)
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."call_direction" AS ENUM('inbound', 'outbound');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."deal_event_type" AS ENUM('created', 'status_change', 'responsible_change', 'price_change', 'won', 'lost', 'deleted', 'restored', 'field_change');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."entity_type" AS ENUM('leads', 'contacts', 'companies', 'tasks');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."note_type" AS ENUM('common', 'call_in', 'call_out', 'service_message', 'message_cashier', 'extended_service_message', 'geolocation_message', 'invoice_message', 'ai_activity', 'mail_message');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."platform_user_role" AS ENUM('admin', 'viewer');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subdomain" varchar(255) NOT NULL,
	"amo_account_id" integer,
	"name" varchar(255),
	"access_token" text NOT NULL,
	"refresh_token" text NOT NULL,
	"token_expires_at" timestamp with time zone NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sync_status" varchar(32) DEFAULT 'pending' NOT NULL,
	"needs_reauth" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_subdomain_unique" UNIQUE("subdomain")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bottleneck_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"alert_type" varchar(64) NOT NULL,
	"entity_type" varchar(32),
	"entity_amo_id" integer,
	"severity" varchar(16) DEFAULT 'warning' NOT NULL,
	"data" jsonb,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calls" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"amo_id" integer NOT NULL,
	"direction" "call_direction",
	"duration_seconds" integer,
	"call_status" integer,
	"phone" varchar(64),
	"responsible_user_amo_id" integer,
	"entity_amo_id" integer,
	"entity_type" "entity_type",
	"recording_url" text,
	"created_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "companies" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"amo_id" integer NOT NULL,
	"name" varchar(500),
	"responsible_user_amo_id" integer,
	"custom_fields" jsonb,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contacts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"amo_id" integer NOT NULL,
	"name" varchar(500),
	"responsible_user_amo_id" integer,
	"custom_fields" jsonb,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "custom_field_definitions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"amo_id" integer NOT NULL,
	"entity_type" "entity_type" NOT NULL,
	"name" varchar(255) NOT NULL,
	"field_type" varchar(64) NOT NULL,
	"enums" jsonb,
	"sort" integer DEFAULT 0 NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deal_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"deal_amo_id" integer NOT NULL,
	"event_type" "deal_event_type" NOT NULL,
	"from_value" text,
	"to_value" text,
	"user_amo_id" integer,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"amo_id" integer NOT NULL,
	"name" varchar(500),
	"price" numeric(15, 2) DEFAULT '0',
	"status_id" integer,
	"pipeline_amo_id" integer,
	"stage_amo_id" integer,
	"responsible_user_amo_id" integer,
	"custom_fields" jsonb,
	"tags" jsonb,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"closed_status" integer,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"first_action_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"embedding" vector(1536)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"amo_id" integer NOT NULL,
	"entity_type" "entity_type",
	"entity_amo_id" integer,
	"responsible_user_amo_id" integer,
	"note_type" "note_type",
	"content" jsonb,
	"text_content" text,
	"embedding" vector(1536),
	"is_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pipeline_stages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"pipeline_id" bigint NOT NULL,
	"amo_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"type" integer DEFAULT 0 NOT NULL,
	"color" varchar(16),
	"is_deleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pipelines" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"amo_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"is_main" boolean DEFAULT false NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_user_accounts" (
	"platform_user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"role" "platform_user_role" DEFAULT 'viewer' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" text NOT NULL,
	"name" varchar(255) NOT NULL,
	"role" "platform_user_role" DEFAULT 'viewer' NOT NULL,
	"telegram_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "report_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"created_by_platform_user_id" uuid,
	"name" varchar(255) NOT NULL,
	"description" text,
	"config" jsonb NOT NULL,
	"is_shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "report_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"data" jsonb NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_cursors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"entity_type" varchar(64) NOT NULL,
	"last_amo_updated_at" integer,
	"last_synced_at" timestamp with time zone,
	"total_synced" integer DEFAULT 0 NOT NULL,
	"status" varchar(32) DEFAULT 'idle' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tasks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"amo_id" integer NOT NULL,
	"entity_type" "entity_type",
	"entity_amo_id" integer,
	"responsible_user_amo_id" integer,
	"task_type_id" integer,
	"text" text,
	"complete_till" timestamp with time zone,
	"is_completed" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"amo_id" integer NOT NULL,
	"name" varchar(255) NOT NULL,
	"email" varchar(255),
	"role" varchar(64),
	"is_active" boolean DEFAULT true NOT NULL,
	"telegram_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bottleneck_alerts" ADD CONSTRAINT "bottleneck_alerts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calls" ADD CONSTRAINT "calls_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "companies" ADD CONSTRAINT "companies_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contacts" ADD CONSTRAINT "contacts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deal_events" ADD CONSTRAINT "deal_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deals" ADD CONSTRAINT "deals_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notes" ADD CONSTRAINT "notes_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "platform_user_accounts" ADD CONSTRAINT "platform_user_accounts_platform_user_id_platform_users_id_fk" FOREIGN KEY ("platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "platform_user_accounts" ADD CONSTRAINT "platform_user_accounts_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "report_definitions" ADD CONSTRAINT "report_definitions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "report_definitions" ADD CONSTRAINT "report_definitions_created_by_platform_user_id_platform_users_id_fk" FOREIGN KEY ("created_by_platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "report_snapshots" ADD CONSTRAINT "report_snapshots_report_id_report_definitions_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."report_definitions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alerts_account" ON "bottleneck_alerts" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "calls_amo_id_account" ON "calls" USING btree ("account_id","amo_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "calls_manager" ON "calls" USING btree ("account_id","responsible_user_amo_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "companies_amo_id_account" ON "companies" USING btree ("account_id","amo_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contacts_amo_id_account" ON "contacts" USING btree ("account_id","amo_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cfd_amo_id_account" ON "custom_field_definitions" USING btree ("account_id","amo_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deal_events_deal" ON "deal_events" USING btree ("account_id","deal_amo_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deal_events_account_time" ON "deal_events" USING btree ("account_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "deals_amo_id_account" ON "deals" USING btree ("account_id","amo_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deals_manager_period" ON "deals" USING btree ("account_id","responsible_user_amo_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deals_funnel" ON "deals" USING btree ("account_id","pipeline_amo_id","stage_amo_id","closed_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notes_amo_id_account" ON "notes" USING btree ("account_id","amo_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notes_entity" ON "notes" USING btree ("account_id","entity_type","entity_amo_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stages_amo_id_account" ON "pipeline_stages" USING btree ("account_id","amo_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pipelines_amo_id_account" ON "pipelines" USING btree ("account_id","amo_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pua_pk" ON "platform_user_accounts" USING btree ("platform_user_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sync_cursors_account_entity" ON "sync_cursors" USING btree ("account_id","entity_type");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_amo_id_account" ON "tasks" USING btree ("account_id","amo_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_manager" ON "tasks" USING btree ("account_id","responsible_user_amo_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_amo_id_account" ON "users" USING btree ("account_id","amo_id");