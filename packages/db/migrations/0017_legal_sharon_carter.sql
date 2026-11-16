CREATE TABLE "app"."audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"actor" text NOT NULL,
	"object_type" text,
	"object_id" text,
	"before" jsonb,
	"after" jsonb,
	"outcome" text NOT NULL,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."identity_login_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state" text NOT NULL,
	"provider_id" uuid NOT NULL,
	"nonce" text NOT NULL,
	"code_verifier" text NOT NULL,
	"next" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_login_requests_state_key" UNIQUE("state")
);
--> statement-breakpoint
CREATE TABLE "app"."identity_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_providers_type_check" CHECK ("app"."identity_providers"."type" in ('google', 'oidc'))
);
--> statement-breakpoint
CREATE TABLE "app"."identity_role_members" (
	"role_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "identity_role_members_role_id_user_id_pk" PRIMARY KEY("role_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "app"."identity_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."identity_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_reason" text,
	CONSTRAINT "identity_sessions_token_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "app"."identity_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"public_url" text,
	"idle_minutes" integer DEFAULT 480 NOT NULL,
	"absolute_minutes" integer DEFAULT 1440 NOT NULL,
	"updated_at" timestamp with time zone,
	"updated_by" text,
	CONSTRAINT "identity_settings_single_row_check" CHECK ("app"."identity_settings"."id"),
	CONSTRAINT "identity_settings_idle_minutes_check" CHECK ("app"."identity_settings"."idle_minutes" between 15 and 1440),
	CONSTRAINT "identity_settings_absolute_minutes_check" CHECK ("app"."identity_settings"."absolute_minutes" between 60 and 43200),
	CONSTRAINT "identity_settings_idle_not_above_absolute_check" CHECK ("app"."identity_settings"."idle_minutes" <= "app"."identity_settings"."absolute_minutes")
);
--> statement-breakpoint
CREATE TABLE "app"."identity_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"login" text,
	"password_hash" text,
	"status" text DEFAULT 'active' NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"last_sign_in_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_users_status_check" CHECK ("app"."identity_users"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "app"."identity_login_requests" ADD CONSTRAINT "identity_login_requests_provider_id_identity_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "app"."identity_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."identity_role_members" ADD CONSTRAINT "identity_role_members_role_id_identity_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "app"."identity_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."identity_role_members" ADD CONSTRAINT "identity_role_members_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."identity_sessions" ADD CONSTRAINT "identity_sessions_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_role_members_user_idx" ON "app"."identity_role_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_roles_name_idx" ON "app"."identity_roles" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "identity_sessions_user_idx" ON "app"."identity_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_users_email_idx" ON "app"."identity_users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_users_login_idx" ON "app"."identity_users" USING btree ("login");--> statement-breakpoint
INSERT INTO "app"."identity_roles" ("name", "is_admin", "builtin") VALUES ('Супер-администратор', true, true);--> statement-breakpoint
INSERT INTO "app"."identity_settings" ("id", "idle_minutes", "absolute_minutes") VALUES (true, 480, 1440);