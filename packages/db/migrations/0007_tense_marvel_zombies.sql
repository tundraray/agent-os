CREATE TABLE "app"."agent_definition_memory" (
	"id" uuid PRIMARY KEY NOT NULL,
	"process_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"scope" text NOT NULL,
	"user_id" text,
	"text" text NOT NULL,
	"written_by" text NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "agent_definition_memory_scope_check" CHECK ("app"."agent_definition_memory"."scope" in ('deployment', 'user')),
	CONSTRAINT "agent_definition_memory_user_check" CHECK (("app"."agent_definition_memory"."scope" = 'user') = ("app"."agent_definition_memory"."user_id" is not null)),
	CONSTRAINT "agent_definition_memory_values_check" CHECK ("app"."agent_definition_memory"."process_id" <> '' and "app"."agent_definition_memory"."agent_name" <> '' and "app"."agent_definition_memory"."written_by" <> '' and char_length("app"."agent_definition_memory"."text") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "app"."agent_tool_audit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"resource_id" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tool_name" text NOT NULL,
	"source_id" text,
	"outcome" text NOT NULL,
	CONSTRAINT "agent_tool_audit_values_check" CHECK ("app"."agent_tool_audit"."resource_id" <> '' and "app"."agent_tool_audit"."tool_name" <> '' and "app"."agent_tool_audit"."outcome" <> '')
);
--> statement-breakpoint
CREATE TABLE "app"."research_agent_memory" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "app"."research_agent_memory_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"investigation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"run_task_id" uuid NOT NULL,
	"agent_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_agent_memory_kind_check" CHECK ("app"."research_agent_memory"."kind" in ('finding', 'tried', 'dead_end', 'note')),
	CONSTRAINT "research_agent_memory_text_check" CHECK (char_length("app"."research_agent_memory"."text") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "app"."research_agent_messages" (
	"run_task_id" uuid NOT NULL,
	"investigation_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"content" jsonb NOT NULL,
	"llm_call_id" uuid,
	"tool_call_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_agent_messages_run_task_id_seq_pk" PRIMARY KEY("run_task_id","seq"),
	CONSTRAINT "research_agent_messages_seq_check" CHECK ("app"."research_agent_messages"."seq" >= 0),
	CONSTRAINT "research_agent_messages_kind_check" CHECK ("app"."research_agent_messages"."kind" <> '')
);
--> statement-breakpoint
CREATE TABLE "app"."research_agent_runs" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"investigation_id" uuid NOT NULL,
	"agent_name" text NOT NULL,
	"parent_task_id" uuid,
	"parent_call_index" integer,
	"depth" integer NOT NULL,
	"assignment" text,
	"share_tokens" integer NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"sources" text[] DEFAULT '{}'::text[] NOT NULL,
	"prologue_input" jsonb,
	"result" jsonb,
	"failure" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_agent_runs_parent_check" CHECK (("app"."research_agent_runs"."parent_task_id" is null) = ("app"."research_agent_runs"."parent_call_index" is null) and ("app"."research_agent_runs"."parent_task_id" is null) = ("app"."research_agent_runs"."depth" = 0)),
	CONSTRAINT "research_agent_runs_numbers_check" CHECK ("app"."research_agent_runs"."depth" >= 0 and "app"."research_agent_runs"."share_tokens" >= 0 and ("app"."research_agent_runs"."parent_call_index" is null or "app"."research_agent_runs"."parent_call_index" >= 0)),
	CONSTRAINT "research_agent_runs_agent_name_check" CHECK ("app"."research_agent_runs"."agent_name" <> ''),
	CONSTRAINT "research_agent_runs_prologue_input_size_check" CHECK ("app"."research_agent_runs"."prologue_input" is null or octet_length("app"."research_agent_runs"."prologue_input"::text) <= 65536),
	CONSTRAINT "research_agent_runs_ending_check" CHECK ("app"."research_agent_runs"."result" is null or "app"."research_agent_runs"."failure" is null)
);
--> statement-breakpoint
CREATE TABLE "app"."research_agent_tool_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"investigation_id" uuid NOT NULL,
	"run_task_id" uuid NOT NULL,
	"turn" integer NOT NULL,
	"call_index" integer NOT NULL,
	"tool_name" text NOT NULL,
	"arguments" jsonb NOT NULL,
	"state" text NOT NULL,
	"outcome" jsonb,
	"reason" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"audit_id" uuid,
	"child_task_id" uuid,
	"share_tokens" integer,
	"spent_tokens" integer,
	"task_spec" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_agent_tool_calls_run_call_key" UNIQUE("run_task_id","call_index"),
	CONSTRAINT "research_agent_tool_calls_state_check" CHECK ("app"."research_agent_tool_calls"."state" in ('requested', 'starting', 'waiting', 'done', 'rejected')),
	CONSTRAINT "research_agent_tool_calls_numbers_check" CHECK ("app"."research_agent_tool_calls"."turn" >= 0 and "app"."research_agent_tool_calls"."call_index" >= 0 and ("app"."research_agent_tool_calls"."share_tokens" is null or "app"."research_agent_tool_calls"."share_tokens" >= 0) and ("app"."research_agent_tool_calls"."spent_tokens" is null or "app"."research_agent_tool_calls"."spent_tokens" >= 0)),
	CONSTRAINT "research_agent_tool_calls_tool_name_check" CHECK ("app"."research_agent_tool_calls"."tool_name" <> ''),
	CONSTRAINT "research_agent_tool_calls_waiting_check" CHECK ("app"."research_agent_tool_calls"."state" <> 'waiting' or "app"."research_agent_tool_calls"."child_task_id" is not null),
	CONSTRAINT "research_agent_tool_calls_rejected_check" CHECK ("app"."research_agent_tool_calls"."state" <> 'rejected' or "app"."research_agent_tool_calls"."reason" is not null)
);
--> statement-breakpoint
ALTER TABLE "app"."research_llm_calls" DROP CONSTRAINT "research_llm_calls_role_check";--> statement-breakpoint
ALTER TABLE "app"."research_llm_transcripts" DROP CONSTRAINT "research_llm_transcripts_role_check";--> statement-breakpoint
ALTER TABLE "app"."research_engine_runs" ADD COLUMN "definition_memory_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "app"."research_llm_transcripts" ADD COLUMN "agent_name" text;--> statement-breakpoint
ALTER TABLE "app"."research_agent_memory" ADD CONSTRAINT "research_agent_memory_investigation_id_research_investigations_investigation_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "app"."research_investigations"("investigation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."research_agent_memory" ADD CONSTRAINT "research_agent_memory_run_task_id_research_agent_runs_task_id_fk" FOREIGN KEY ("run_task_id") REFERENCES "app"."research_agent_runs"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."research_agent_messages" ADD CONSTRAINT "research_agent_messages_run_task_id_research_agent_runs_task_id_fk" FOREIGN KEY ("run_task_id") REFERENCES "app"."research_agent_runs"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."research_agent_messages" ADD CONSTRAINT "research_agent_messages_investigation_id_research_investigations_investigation_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "app"."research_investigations"("investigation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."research_agent_messages" ADD CONSTRAINT "research_agent_messages_llm_call_id_research_llm_calls_call_id_fk" FOREIGN KEY ("llm_call_id") REFERENCES "app"."research_llm_calls"("call_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."research_agent_messages" ADD CONSTRAINT "research_agent_messages_tool_call_id_research_agent_tool_calls_id_fk" FOREIGN KEY ("tool_call_id") REFERENCES "app"."research_agent_tool_calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."research_agent_runs" ADD CONSTRAINT "research_agent_runs_investigation_id_research_investigations_investigation_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "app"."research_investigations"("investigation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."research_agent_runs" ADD CONSTRAINT "research_agent_runs_task_fk" FOREIGN KEY ("investigation_id","task_id") REFERENCES "app"."research_tasks"("investigation_id","task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."research_agent_runs" ADD CONSTRAINT "research_agent_runs_parent_fk" FOREIGN KEY ("parent_task_id") REFERENCES "app"."research_agent_runs"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."research_agent_tool_calls" ADD CONSTRAINT "research_agent_tool_calls_investigation_id_research_investigations_investigation_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "app"."research_investigations"("investigation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."research_agent_tool_calls" ADD CONSTRAINT "research_agent_tool_calls_run_task_id_research_agent_runs_task_id_fk" FOREIGN KEY ("run_task_id") REFERENCES "app"."research_agent_runs"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."research_agent_tool_calls" ADD CONSTRAINT "research_agent_tool_calls_audit_id_agent_tool_audit_id_fk" FOREIGN KEY ("audit_id") REFERENCES "app"."agent_tool_audit"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_definition_memory_active_idx" ON "app"."agent_definition_memory" USING btree ("process_id","agent_name","scope","user_id") WHERE "app"."agent_definition_memory"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "agent_tool_audit_resource_recorded_idx" ON "app"."agent_tool_audit" USING btree ("resource_id","recorded_at");--> statement-breakpoint
CREATE INDEX "research_agent_memory_investigation_seq_idx" ON "app"."research_agent_memory" USING btree ("investigation_id","seq");--> statement-breakpoint
CREATE INDEX "research_agent_messages_investigation_idx" ON "app"."research_agent_messages" USING btree ("investigation_id");--> statement-breakpoint
CREATE INDEX "research_agent_runs_investigation_idx" ON "app"."research_agent_runs" USING btree ("investigation_id");--> statement-breakpoint
CREATE INDEX "research_agent_runs_parent_idx" ON "app"."research_agent_runs" USING btree ("parent_task_id") WHERE "app"."research_agent_runs"."parent_task_id" is not null;--> statement-breakpoint
CREATE INDEX "research_agent_tool_calls_investigation_idx" ON "app"."research_agent_tool_calls" USING btree ("investigation_id");--> statement-breakpoint
CREATE INDEX "research_agent_tool_calls_child_task_idx" ON "app"."research_agent_tool_calls" USING btree ("child_task_id") WHERE "app"."research_agent_tool_calls"."child_task_id" is not null;--> statement-breakpoint
ALTER TABLE "app"."research_llm_calls" ADD CONSTRAINT "research_llm_calls_role_check" CHECK ("app"."research_llm_calls"."role" in ('plan', 'controller', 'worker', 'verifier', 'synthesis', 'agent'));--> statement-breakpoint
ALTER TABLE "app"."research_llm_transcripts" ADD CONSTRAINT "research_llm_transcripts_role_check" CHECK ("app"."research_llm_transcripts"."role" in ('plan', 'controller', 'worker', 'verifier', 'synthesis', 'agent', 'judge'));