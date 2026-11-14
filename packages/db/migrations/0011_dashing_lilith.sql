CREATE TABLE "app"."runtime_decisions" (
	"decision_id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"root_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" jsonb,
	"delivered_step" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "runtime_decisions_status_check" CHECK ("app"."runtime_decisions"."status" in ('open', 'resolved', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "app"."runtime_event_deliveries" (
	"event_id" uuid NOT NULL,
	"consumer" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	CONSTRAINT "runtime_event_deliveries_event_id_consumer_pk" PRIMARY KEY("event_id","consumer"),
	CONSTRAINT "runtime_event_deliveries_status_check" CHECK ("app"."runtime_event_deliveries"."status" in ('pending', 'done', 'needs_attention'))
);
--> statement-breakpoint
CREATE TABLE "app"."runtime_events" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "app"."runtime_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"type" text NOT NULL,
	"schema_version" integer NOT NULL,
	"root_id" uuid NOT NULL,
	"task_id" uuid,
	"causation_id" uuid,
	"state_revision" integer NOT NULL,
	"payload_ref" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_events_payload_size_check" CHECK (octet_length("app"."runtime_events"."payload"::text) <= 8192)
);
--> statement-breakpoint
CREATE TABLE "app"."runtime_inbox" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"recipient_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"sender" text NOT NULL,
	"payload" jsonb NOT NULL,
	"revive" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"delivered_step" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "runtime_inbox_recipient_seq_key" UNIQUE("recipient_id","seq"),
	CONSTRAINT "runtime_inbox_status_check" CHECK ("app"."runtime_inbox"."status" in ('pending', 'delivered'))
);
--> statement-breakpoint
CREATE TABLE "app"."runtime_model_calls" (
	"call_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"task_id" uuid,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_read_tokens" integer NOT NULL,
	"cache_write_tokens" integer NOT NULL,
	"cost_usd" numeric(18, 9) NOT NULL,
	"called_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."runtime_tasks" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"owner_id" text NOT NULL,
	"parent_id" uuid,
	"root_id" uuid NOT NULL,
	"depth" integer NOT NULL,
	"input" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"wait_reason" text,
	"step_no" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"step_claims" integer DEFAULT 0 NOT NULL,
	"recoveries" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"next_message_seq" integer DEFAULT 0 NOT NULL,
	"result" jsonb,
	"failure" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "runtime_tasks_status_check" CHECK ("app"."runtime_tasks"."status" in ('queued', 'running', 'waiting', 'completed', 'failed', 'stopped')),
	CONSTRAINT "runtime_tasks_wait_reason_check" CHECK ("app"."runtime_tasks"."wait_reason" in ('messages', 'decision', 'interrupted')),
	CONSTRAINT "runtime_tasks_waiting_check" CHECK (("app"."runtime_tasks"."status" = 'waiting') = ("app"."runtime_tasks"."wait_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "app"."runtime_decisions" ADD CONSTRAINT "runtime_decisions_task_id_runtime_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "app"."runtime_tasks"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."runtime_event_deliveries" ADD CONSTRAINT "runtime_event_deliveries_event_id_runtime_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "app"."runtime_events"("event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."runtime_events" ADD CONSTRAINT "runtime_events_root_id_runtime_tasks_task_id_fk" FOREIGN KEY ("root_id") REFERENCES "app"."runtime_tasks"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."runtime_inbox" ADD CONSTRAINT "runtime_inbox_recipient_id_runtime_tasks_task_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "app"."runtime_tasks"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."runtime_tasks" ADD CONSTRAINT "runtime_tasks_parent_id_runtime_tasks_task_id_fk" FOREIGN KEY ("parent_id") REFERENCES "app"."runtime_tasks"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."runtime_tasks" ADD CONSTRAINT "runtime_tasks_root_id_runtime_tasks_task_id_fk" FOREIGN KEY ("root_id") REFERENCES "app"."runtime_tasks"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_decisions_open_task_idx" ON "app"."runtime_decisions" USING btree ("task_id") WHERE "app"."runtime_decisions"."status" = 'open';--> statement-breakpoint
CREATE INDEX "runtime_decisions_root_idx" ON "app"."runtime_decisions" USING btree ("root_id");--> statement-breakpoint
CREATE INDEX "runtime_event_deliveries_pending_idx" ON "app"."runtime_event_deliveries" USING btree ("next_attempt_at") WHERE "app"."runtime_event_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "runtime_events_root_seq_idx" ON "app"."runtime_events" USING btree ("root_id","seq");--> statement-breakpoint
CREATE INDEX "runtime_events_causation_idx" ON "app"."runtime_events" USING btree ("causation_id");--> statement-breakpoint
CREATE INDEX "runtime_events_task_seq_idx" ON "app"."runtime_events" USING btree ("task_id","seq");--> statement-breakpoint
CREATE INDEX "runtime_inbox_pending_idx" ON "app"."runtime_inbox" USING btree ("recipient_id","seq") WHERE "app"."runtime_inbox"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "runtime_model_calls_owner_called_idx" ON "app"."runtime_model_calls" USING btree ("owner_id","called_at");--> statement-breakpoint
CREATE INDEX "runtime_tasks_ready_idx" ON "app"."runtime_tasks" USING btree ("status","type","created_at") WHERE "app"."runtime_tasks"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "runtime_tasks_root_idx" ON "app"."runtime_tasks" USING btree ("root_id");--> statement-breakpoint
CREATE INDEX "runtime_tasks_parent_idx" ON "app"."runtime_tasks" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "runtime_tasks_owner_idx" ON "app"."runtime_tasks" USING btree ("owner_id");