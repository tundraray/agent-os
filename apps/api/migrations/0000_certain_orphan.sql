CREATE SCHEMA IF NOT EXISTS "app";
--> statement-breakpoint
CREATE TABLE "app"."research_event_deliveries" (
	"event_id" uuid NOT NULL,
	"consumer" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	CONSTRAINT "research_event_deliveries_event_id_consumer_pk" PRIMARY KEY("event_id","consumer"),
	CONSTRAINT "research_event_deliveries_status_check" CHECK ("app"."research_event_deliveries"."status" in ('pending', 'done', 'needs_attention'))
);
--> statement-breakpoint
CREATE TABLE "app"."research_events" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "app"."research_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"type" text NOT NULL,
	"schema_version" integer NOT NULL,
	"investigation_id" uuid NOT NULL,
	"task_id" uuid,
	"causation_id" uuid,
	"correlation_id" uuid NOT NULL,
	"state_revision" integer NOT NULL,
	"payload_ref" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_events_payload_size_check" CHECK (octet_length("app"."research_events"."payload"::text) <= 8192)
);
--> statement-breakpoint
CREATE TABLE "app"."research_evidence" (
	"evidence_id" uuid PRIMARY KEY NOT NULL,
	"investigation_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"evidence_key" text NOT NULL,
	"written_by_attempt" integer NOT NULL,
	"knowledge_status" text DEFAULT 'observed' NOT NULL,
	"scope" text,
	"basis" text,
	"evidence_version" integer,
	"provenance" jsonb NOT NULL,
	"coverage" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_evidence_task_key" UNIQUE("task_id","evidence_key"),
	CONSTRAINT "research_evidence_knowledge_status_check" CHECK ("app"."research_evidence"."knowledge_status" in ('observed', 'candidate', 'supported', 'refuted', 'unknown', 'stale')),
	CONSTRAINT "research_evidence_supported_check" CHECK ("app"."research_evidence"."knowledge_status" <> 'supported' or ("app"."research_evidence"."scope" is not null and "app"."research_evidence"."basis" is not null and "app"."research_evidence"."evidence_version" is not null))
);
--> statement-breakpoint
CREATE TABLE "app"."research_evidence_contents" (
	"evidence_id" uuid PRIMARY KEY NOT NULL,
	"media_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	CONSTRAINT "research_evidence_contents_byte_size_check" CHECK ("app"."research_evidence_contents"."byte_size" = octet_length("app"."research_evidence_contents"."bytes") and "app"."research_evidence_contents"."byte_size" <= 16777216)
);
--> statement-breakpoint
CREATE TABLE "app"."research_investigations" (
	"investigation_id" uuid PRIMARY KEY NOT NULL,
	"resource_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"query" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"max_tasks" integer NOT NULL,
	"tasks_reserved" integer DEFAULT 0 NOT NULL,
	"max_tool_calls" integer NOT NULL,
	"tool_calls_reserved" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_investigations_status_check" CHECK ("app"."research_investigations"."status" in ('active', 'cancelled', 'deleting')),
	CONSTRAINT "research_investigations_tasks_reserved_check" CHECK ("app"."research_investigations"."tasks_reserved" >= 0 and "app"."research_investigations"."tasks_reserved" <= "app"."research_investigations"."max_tasks"),
	CONSTRAINT "research_investigations_tool_calls_reserved_check" CHECK ("app"."research_investigations"."tool_calls_reserved" >= 0 and "app"."research_investigations"."tool_calls_reserved" <= "app"."research_investigations"."max_tool_calls"),
	CONSTRAINT "research_investigations_resource_id_check" CHECK ("app"."research_investigations"."resource_id" <> '')
);
--> statement-breakpoint
CREATE TABLE "app"."research_task_dependencies" (
	"investigation_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"depends_on_task_id" uuid NOT NULL,
	"kind" text NOT NULL,
	CONSTRAINT "research_task_dependencies_task_id_depends_on_task_id_kind_pk" PRIMARY KEY("task_id","depends_on_task_id","kind"),
	CONSTRAINT "research_task_dependencies_kind_check" CHECK ("app"."research_task_dependencies"."kind" in ('depends_on', 'waits_for')),
	CONSTRAINT "research_task_dependencies_no_loop_check" CHECK ("app"."research_task_dependencies"."task_id" <> "app"."research_task_dependencies"."depends_on_task_id")
);
--> statement-breakpoint
CREATE TABLE "app"."research_task_subscribers" (
	"task_id" uuid NOT NULL,
	"subscriber_key" text NOT NULL,
	"subscribed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_event_id" uuid,
	CONSTRAINT "research_task_subscribers_task_id_subscriber_key_pk" PRIMARY KEY("task_id","subscriber_key")
);
--> statement-breakpoint
CREATE TABLE "app"."research_tasks" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"investigation_id" uuid NOT NULL,
	"workflow_type" text NOT NULL,
	"workflow_version" integer NOT NULL,
	"input" jsonb NOT NULL,
	"input_refs" jsonb NOT NULL,
	"expected_output" jsonb NOT NULL,
	"dedup_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"wait_condition" jsonb,
	"state_version" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"recovery_count" integer DEFAULT 0 NOT NULL,
	"deadline_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"max_tool_calls" integer NOT NULL,
	"max_retries" integer NOT NULL,
	"deadline_ms" integer NOT NULL,
	"max_tokens" integer NOT NULL,
	"tool_calls_used" integer DEFAULT 0 NOT NULL,
	"retries_used" integer DEFAULT 0 NOT NULL,
	"attempt_tool_calls" integer DEFAULT 0 NOT NULL,
	"attempt_retries" integer DEFAULT 0 NOT NULL,
	"outcome" jsonb,
	"failure_reason" jsonb,
	"output_refs" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"checkpoint" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_tasks_investigation_task_key" UNIQUE("investigation_id","task_id"),
	CONSTRAINT "research_tasks_status_check" CHECK ("app"."research_tasks"."status" in ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "research_tasks_wait_condition_check" CHECK (("app"."research_tasks"."status" = 'waiting') = ("app"."research_tasks"."wait_condition" is not null)),
	CONSTRAINT "research_tasks_tool_calls_check" CHECK ("app"."research_tasks"."tool_calls_used" >= 0 and "app"."research_tasks"."attempt_tool_calls" >= 0 and "app"."research_tasks"."tool_calls_used" + "app"."research_tasks"."attempt_tool_calls" <= "app"."research_tasks"."max_tool_calls"),
	CONSTRAINT "research_tasks_retries_check" CHECK ("app"."research_tasks"."retries_used" >= 0 and "app"."research_tasks"."attempt_retries" >= 0 and "app"."research_tasks"."retries_used" + "app"."research_tasks"."attempt_retries" <= "app"."research_tasks"."max_retries"),
	CONSTRAINT "research_tasks_dedup_key_check" CHECK ("app"."research_tasks"."dedup_key" like 'v1:%')
);
--> statement-breakpoint
ALTER TABLE "app"."research_event_deliveries" ADD CONSTRAINT "research_event_deliveries_event_id_research_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "app"."research_events"("event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."research_events" ADD CONSTRAINT "research_events_investigation_id_research_investigations_investigation_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "app"."research_investigations"("investigation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."research_evidence" ADD CONSTRAINT "research_evidence_task_fk" FOREIGN KEY ("investigation_id","task_id") REFERENCES "app"."research_tasks"("investigation_id","task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."research_evidence_contents" ADD CONSTRAINT "research_evidence_contents_evidence_id_research_evidence_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "app"."research_evidence"("evidence_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."research_task_dependencies" ADD CONSTRAINT "research_task_dependencies_task_fk" FOREIGN KEY ("investigation_id","task_id") REFERENCES "app"."research_tasks"("investigation_id","task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."research_task_dependencies" ADD CONSTRAINT "research_task_dependencies_depends_on_fk" FOREIGN KEY ("investigation_id","depends_on_task_id") REFERENCES "app"."research_tasks"("investigation_id","task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."research_task_subscribers" ADD CONSTRAINT "research_task_subscribers_task_id_research_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "app"."research_tasks"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."research_tasks" ADD CONSTRAINT "research_tasks_investigation_id_research_investigations_investigation_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "app"."research_investigations"("investigation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "research_event_deliveries_pending_idx" ON "app"."research_event_deliveries" USING btree ("next_attempt_at") WHERE "app"."research_event_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "research_events_correlation_seq_idx" ON "app"."research_events" USING btree ("correlation_id","seq");--> statement-breakpoint
CREATE INDEX "research_events_causation_idx" ON "app"."research_events" USING btree ("causation_id");--> statement-breakpoint
CREATE INDEX "research_events_task_seq_idx" ON "app"."research_events" USING btree ("task_id","seq");--> statement-breakpoint
CREATE INDEX "research_events_investigation_idx" ON "app"."research_events" USING btree ("investigation_id");--> statement-breakpoint
CREATE INDEX "research_investigations_resource_thread_idx" ON "app"."research_investigations" USING btree ("resource_id","thread_id");--> statement-breakpoint
CREATE INDEX "research_task_dependencies_depends_on_idx" ON "app"."research_task_dependencies" USING btree ("depends_on_task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_tasks_live_dedup_key_idx" ON "app"."research_tasks" USING btree ("investigation_id","dedup_key") WHERE "app"."research_tasks"."status" in ('queued', 'running', 'waiting', 'succeeded');--> statement-breakpoint
CREATE INDEX "research_tasks_queued_idx" ON "app"."research_tasks" USING btree ("created_at") WHERE "app"."research_tasks"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "research_tasks_running_lease_idx" ON "app"."research_tasks" USING btree ("lease_expires_at") WHERE "app"."research_tasks"."status" = 'running';--> statement-breakpoint
CREATE INDEX "research_tasks_unfinished_deadline_idx" ON "app"."research_tasks" USING btree ("deadline_at") WHERE "app"."research_tasks"."status" in ('queued', 'running', 'waiting');