CREATE TABLE "app"."library_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"owner_id" uuid,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"offer_in_chat" boolean DEFAULT false NOT NULL,
	"builtin_key" text,
	"content" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_records_kind_check" CHECK ("app"."library_records"."kind" in ('agent', 'workflow')),
	CONSTRAINT "library_records_builtin_key_check" CHECK ("app"."library_records"."builtin_key" is null or "app"."library_records"."owner_id" is null),
	CONSTRAINT "library_records_closed_at_check" CHECK ("app"."library_records"."closed_at" is null or "app"."library_records"."owner_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "app"."library_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"record_id" uuid NOT NULL,
	"role_id" uuid,
	"user_id" uuid,
	"everyone" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_shares_record_holder_key" UNIQUE NULLS NOT DISTINCT("record_id","role_id","user_id","everyone"),
	CONSTRAINT "library_shares_holder_check" CHECK (num_nonnulls("app"."library_shares"."role_id", "app"."library_shares"."user_id", nullif("app"."library_shares"."everyone", false)) = 1)
);
--> statement-breakpoint
ALTER TABLE "app"."library_records" ADD CONSTRAINT "library_records_owner_id_identity_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "app"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."library_shares" ADD CONSTRAINT "library_shares_record_id_library_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "app"."library_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."library_shares" ADD CONSTRAINT "library_shares_role_id_identity_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "app"."identity_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."library_shares" ADD CONSTRAINT "library_shares_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "library_records_owner_name_idx" ON "app"."library_records" USING btree ("owner_id",lower("name")) WHERE "app"."library_records"."owner_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "library_records_system_name_idx" ON "app"."library_records" USING btree (lower("name")) WHERE "app"."library_records"."owner_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "library_records_builtin_key_idx" ON "app"."library_records" USING btree ("builtin_key");--> statement-breakpoint
CREATE INDEX "library_shares_role_idx" ON "app"."library_shares" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "library_shares_user_idx" ON "app"."library_shares" USING btree ("user_id");