CREATE TABLE "app"."chat_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"root_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_conversations_root_idx" ON "app"."chat_conversations" USING btree ("root_id");--> statement-breakpoint
CREATE INDEX "chat_conversations_owner_page_idx" ON "app"."chat_conversations" USING btree ("owner_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);