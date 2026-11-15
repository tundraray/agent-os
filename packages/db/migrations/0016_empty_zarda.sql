CREATE TABLE "app"."agent_code_calls" (
	"task_id" uuid NOT NULL,
	"run_call_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"seq" integer NOT NULL,
	"tool" text NOT NULL,
	"server" text,
	"args" jsonb NOT NULL,
	"outcome" text,
	"refusal_reason" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "agent_code_calls_task_id_run_call_id_attempt_seq_pk" PRIMARY KEY("task_id","run_call_id","attempt","seq"),
	CONSTRAINT "agent_code_calls_outcome_check" CHECK ("app"."agent_code_calls"."outcome" in ('success', 'empty', 'tool_error', 'transport_failure', 'refused', 'rejected', 'interrupted', 'unknown')),
	CONSTRAINT "agent_code_calls_refusal_reason_check" CHECK ("app"."agent_code_calls"."refusal_reason" in ('tool_not_in_definition', 'no_access', 'not_allowed', 'depth_limit', 'unknown_model', 'unknown_agent', 'invalid_arguments', 'not_callable_from_code', 'changing_in_read_run', 'not_in_confirmed_script'))
);
--> statement-breakpoint
CREATE TABLE "app"."agent_tool_results" (
	"task_id" uuid NOT NULL,
	"call_id" text NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_tool_results_task_id_call_id_pk" PRIMARY KEY("task_id","call_id")
);
--> statement-breakpoint
ALTER TABLE "app"."agent_tool_calls" DROP CONSTRAINT "agent_tool_calls_refusal_reason_check";--> statement-breakpoint
ALTER TABLE "app"."agent_tool_calls" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."agent_tool_calls" ADD COLUMN "output" text;--> statement-breakpoint
ALTER TABLE "app"."agent_code_calls" ADD CONSTRAINT "agent_code_calls_run_call_fk" FOREIGN KEY ("task_id","run_call_id") REFERENCES "app"."agent_tool_calls"("task_id","call_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_tool_results" ADD CONSTRAINT "agent_tool_results_call_fk" FOREIGN KEY ("task_id","call_id") REFERENCES "app"."agent_tool_calls"("task_id","call_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_refusal_reason_check" CHECK ("app"."agent_tool_calls"."refusal_reason" in ('tool_not_in_definition', 'no_access', 'not_allowed', 'depth_limit', 'unknown_model', 'unknown_agent', 'invalid_arguments', 'not_callable_from_code', 'changing_in_read_run', 'not_in_confirmed_script'));