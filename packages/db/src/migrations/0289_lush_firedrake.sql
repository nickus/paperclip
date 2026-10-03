CREATE TABLE "agent_memory_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"action" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"run_id" uuid,
	"before_body" text,
	"after_body" text,
	"before_version" integer,
	"after_version" integer,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_memory_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"scope" text DEFAULT 'agent' NOT NULL,
	"agent_id" uuid,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"body" text NOT NULL,
	"project_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"source_run_id" uuid,
	"source_issue_id" uuid,
	"created_by_agent_id" uuid NOT NULL,
	"source_trust" jsonb,
	"confirmations" integer DEFAULT 1 NOT NULL,
	"confirming_run_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"access_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"tombstone_reason" text,
	"tombstoned_by_actor_type" text,
	"tombstoned_by_actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_memory_audit" ADD CONSTRAINT "agent_memory_audit_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_audit" ADD CONSTRAINT "agent_memory_audit_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_entries" ADD CONSTRAINT "agent_memory_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_entries" ADD CONSTRAINT "agent_memory_entries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_entries" ADD CONSTRAINT "agent_memory_entries_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_entries" ADD CONSTRAINT "agent_memory_entries_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory_entries" ADD CONSTRAINT "agent_memory_entries_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_memory_audit_company_entry_idx" ON "agent_memory_audit" USING btree ("company_id","entry_id");--> statement-breakpoint
CREATE INDEX "agent_memory_audit_company_created_idx" ON "agent_memory_audit" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memory_company_scope_agent_key_active_uq" ON "agent_memory_entries" USING btree ("company_id","scope","agent_id","key") WHERE "agent_memory_entries"."status" in ('active','quarantined','disputed');--> statement-breakpoint
CREATE INDEX "agent_memory_company_agent_status_idx" ON "agent_memory_entries" USING btree ("company_id","agent_id","status");--> statement-breakpoint
CREATE INDEX "agent_memory_company_agent_expires_idx" ON "agent_memory_entries" USING btree ("company_id","agent_id","expires_at");--> statement-breakpoint
CREATE INDEX "agent_memory_body_trgm_idx" ON "agent_memory_entries" USING gin ("body" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "agent_memory_source_run_idx" ON "agent_memory_entries" USING btree ("source_run_id");