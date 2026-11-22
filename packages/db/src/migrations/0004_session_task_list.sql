CREATE TABLE "app"."agent_session_tasks" (
	"task_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"subject" text NOT NULL,
	"description" text NOT NULL,
	"active_form" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"owner" text,
	"blocked_by" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_session_tasks_task_id_number_pk" PRIMARY KEY("task_id","number"),
	CONSTRAINT "agent_session_tasks_status_check" CHECK ("app"."agent_session_tasks"."status" in ('pending', 'in_progress', 'completed'))
);
--> statement-breakpoint
ALTER TABLE "app"."agent_sessions" ADD COLUMN "last_task_number" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."agent_session_tasks" ADD CONSTRAINT "agent_session_tasks_task_id_agent_sessions_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "app"."agent_sessions"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DROP TABLE "app"."agent_run_tasks" CASCADE;