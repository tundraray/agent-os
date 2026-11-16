CREATE TABLE "app"."access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role_id" uuid,
	"user_id" uuid,
	"effect" text NOT NULL,
	"target_kind" text NOT NULL,
	"server" text,
	"tool" text,
	"model" text,
	"quota_usd" numeric(12, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_grants_holder_target_key" UNIQUE NULLS NOT DISTINCT("role_id","user_id","effect","target_kind","server","tool","model"),
	CONSTRAINT "access_grants_effect_check" CHECK ("app"."access_grants"."effect" in ('allow', 'deny')),
	CONSTRAINT "access_grants_target_kind_check" CHECK ("app"."access_grants"."target_kind" in ('server', 'tool', 'model')),
	CONSTRAINT "access_grants_holder_check" CHECK (num_nonnulls("app"."access_grants"."role_id", "app"."access_grants"."user_id") = 1),
	CONSTRAINT "access_grants_target_check" CHECK (("app"."access_grants"."target_kind" = 'server'
          and "app"."access_grants"."server" is not null and "app"."access_grants"."tool" is null and "app"."access_grants"."model" is null)
        or ("app"."access_grants"."target_kind" = 'tool'
          and "app"."access_grants"."server" is not null and "app"."access_grants"."tool" is not null and "app"."access_grants"."model" is null)
        or ("app"."access_grants"."target_kind" = 'model'
          and "app"."access_grants"."server" is null and "app"."access_grants"."tool" is null and "app"."access_grants"."model" is not null)),
	CONSTRAINT "access_grants_deny_holder_check" CHECK ("app"."access_grants"."effect" = 'allow' or "app"."access_grants"."user_id" is not null),
	CONSTRAINT "access_grants_quota_check" CHECK ("app"."access_grants"."quota_usd" is null or ("app"."access_grants"."effect" = 'allow'
        and "app"."access_grants"."target_kind" = 'model'))
);
--> statement-breakpoint
CREATE TABLE "app"."access_models" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"input_usd_per_mtok" numeric(18, 9) NOT NULL,
	"output_usd_per_mtok" numeric(18, 9) NOT NULL,
	"cache_write_usd_per_mtok" numeric(18, 9) NOT NULL,
	"cache_read_usd_per_mtok" numeric(18, 9) NOT NULL,
	"long_context_above_input_tokens" integer,
	"long_context_input_usd_per_mtok" numeric(18, 9),
	"long_context_output_usd_per_mtok" numeric(18, 9),
	"long_context_cache_write_usd_per_mtok" numeric(18, 9),
	"long_context_cache_read_usd_per_mtok" numeric(18, 9),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_models_prices_check" CHECK ("app"."access_models"."input_usd_per_mtok" >= 0 and "app"."access_models"."output_usd_per_mtok" >= 0
        and "app"."access_models"."cache_write_usd_per_mtok" >= 0 and "app"."access_models"."cache_read_usd_per_mtok" >= 0
        and "app"."access_models"."long_context_input_usd_per_mtok" >= 0 and "app"."access_models"."long_context_output_usd_per_mtok" >= 0
        and "app"."access_models"."long_context_cache_write_usd_per_mtok" >= 0 and "app"."access_models"."long_context_cache_read_usd_per_mtok" >= 0),
	CONSTRAINT "access_models_long_context_threshold_check" CHECK ("app"."access_models"."long_context_above_input_tokens" > 0),
	CONSTRAINT "access_models_long_context_check" CHECK (num_nulls("app"."access_models"."long_context_above_input_tokens", "app"."access_models"."long_context_input_usd_per_mtok",
          "app"."access_models"."long_context_output_usd_per_mtok", "app"."access_models"."long_context_cache_write_usd_per_mtok",
          "app"."access_models"."long_context_cache_read_usd_per_mtok") = 0
        or num_nulls("app"."access_models"."long_context_above_input_tokens", "app"."access_models"."long_context_input_usd_per_mtok",
          "app"."access_models"."long_context_output_usd_per_mtok", "app"."access_models"."long_context_cache_write_usd_per_mtok",
          "app"."access_models"."long_context_cache_read_usd_per_mtok") = 5)
);
--> statement-breakpoint
ALTER TABLE "app"."access_grants" ADD CONSTRAINT "access_grants_role_id_identity_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "app"."identity_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."access_grants" ADD CONSTRAINT "access_grants_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."access_grants" ADD CONSTRAINT "access_grants_model_access_models_id_fk" FOREIGN KEY ("model") REFERENCES "app"."access_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_grants_role_idx" ON "app"."access_grants" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "access_grants_user_idx" ON "app"."access_grants" USING btree ("user_id");