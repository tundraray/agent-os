CREATE TABLE "app"."research_chat_launches" (
	"launch_key" text PRIMARY KEY NOT NULL,
	"resource_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"mode" text NOT NULL,
	"goal" text NOT NULL,
	"token_budget" integer NOT NULL,
	"user_message_id" text,
	"state" text NOT NULL,
	"investigation_id" uuid,
	"controller_task_id" uuid,
	"source_mode" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"append_failed_at" timestamp with time zone,
	"next_append_at" timestamp with time zone,
	CONSTRAINT "research_chat_launches_mode_check" CHECK ("app"."research_chat_launches"."mode" in ('explicit', 'proposal')),
	CONSTRAINT "research_chat_launches_state_check" CHECK ("app"."research_chat_launches"."state" in ('proposed', 'launching', 'running', 'answer_pending', 'answered', 'answer_reappend', 'declined', 'superseded', 'failed', 'stopped', 'discarded')),
	CONSTRAINT "research_chat_launches_source_mode_check" CHECK ("app"."research_chat_launches"."source_mode" in ('sources', 'model_knowledge')),
	CONSTRAINT "research_chat_launches_keys_check" CHECK ("app"."research_chat_launches"."launch_key" <> '' and "app"."research_chat_launches"."resource_id" <> '' and "app"."research_chat_launches"."thread_id" <> ''),
	CONSTRAINT "research_chat_launches_token_budget_check" CHECK ("app"."research_chat_launches"."token_budget" > 0),
	CONSTRAINT "research_chat_launches_user_message_check" CHECK (("app"."research_chat_launches"."mode" = 'explicit') = ("app"."research_chat_launches"."user_message_id" is not null)),
	CONSTRAINT "research_chat_launches_started_check" CHECK (not ("app"."research_chat_launches"."state" in ('running', 'answer_pending', 'answered', 'answer_reappend')) or ("app"."research_chat_launches"."investigation_id" is not null and "app"."research_chat_launches"."controller_task_id" is not null)),
	CONSTRAINT "research_chat_launches_source_mode_investigation_check" CHECK ("app"."research_chat_launches"."source_mode" is null or "app"."research_chat_launches"."investigation_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "app"."research_chat_launches" ADD CONSTRAINT "research_chat_launches_investigation_id_research_investigations_investigation_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "app"."research_investigations"("investigation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "research_chat_launches_thread_created_idx" ON "app"."research_chat_launches" USING btree ("resource_id","thread_id","created_at");--> statement-breakpoint
CREATE INDEX "research_chat_launches_controller_task_idx" ON "app"."research_chat_launches" USING btree ("controller_task_id") WHERE "app"."research_chat_launches"."controller_task_id" is not null;--> statement-breakpoint
CREATE INDEX "research_chat_launches_investigation_idx" ON "app"."research_chat_launches" USING btree ("investigation_id") WHERE "app"."research_chat_launches"."investigation_id" is not null;--> statement-breakpoint
CREATE INDEX "research_chat_launches_answer_due_idx" ON "app"."research_chat_launches" USING btree ("finished_at") WHERE "app"."research_chat_launches"."state" in ('answer_pending', 'answer_reappend');