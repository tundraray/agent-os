CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "app"."agent_knowledge_embedding" (
	"record_id" uuid PRIMARY KEY NOT NULL,
	"pass_task_id" uuid,
	"needs_pass" boolean DEFAULT false NOT NULL,
	"payer_id" text,
	"last_reason" text,
	"last_model" text,
	"last_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."agent_knowledge_entities" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "app"."agent_knowledge_entities_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"record_id" uuid NOT NULL,
	"confirmations" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_run_id" uuid NOT NULL,
	"confirmed_by_run_id" uuid NOT NULL,
	"outdated" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	CONSTRAINT "agent_knowledge_entities_confirmations_check" CHECK ("app"."agent_knowledge_entities"."confirmations" >= 1)
);
--> statement-breakpoint
CREATE TABLE "app"."agent_knowledge_questions" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"model" text,
	"vector" real[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."agent_knowledge_relations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "app"."agent_knowledge_relations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"record_id" uuid NOT NULL,
	"confirmations" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_run_id" uuid NOT NULL,
	"confirmed_by_run_id" uuid NOT NULL,
	"outdated" boolean DEFAULT false NOT NULL,
	"kind" text NOT NULL,
	"from_entity_id" integer,
	"to_entity_id" integer,
	"label" text,
	"server" text,
	"tool" text,
	"question" text,
	"hint" text,
	"outcome" text,
	CONSTRAINT "agent_knowledge_relations_confirmations_check" CHECK ("app"."agent_knowledge_relations"."confirmations" >= 1),
	CONSTRAINT "agent_knowledge_relations_kind_check" CHECK ("app"."agent_knowledge_relations"."kind" in ('fact', 'lesson', 'searched_nothing')),
	CONSTRAINT "agent_knowledge_relations_shape_check" CHECK (("app"."agent_knowledge_relations"."kind" = 'fact'
          and "app"."agent_knowledge_relations"."from_entity_id" is not null and "app"."agent_knowledge_relations"."to_entity_id" is not null
          and "app"."agent_knowledge_relations"."label" is not null and "app"."agent_knowledge_relations"."server" is null and "app"."agent_knowledge_relations"."tool" is null
          and "app"."agent_knowledge_relations"."question" is null and "app"."agent_knowledge_relations"."hint" is null and "app"."agent_knowledge_relations"."outcome" is null)
        or ("app"."agent_knowledge_relations"."kind" = 'lesson'
          and "app"."agent_knowledge_relations"."from_entity_id" is null and "app"."agent_knowledge_relations"."to_entity_id" is null and "app"."agent_knowledge_relations"."label" is null
          and "app"."agent_knowledge_relations"."server" is not null and "app"."agent_knowledge_relations"."tool" is not null and "app"."agent_knowledge_relations"."question" is not null
          and "app"."agent_knowledge_relations"."hint" is not null and "app"."agent_knowledge_relations"."outcome" is not null)
        or ("app"."agent_knowledge_relations"."kind" = 'searched_nothing'
          and "app"."agent_knowledge_relations"."from_entity_id" is null and "app"."agent_knowledge_relations"."to_entity_id" is null and "app"."agent_knowledge_relations"."label" is null
          and "app"."agent_knowledge_relations"."server" is not null and "app"."agent_knowledge_relations"."tool" is not null and "app"."agent_knowledge_relations"."question" is not null
          and "app"."agent_knowledge_relations"."hint" is null and "app"."agent_knowledge_relations"."outcome" is null))
);
--> statement-breakpoint
CREATE TABLE "app"."agent_knowledge_runs" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"record_id" uuid NOT NULL,
	"servers" jsonb NOT NULL,
	"extracted_up_to" timestamp with time zone,
	"extract_task_id" uuid,
	"last_extract_task_id" uuid,
	"needs_round" boolean DEFAULT false NOT NULL,
	"last_status" text,
	"last_reason" text,
	"last_added" integer,
	"last_confirmed" integer,
	"last_outdated" integer,
	"last_model" text,
	"last_at" timestamp with time zone,
	CONSTRAINT "agent_knowledge_runs_last_status_check" CHECK ("app"."agent_knowledge_runs"."last_status" in ('done', 'skipped', 'failed')),
	CONSTRAINT "agent_knowledge_runs_last_reason_check" CHECK ("app"."agent_knowledge_runs"."last_reason" in ('stopped', 'owner_disabled', 'quota_exhausted', 'model_not_connected', 'model_not_allowed', 'no_models_allowed', 'model_error', 'invalid_answer', 'interrupted'))
);
--> statement-breakpoint
CREATE TABLE "app"."agent_knowledge_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"limit_tokens" integer DEFAULT 8000 NOT NULL,
	"lessons_enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone,
	"updated_by" text,
	CONSTRAINT "agent_knowledge_settings_single_row_check" CHECK ("app"."agent_knowledge_settings"."id"),
	CONSTRAINT "agent_knowledge_settings_limit_tokens_check" CHECK ("app"."agent_knowledge_settings"."limit_tokens" between 1000 and 32000)
);
--> statement-breakpoint
CREATE TABLE "app"."agent_knowledge_vectors" (
	"record_id" uuid NOT NULL,
	"key" text NOT NULL,
	"key_kind" text NOT NULL,
	"model" text NOT NULL,
	"vector" vector NOT NULL,
	CONSTRAINT "agent_knowledge_vectors_record_id_key_pk" PRIMARY KEY("record_id","key"),
	CONSTRAINT "agent_knowledge_vectors_key_kind_check" CHECK ("app"."agent_knowledge_vectors"."key_kind" in ('entity', 'relation'))
);
--> statement-breakpoint
ALTER TABLE "app"."agent_knowledge_embedding" ADD CONSTRAINT "agent_knowledge_embedding_record_id_library_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "app"."library_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_knowledge_entities" ADD CONSTRAINT "agent_knowledge_entities_record_id_library_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "app"."library_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_knowledge_questions" ADD CONSTRAINT "agent_knowledge_questions_task_id_agent_sessions_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "app"."agent_sessions"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_knowledge_relations" ADD CONSTRAINT "agent_knowledge_relations_record_id_library_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "app"."library_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_knowledge_relations" ADD CONSTRAINT "agent_knowledge_relations_from_entity_fk" FOREIGN KEY ("from_entity_id") REFERENCES "app"."agent_knowledge_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_knowledge_relations" ADD CONSTRAINT "agent_knowledge_relations_to_entity_fk" FOREIGN KEY ("to_entity_id") REFERENCES "app"."agent_knowledge_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_knowledge_runs" ADD CONSTRAINT "agent_knowledge_runs_run_id_agent_sessions_task_id_fk" FOREIGN KEY ("run_id") REFERENCES "app"."agent_sessions"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_knowledge_vectors" ADD CONSTRAINT "agent_knowledge_vectors_record_id_library_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "app"."library_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_knowledge_entities_record_idx" ON "app"."agent_knowledge_entities" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "agent_knowledge_relations_record_idx" ON "app"."agent_knowledge_relations" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "agent_knowledge_runs_record_idx" ON "app"."agent_knowledge_runs" USING btree ("record_id");--> statement-breakpoint
INSERT INTO "app"."agent_knowledge_settings" ("id") VALUES (true);