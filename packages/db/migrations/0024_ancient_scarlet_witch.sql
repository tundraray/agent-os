CREATE TABLE "app"."library_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"default_max_turns" integer DEFAULT 40 NOT NULL,
	"updated_at" timestamp with time zone,
	"updated_by" text,
	CONSTRAINT "library_settings_single_row_check" CHECK ("app"."library_settings"."id"),
	CONSTRAINT "library_settings_default_max_turns_check" CHECK ("app"."library_settings"."default_max_turns" between 1 and 200)
);
--> statement-breakpoint
INSERT INTO "app"."library_settings" ("id", "default_max_turns") VALUES (true, 40);