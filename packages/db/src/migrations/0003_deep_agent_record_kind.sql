CREATE TABLE "app"."agent_run_tasks" (
	"task_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"text" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_run_tasks_task_id_number_pk" PRIMARY KEY("task_id","number"),
	CONSTRAINT "agent_run_tasks_status_check" CHECK ("app"."agent_run_tasks"."status" in ('waiting', 'running', 'done', 'failed', 'cancelled'))
);
--> statement-breakpoint
DROP TABLE "app"."chat_drafts" CASCADE;--> statement-breakpoint
ALTER TABLE "app"."agent_sessions" RENAME COLUMN "executor" TO "subagent";--> statement-breakpoint
ALTER TABLE "app"."agent_code_calls" DROP CONSTRAINT "agent_code_calls_refusal_reason_check";--> statement-breakpoint
ALTER TABLE "app"."library_records" DROP CONSTRAINT "library_records_kind_check";--> statement-breakpoint
ALTER TABLE "app"."agent_run_tasks" ADD CONSTRAINT "agent_run_tasks_task_id_agent_sessions_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "app"."agent_sessions"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_code_calls" ADD CONSTRAINT "agent_code_calls_refusal_reason_check" CHECK ("app"."agent_code_calls"."refusal_reason" in ('tool_not_in_definition', 'no_access', 'not_allowed', 'depth_limit', 'model_not_connected', 'model_not_allowed', 'model_not_configured', 'provider_missing', 'provider_disabled', 'provider_key_missing', 'unknown_agent', 'invalid_arguments', 'not_callable_from_code', 'changing_in_read_run', 'not_in_confirmed_script', 'record_unavailable', 'run_limit', 'read_only', 'shared', 'repeated_call', 'admin_only', 'builtin', 'name_taken', 'system_name', 'server_not_allowed', 'all_servers_not_allowed', 'agent_not_visible', 'version_conflict'));--> statement-breakpoint
ALTER TABLE "app"."library_records" ADD CONSTRAINT "library_records_kind_check" CHECK ("app"."library_records"."kind" in ('agent', 'deep_agent'));