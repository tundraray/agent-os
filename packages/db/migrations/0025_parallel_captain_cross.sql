CREATE TABLE "app"."access_model_defaults" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"chat_model" text,
	"embedding_model" text,
	"updated_at" timestamp with time zone,
	"updated_by" text,
	CONSTRAINT "access_model_defaults_single_row_check" CHECK ("app"."access_model_defaults"."id")
);
--> statement-breakpoint
CREATE TABLE "app"."agent_model_providers" (
	"name" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"base_url" text,
	"api_key" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_model_providers_kind_check" CHECK ("app"."agent_model_providers"."kind" in ('anthropic', 'gemini', 'openai_compatible'))
);
--> statement-breakpoint
ALTER TABLE "app"."agent_code_calls" DROP CONSTRAINT "agent_code_calls_refusal_reason_check";--> statement-breakpoint
ALTER TABLE "app"."agent_tool_calls" DROP CONSTRAINT "agent_tool_calls_refusal_reason_check";--> statement-breakpoint
ALTER TABLE "app"."access_models" ADD COLUMN "purpose" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."access_models" ADD COLUMN "dimensions" integer;--> statement-breakpoint
ALTER TABLE "app"."access_model_defaults" ADD CONSTRAINT "access_model_defaults_chat_model_access_models_id_fk" FOREIGN KEY ("chat_model") REFERENCES "app"."access_models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."access_model_defaults" ADD CONSTRAINT "access_model_defaults_embedding_model_access_models_id_fk" FOREIGN KEY ("embedding_model") REFERENCES "app"."access_models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."access_models" ADD CONSTRAINT "access_models_purpose_check" CHECK ("app"."access_models"."purpose" in ('chat', 'embedding'));--> statement-breakpoint
ALTER TABLE "app"."access_models" ADD CONSTRAINT "access_models_dimensions_check" CHECK (("app"."access_models"."purpose" = 'embedding'
          and "app"."access_models"."dimensions" is not null
          and "app"."access_models"."dimensions" between 1 and 4096
          and "app"."access_models"."long_context_above_input_tokens" is null)
        or ("app"."access_models"."purpose" = 'chat' and "app"."access_models"."dimensions" is null));--> statement-breakpoint
ALTER TABLE "app"."agent_code_calls" ADD CONSTRAINT "agent_code_calls_refusal_reason_check" CHECK ("app"."agent_code_calls"."refusal_reason" in ('tool_not_in_definition', 'no_access', 'not_allowed', 'depth_limit', 'model_not_connected', 'model_not_allowed', 'model_not_configured', 'provider_missing', 'provider_disabled', 'provider_key_missing', 'unknown_agent', 'invalid_arguments', 'not_callable_from_code', 'changing_in_read_run', 'not_in_confirmed_script', 'record_unavailable', 'run_limit', 'read_only', 'shared'));--> statement-breakpoint
ALTER TABLE "app"."agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_refusal_reason_check" CHECK ("app"."agent_tool_calls"."refusal_reason" in ('tool_not_in_definition', 'no_access', 'not_allowed', 'depth_limit', 'model_not_connected', 'model_not_allowed', 'model_not_configured', 'provider_missing', 'provider_disabled', 'provider_key_missing', 'unknown_agent', 'invalid_arguments', 'not_callable_from_code', 'changing_in_read_run', 'not_in_confirmed_script', 'record_unavailable', 'run_limit', 'read_only', 'shared'));--> statement-breakpoint
INSERT INTO "app"."access_model_defaults" ("id") VALUES (true);