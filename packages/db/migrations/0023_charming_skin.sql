CREATE TABLE "app"."chat_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"call_id" text NOT NULL,
	"kind" text NOT NULL,
	"record_id" uuid,
	"base_version" integer,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"content" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"saved_record_id" uuid,
	"refusal" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "chat_drafts_kind_check" CHECK ("app"."chat_drafts"."kind" in ('agent', 'workflow')),
	CONSTRAINT "chat_drafts_state_check" CHECK ("app"."chat_drafts"."state" in ('pending', 'saved', 'saved_in_editor', 'rejected', 'superseded')),
	CONSTRAINT "chat_drafts_refusal_check" CHECK ("app"."chat_drafts"."refusal" in ('not_found', 'read_only', 'shared', 'version_conflict', 'name_taken', 'system_name', 'invalid', 'server_not_allowed', 'all_servers_not_allowed', 'model_not_allowed', 'agent_not_visible', 'role_not_member', 'sharing_banned', 'holder_not_found', 'audience_fixed', 'builtin'))
);
--> statement-breakpoint
ALTER TABLE "app"."agent_sessions" ADD COLUMN "name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."agent_sessions" ADD COLUMN "record_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."agent_sessions" ADD COLUMN "record_kind" text;--> statement-breakpoint
ALTER TABLE "app"."agent_sessions" ADD COLUMN "record_version" integer;--> statement-breakpoint
ALTER TABLE "app"."agent_sessions" ADD COLUMN "record_name" text;--> statement-breakpoint
ALTER TABLE "app"."agent_sessions" ADD COLUMN "author_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."agent_sessions" ADD COLUMN "author_name" text;--> statement-breakpoint
ALTER TABLE "app"."agent_sessions" ADD COLUMN "builtin_key" text;--> statement-breakpoint
ALTER TABLE "app"."agent_sessions" ADD COLUMN "executor" text;--> statement-breakpoint
ALTER TABLE "app"."agent_sessions" ADD COLUMN "first_run" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."agent_tool_calls" ADD COLUMN "refusal_detail" jsonb;--> statement-breakpoint
ALTER TABLE "app"."chat_drafts" ADD CONSTRAINT "chat_drafts_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "app"."chat_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_drafts_conversation_idx" ON "app"."chat_drafts" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_owner_record_idx" ON "app"."agent_sessions" USING btree ("owner_id","record_id");