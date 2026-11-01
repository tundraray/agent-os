CREATE TABLE "app"."research_claims" (
	"claim_revision_id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "app"."research_claims_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"investigation_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"claim_index" integer NOT NULL,
	"text" text NOT NULL,
	"atoms" jsonb NOT NULL,
	"evidence_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"coverage" jsonb,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_claims_task_claim_key" UNIQUE("task_id","claim_index"),
	CONSTRAINT "research_claims_status_check" CHECK ("app"."research_claims"."status" in ('unverified', 'supported', 'refuted', 'insufficient')),
	CONSTRAINT "research_claims_claim_index_check" CHECK ("app"."research_claims"."claim_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."research_decisions" (
	"decision_id" uuid PRIMARY KEY NOT NULL,
	"investigation_id" uuid NOT NULL,
	"step" integer NOT NULL,
	"call_index" integer NOT NULL,
	"status" text NOT NULL,
	"rejection_reason" text,
	"decided_by" text NOT NULL,
	"kind" text,
	"decision" jsonb,
	"plan_revision" integer,
	"proposed_task_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"not_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_decisions_step_call_key" UNIQUE("investigation_id","step","call_index"),
	CONSTRAINT "research_decisions_status_check" CHECK ("app"."research_decisions"."status" in ('accepted', 'rejected')),
	CONSTRAINT "research_decisions_decided_by_check" CHECK ("app"."research_decisions"."decided_by" in ('model', 'code')),
	CONSTRAINT "research_decisions_kind_check" CHECK ("app"."research_decisions"."kind" in ('requestEvidence', 'requestAnalysis', 'requestVerification', 'replan', 'wait', 'proposeAnswer', 'concludeInconclusive')),
	CONSTRAINT "research_decisions_accepted_kind_check" CHECK ("app"."research_decisions"."status" <> 'accepted' or "app"."research_decisions"."kind" is not null),
	CONSTRAINT "research_decisions_rejection_reason_check" CHECK (("app"."research_decisions"."status" = 'rejected') = ("app"."research_decisions"."rejection_reason" is not null)),
	CONSTRAINT "research_decisions_step_check" CHECK ("app"."research_decisions"."step" >= 1 and "app"."research_decisions"."call_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."research_engine_runs" (
	"investigation_id" uuid PRIMARY KEY NOT NULL,
	"resource_id" text NOT NULL,
	"launch_key" text NOT NULL,
	"process_id" text NOT NULL,
	"process_version" integer NOT NULL,
	"process_config" jsonb NOT NULL,
	"source_mode" text NOT NULL,
	"controller_task_id" uuid,
	"token_budget" integer NOT NULL,
	"tokens_reserved" integer DEFAULT 0 NOT NULL,
	"tokens_spent" integer DEFAULT 0 NOT NULL,
	"answer_id" uuid,
	"answer" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_engine_runs_launch_key" UNIQUE("resource_id","launch_key"),
	CONSTRAINT "research_engine_runs_source_mode_check" CHECK ("app"."research_engine_runs"."source_mode" in ('sources', 'model_knowledge')),
	CONSTRAINT "research_engine_runs_tokens_check" CHECK ("app"."research_engine_runs"."token_budget" > 0 and "app"."research_engine_runs"."tokens_reserved" >= 0 and "app"."research_engine_runs"."tokens_spent" >= 0 and "app"."research_engine_runs"."tokens_spent" <= "app"."research_engine_runs"."token_budget"),
	CONSTRAINT "research_engine_runs_process_version_check" CHECK ("app"."research_engine_runs"."process_version" > 0),
	CONSTRAINT "research_engine_runs_keys_check" CHECK ("app"."research_engine_runs"."resource_id" <> '' and "app"."research_engine_runs"."launch_key" <> ''),
	CONSTRAINT "research_engine_runs_answer_check" CHECK (("app"."research_engine_runs"."answer_id" is null) = ("app"."research_engine_runs"."answer" is null))
);
--> statement-breakpoint
CREATE TABLE "app"."research_llm_calls" (
	"call_id" uuid PRIMARY KEY NOT NULL,
	"investigation_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"role" text NOT NULL,
	"model" text NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"reserved_tokens" integer NOT NULL,
	"counted_input_tokens" integer NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	"charged_tokens" integer,
	"cost_usd" numeric(14, 8),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "research_llm_calls_status_check" CHECK ("app"."research_llm_calls"."status" in ('reserved', 'settled', 'failed', 'abandoned')),
	CONSTRAINT "research_llm_calls_role_check" CHECK ("app"."research_llm_calls"."role" in ('plan', 'controller', 'worker', 'verifier', 'synthesis')),
	CONSTRAINT "research_llm_calls_closed_check" CHECK (("app"."research_llm_calls"."status" = 'reserved') = ("app"."research_llm_calls"."closed_at" is null) and ("app"."research_llm_calls"."closed_at" is null) = ("app"."research_llm_calls"."charged_tokens" is null)),
	CONSTRAINT "research_llm_calls_tokens_check" CHECK ("app"."research_llm_calls"."reserved_tokens" > 0 and "app"."research_llm_calls"."counted_input_tokens" >= 0 and "app"."research_llm_calls"."attempt" >= 1 and ("app"."research_llm_calls"."charged_tokens" is null or "app"."research_llm_calls"."charged_tokens" >= 0))
);
--> statement-breakpoint
CREATE TABLE "app"."research_plan_revisions" (
	"investigation_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"plan" jsonb NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_plan_revisions_investigation_id_revision_pk" PRIMARY KEY("investigation_id","revision"),
	CONSTRAINT "research_plan_revisions_revision_check" CHECK ("app"."research_plan_revisions"."revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "app"."research_signals" (
	"signal_id" uuid PRIMARY KEY NOT NULL,
	"investigation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_by_decision_id" uuid,
	CONSTRAINT "research_signals_payload_size_check" CHECK (octet_length("app"."research_signals"."payload"::text) <= 4096)
);
--> statement-breakpoint
ALTER TABLE "app"."research_claims" ADD CONSTRAINT "research_claims_investigation_id_research_investigations_investigation_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "app"."research_investigations"("investigation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."research_claims" ADD CONSTRAINT "research_claims_task_fk" FOREIGN KEY ("investigation_id","task_id") REFERENCES "app"."research_tasks"("investigation_id","task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."research_decisions" ADD CONSTRAINT "research_decisions_investigation_id_research_investigations_investigation_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "app"."research_investigations"("investigation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."research_decisions" ADD CONSTRAINT "research_decisions_plan_revision_fk" FOREIGN KEY ("investigation_id","plan_revision") REFERENCES "app"."research_plan_revisions"("investigation_id","revision") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."research_engine_runs" ADD CONSTRAINT "research_engine_runs_investigation_id_research_investigations_investigation_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "app"."research_investigations"("investigation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."research_llm_calls" ADD CONSTRAINT "research_llm_calls_investigation_id_research_investigations_investigation_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "app"."research_investigations"("investigation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."research_llm_calls" ADD CONSTRAINT "research_llm_calls_task_fk" FOREIGN KEY ("investigation_id","task_id") REFERENCES "app"."research_tasks"("investigation_id","task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."research_plan_revisions" ADD CONSTRAINT "research_plan_revisions_investigation_id_research_investigations_investigation_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "app"."research_investigations"("investigation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."research_signals" ADD CONSTRAINT "research_signals_investigation_id_research_investigations_investigation_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "app"."research_investigations"("investigation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."research_signals" ADD CONSTRAINT "research_signals_read_by_decision_id_research_decisions_decision_id_fk" FOREIGN KEY ("read_by_decision_id") REFERENCES "app"."research_decisions"("decision_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "research_claims_claim_seq_idx" ON "app"."research_claims" USING btree ("claim_id","seq");--> statement-breakpoint
CREATE INDEX "research_claims_investigation_idx" ON "app"."research_claims" USING btree ("investigation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_decisions_accepted_step_idx" ON "app"."research_decisions" USING btree ("investigation_id","step") WHERE "app"."research_decisions"."status" = 'accepted';--> statement-breakpoint
CREATE INDEX "research_llm_calls_investigation_idx" ON "app"."research_llm_calls" USING btree ("investigation_id");--> statement-breakpoint
CREATE INDEX "research_llm_calls_reserved_task_idx" ON "app"."research_llm_calls" USING btree ("task_id") WHERE "app"."research_llm_calls"."status" = 'reserved';--> statement-breakpoint
CREATE INDEX "research_signals_unread_idx" ON "app"."research_signals" USING btree ("investigation_id","recorded_at") WHERE "app"."research_signals"."read_by_decision_id" is null;