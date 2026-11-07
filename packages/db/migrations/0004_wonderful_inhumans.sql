CREATE TABLE "app"."research_llm_transcripts" (
	"call_id" uuid PRIMARY KEY NOT NULL,
	"llm_call_id" uuid,
	"investigation_id" uuid,
	"task_id" uuid,
	"attempt" integer,
	"self_check_run_id" text,
	"role" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input" jsonb NOT NULL,
	"response" jsonb,
	"outcome" text,
	"input_tokens" integer,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(14, 8),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "research_llm_transcripts_llm_call_key" UNIQUE("llm_call_id"),
	CONSTRAINT "research_llm_transcripts_role_check" CHECK ("app"."research_llm_transcripts"."role" in ('plan', 'controller', 'worker', 'verifier', 'synthesis', 'judge')),
	CONSTRAINT "research_llm_transcripts_outcome_check" CHECK ("app"."research_llm_transcripts"."outcome" in ('answered', 'invalid_output', 'provider_error')),
	CONSTRAINT "research_llm_transcripts_binding_check" CHECK ("app"."research_llm_transcripts"."investigation_id" is not null or "app"."research_llm_transcripts"."self_check_run_id" is not null),
	CONSTRAINT "research_llm_transcripts_ledger_check" CHECK (("app"."research_llm_transcripts"."llm_call_id" is null or ("app"."research_llm_transcripts"."llm_call_id" = "app"."research_llm_transcripts"."call_id" and "app"."research_llm_transcripts"."investigation_id" is not null)) and ("app"."research_llm_transcripts"."llm_call_id" is null) = ("app"."research_llm_transcripts"."task_id" is null) and ("app"."research_llm_transcripts"."task_id" is null) = ("app"."research_llm_transcripts"."attempt" is null)),
	CONSTRAINT "research_llm_transcripts_closed_check" CHECK (("app"."research_llm_transcripts"."outcome" is null) = ("app"."research_llm_transcripts"."closed_at" is null) and ("app"."research_llm_transcripts"."response" is null or "app"."research_llm_transcripts"."outcome" is not null)),
	CONSTRAINT "research_llm_transcripts_prompt_version_check" CHECK ("app"."research_llm_transcripts"."prompt_version" ~ '^[0-9a-f]{12}$')
);
--> statement-breakpoint
ALTER TABLE "app"."research_engine_runs" ADD COLUMN "source_snapshots" jsonb;--> statement-breakpoint
ALTER TABLE "app"."research_llm_transcripts" ADD CONSTRAINT "research_llm_transcripts_llm_call_id_research_llm_calls_call_id_fk" FOREIGN KEY ("llm_call_id") REFERENCES "app"."research_llm_calls"("call_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."research_llm_transcripts" ADD CONSTRAINT "research_llm_transcripts_investigation_id_research_investigations_investigation_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "app"."research_investigations"("investigation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "research_llm_transcripts_investigation_idx" ON "app"."research_llm_transcripts" USING btree ("investigation_id","created_at");--> statement-breakpoint
CREATE INDEX "research_llm_transcripts_self_check_run_idx" ON "app"."research_llm_transcripts" USING btree ("self_check_run_id","created_at") WHERE "app"."research_llm_transcripts"."self_check_run_id" is not null;--> statement-breakpoint
CREATE INDEX "research_llm_transcripts_created_idx" ON "app"."research_llm_transcripts" USING btree ("created_at");