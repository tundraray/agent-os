CREATE TABLE "app"."agent_messages" (
	"task_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"content" jsonb NOT NULL,
	"model_call_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_messages_task_id_seq_pk" PRIMARY KEY("task_id","seq"),
	CONSTRAINT "agent_messages_kind_check" CHECK ("app"."agent_messages"."kind" in ('task', 'user_message', 'agent_message', 'child_report', 'model_answer', 'tool_result', 'notice', 'event', 'compaction'))
);
--> statement-breakpoint
CREATE TABLE "app"."agent_sessions" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"definition" text NOT NULL,
	"description" text NOT NULL,
	"model" text NOT NULL,
	"prompt" text NOT NULL,
	"limits" jsonb,
	"forked_from_task_id" uuid,
	"forked_through_seq" integer,
	"turns" integer DEFAULT 0 NOT NULL,
	"interrupted" boolean DEFAULT false NOT NULL,
	"closed" boolean DEFAULT false NOT NULL,
	"last_input_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."agent_tool_calls" (
	"task_id" uuid NOT NULL,
	"call_id" text NOT NULL,
	"answer_seq" integer NOT NULL,
	"position" integer NOT NULL,
	"tool" text NOT NULL,
	"server" text,
	"args" jsonb NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"outcome" text,
	"refusal_reason" text,
	"result_text" text,
	"child_task_id" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "agent_tool_calls_task_id_call_id_pk" PRIMARY KEY("task_id","call_id"),
	CONSTRAINT "agent_tool_calls_state_check" CHECK ("app"."agent_tool_calls"."state" in ('requested', 'awaiting_confirmation', 'sending', 'done')),
	CONSTRAINT "agent_tool_calls_outcome_check" CHECK ("app"."agent_tool_calls"."outcome" in ('success', 'empty', 'tool_error', 'transport_failure', 'refused', 'rejected', 'interrupted', 'unknown')),
	CONSTRAINT "agent_tool_calls_refusal_reason_check" CHECK ("app"."agent_tool_calls"."refusal_reason" in ('tool_not_in_definition', 'no_access', 'not_allowed', 'depth_limit', 'unknown_model', 'unknown_agent', 'invalid_arguments')),
	CONSTRAINT "agent_tool_calls_done_check" CHECK (("app"."agent_tool_calls"."state" = 'done') = ("app"."agent_tool_calls"."outcome" is not null))
);
--> statement-breakpoint
ALTER TABLE "app"."agent_messages" ADD CONSTRAINT "agent_messages_task_id_agent_sessions_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "app"."agent_sessions"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_sessions" ADD CONSTRAINT "agent_sessions_task_id_runtime_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "app"."runtime_tasks"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_task_id_agent_sessions_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "app"."agent_sessions"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_tool_calls_awaiting_idx" ON "app"."agent_tool_calls" USING btree ("state") WHERE "app"."agent_tool_calls"."state" = 'awaiting_confirmation';