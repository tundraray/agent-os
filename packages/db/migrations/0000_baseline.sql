CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "app";
--> statement-breakpoint
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
CREATE TABLE "app"."access_model_defaults" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"chat_model" text,
	"embedding_model" text,
	"updated_at" timestamp with time zone,
	"updated_by" text,
	CONSTRAINT "access_model_defaults_single_row_check" CHECK ("app"."access_model_defaults"."id")
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
	"purpose" text DEFAULT 'chat' NOT NULL,
	"dimensions" integer,
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
          "app"."access_models"."long_context_cache_read_usd_per_mtok") = 5),
	CONSTRAINT "access_models_purpose_check" CHECK ("app"."access_models"."purpose" in ('chat', 'embedding')),
	CONSTRAINT "access_models_dimensions_check" CHECK (("app"."access_models"."purpose" = 'embedding'
          and "app"."access_models"."dimensions" is not null
          and "app"."access_models"."dimensions" between 1 and 4096
          and "app"."access_models"."long_context_above_input_tokens" is null)
        or ("app"."access_models"."purpose" = 'chat' and "app"."access_models"."dimensions" is null))
);
--> statement-breakpoint
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
	"finished_at" timestamp with time zone,
	CONSTRAINT "agent_code_calls_task_id_run_call_id_attempt_seq_pk" PRIMARY KEY("task_id","run_call_id","attempt","seq"),
	CONSTRAINT "agent_code_calls_outcome_check" CHECK ("app"."agent_code_calls"."outcome" in ('success', 'empty', 'tool_error', 'transport_failure', 'refused', 'rejected', 'interrupted', 'unknown', 'auth_required')),
	CONSTRAINT "agent_code_calls_refusal_reason_check" CHECK ("app"."agent_code_calls"."refusal_reason" in ('tool_not_in_definition', 'no_access', 'not_allowed', 'depth_limit', 'model_not_connected', 'model_not_allowed', 'model_not_configured', 'provider_missing', 'provider_disabled', 'provider_key_missing', 'unknown_agent', 'invalid_arguments', 'not_callable_from_code', 'changing_in_read_run', 'not_in_confirmed_script', 'record_unavailable', 'run_limit', 'read_only', 'shared'))
);
--> statement-breakpoint
CREATE TABLE "app"."agent_knowledge_embedding" (
	"record_id" uuid PRIMARY KEY NOT NULL,
	"pass_task_id" uuid,
	"needs_pass" boolean DEFAULT false NOT NULL,
	"payer_id" text,
	"last_reason" text,
	"last_model" text,
	"last_at" timestamp with time zone,
	CONSTRAINT "agent_knowledge_embedding_last_reason_check" CHECK ("app"."agent_knowledge_embedding"."last_reason" in ('model_not_configured', 'owner_disabled', 'provider_missing', 'provider_disabled', 'provider_key_missing', 'provider_key_rejected', 'provider_unavailable', 'provider_error', 'dimension_mismatch'))
);
--> statement-breakpoint
CREATE TABLE "app"."agent_knowledge_entities" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "app"."agent_knowledge_entities_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"record_id" uuid NOT NULL,
	"confirmations" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_run_id" uuid NOT NULL,
	"confirmed_by_run_id" uuid NOT NULL,
	"outdated" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	CONSTRAINT "agent_knowledge_entities_confirmations_check" CHECK ("app"."agent_knowledge_entities"."confirmations" >= 1)
);
--> statement-breakpoint
CREATE TABLE "app"."agent_knowledge_questions" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"model" text,
	"vector" real[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."agent_knowledge_relations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "app"."agent_knowledge_relations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"record_id" uuid NOT NULL,
	"confirmations" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_run_id" uuid NOT NULL,
	"confirmed_by_run_id" uuid NOT NULL,
	"outdated" boolean DEFAULT false NOT NULL,
	"kind" text NOT NULL,
	"from_entity_id" integer,
	"to_entity_id" integer,
	"label" text,
	"server" text,
	"tool" text,
	"question" text,
	"hint" text,
	"outcome" text,
	CONSTRAINT "agent_knowledge_relations_confirmations_check" CHECK ("app"."agent_knowledge_relations"."confirmations" >= 1),
	CONSTRAINT "agent_knowledge_relations_kind_check" CHECK ("app"."agent_knowledge_relations"."kind" in ('fact', 'lesson', 'searched_nothing')),
	CONSTRAINT "agent_knowledge_relations_shape_check" CHECK (("app"."agent_knowledge_relations"."kind" = 'fact'
          and "app"."agent_knowledge_relations"."from_entity_id" is not null and "app"."agent_knowledge_relations"."to_entity_id" is not null
          and "app"."agent_knowledge_relations"."label" is not null and "app"."agent_knowledge_relations"."server" is null and "app"."agent_knowledge_relations"."tool" is null
          and "app"."agent_knowledge_relations"."question" is null and "app"."agent_knowledge_relations"."hint" is null and "app"."agent_knowledge_relations"."outcome" is null)
        or ("app"."agent_knowledge_relations"."kind" = 'lesson'
          and "app"."agent_knowledge_relations"."from_entity_id" is null and "app"."agent_knowledge_relations"."to_entity_id" is null and "app"."agent_knowledge_relations"."label" is null
          and "app"."agent_knowledge_relations"."server" is not null and "app"."agent_knowledge_relations"."tool" is not null and "app"."agent_knowledge_relations"."question" is not null
          and "app"."agent_knowledge_relations"."hint" is not null and "app"."agent_knowledge_relations"."outcome" is not null)
        or ("app"."agent_knowledge_relations"."kind" = 'searched_nothing'
          and "app"."agent_knowledge_relations"."from_entity_id" is null and "app"."agent_knowledge_relations"."to_entity_id" is null and "app"."agent_knowledge_relations"."label" is null
          and "app"."agent_knowledge_relations"."server" is not null and "app"."agent_knowledge_relations"."tool" is not null and "app"."agent_knowledge_relations"."question" is not null
          and "app"."agent_knowledge_relations"."hint" is null and "app"."agent_knowledge_relations"."outcome" is null))
);
--> statement-breakpoint
CREATE TABLE "app"."agent_knowledge_runs" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"record_id" uuid NOT NULL,
	"servers" jsonb NOT NULL,
	"extracted_up_to" timestamp with time zone,
	"extract_task_id" uuid,
	"last_extract_task_id" uuid,
	"needs_round" boolean DEFAULT false NOT NULL,
	"last_status" text,
	"last_reason" text,
	"last_added" integer,
	"last_confirmed" integer,
	"last_outdated" integer,
	"last_model" text,
	"last_at" timestamp with time zone,
	CONSTRAINT "agent_knowledge_runs_last_status_check" CHECK ("app"."agent_knowledge_runs"."last_status" in ('done', 'skipped', 'failed')),
	CONSTRAINT "agent_knowledge_runs_last_reason_check" CHECK ("app"."agent_knowledge_runs"."last_reason" in ('stopped', 'owner_disabled', 'quota_exhausted', 'model_not_connected', 'model_not_allowed', 'no_models_allowed', 'model_error', 'invalid_answer', 'interrupted'))
);
--> statement-breakpoint
CREATE TABLE "app"."agent_knowledge_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"limit_tokens" integer DEFAULT 8000 NOT NULL,
	"lessons_enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "agent_knowledge_settings_single_row_check" CHECK ("app"."agent_knowledge_settings"."id"),
	CONSTRAINT "agent_knowledge_settings_limit_tokens_check" CHECK ("app"."agent_knowledge_settings"."limit_tokens" between 1000 and 32000)
);
--> statement-breakpoint
CREATE TABLE "app"."agent_knowledge_vectors" (
	"record_id" uuid NOT NULL,
	"key" text NOT NULL,
	"key_kind" text NOT NULL,
	"model" text NOT NULL,
	"vector" vector NOT NULL,
	CONSTRAINT "agent_knowledge_vectors_record_id_key_pk" PRIMARY KEY("record_id","key"),
	CONSTRAINT "agent_knowledge_vectors_key_kind_check" CHECK ("app"."agent_knowledge_vectors"."key_kind" in ('entity', 'relation'))
);
--> statement-breakpoint
CREATE TABLE "app"."agent_mcp_accounts" (
	"owner_id" text NOT NULL,
	"server" text NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"expires_at" timestamp with time zone,
	CONSTRAINT "agent_mcp_accounts_owner_id_server_pk" PRIMARY KEY("owner_id","server")
);
--> statement-breakpoint
CREATE TABLE "app"."agent_mcp_servers" (
	"name" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"mode" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"tools" jsonb,
	"shared_token" text,
	"oauth_server" jsonb,
	"oauth_client_id" text,
	"oauth_client_secret" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_mcp_servers_mode_check" CHECK ("app"."agent_mcp_servers"."mode" in ('shared', 'oauth')),
	CONSTRAINT "agent_mcp_servers_shared_token_check" CHECK (("app"."agent_mcp_servers"."mode" = 'shared') = ("app"."agent_mcp_servers"."shared_token" is not null)),
	CONSTRAINT "agent_mcp_servers_enabled_tools_check" CHECK (not "app"."agent_mcp_servers"."enabled" or "app"."agent_mcp_servers"."tools" is not null),
	CONSTRAINT "agent_mcp_servers_oauth_client_check" CHECK ("app"."agent_mcp_servers"."mode" <> 'oauth' or "app"."agent_mcp_servers"."oauth_client_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "app"."agent_messages" (
	"task_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"content" jsonb NOT NULL,
	"model_call_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_messages_task_id_seq_pk" PRIMARY KEY("task_id","seq"),
	CONSTRAINT "agent_messages_kind_check" CHECK ("app"."agent_messages"."kind" in ('task', 'user_message', 'agent_message', 'child_report', 'model_answer', 'tool_result', 'notice', 'event', 'compaction'))
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
CREATE TABLE "app"."agent_sessions" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"model" text NOT NULL,
	"prompt" text NOT NULL,
	"record_id" uuid,
	"record_kind" text,
	"record_version" integer,
	"record_name" text,
	"author_id" uuid,
	"author_name" text,
	"builtin_key" text,
	"executor" text,
	"first_run" boolean DEFAULT false NOT NULL,
	"forked_from_task_id" uuid,
	"forked_through_seq" integer,
	"turns" integer DEFAULT 0 NOT NULL,
	"interrupted" boolean DEFAULT false NOT NULL,
	"closed" boolean DEFAULT false NOT NULL,
	"last_input_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."agent_tool_calls" (
	"task_id" uuid NOT NULL,
	"call_id" text NOT NULL,
	"answer_seq" integer NOT NULL,
	"position" integer NOT NULL,
	"tool" text NOT NULL,
	"server" text,
	"args" jsonb NOT NULL,
	"state" text DEFAULT 'requested' NOT NULL,
	"outcome" text,
	"refusal_reason" text,
	"refusal_detail" jsonb,
	"result_text" text,
	"child_task_id" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"output" text,
	CONSTRAINT "agent_tool_calls_task_id_call_id_pk" PRIMARY KEY("task_id","call_id"),
	CONSTRAINT "agent_tool_calls_state_check" CHECK ("app"."agent_tool_calls"."state" in ('requested', 'awaiting_confirmation', 'sending', 'done')),
	CONSTRAINT "agent_tool_calls_outcome_check" CHECK ("app"."agent_tool_calls"."outcome" in ('success', 'empty', 'tool_error', 'transport_failure', 'refused', 'rejected', 'interrupted', 'unknown', 'auth_required')),
	CONSTRAINT "agent_tool_calls_refusal_reason_check" CHECK ("app"."agent_tool_calls"."refusal_reason" in ('tool_not_in_definition', 'no_access', 'not_allowed', 'depth_limit', 'model_not_connected', 'model_not_allowed', 'model_not_configured', 'provider_missing', 'provider_disabled', 'provider_key_missing', 'unknown_agent', 'invalid_arguments', 'not_callable_from_code', 'changing_in_read_run', 'not_in_confirmed_script', 'record_unavailable', 'run_limit', 'read_only', 'shared')),
	CONSTRAINT "agent_tool_calls_done_check" CHECK (("app"."agent_tool_calls"."state" = 'done') = ("app"."agent_tool_calls"."outcome" is not null))
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
CREATE TABLE "app"."chat_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"root_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "app"."library_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"default_max_turns" integer DEFAULT 40 NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "library_settings_single_row_check" CHECK ("app"."library_settings"."id"),
	CONSTRAINT "library_settings_default_max_turns_check" CHECK ("app"."library_settings"."default_max_turns" between 1 and 200)
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
CREATE TABLE "app"."runtime_decisions" (
	"decision_id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"root_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" jsonb,
	"delivered_step" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "runtime_decisions_status_check" CHECK ("app"."runtime_decisions"."status" in ('open', 'resolved', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "app"."runtime_event_deliveries" (
	"event_id" uuid NOT NULL,
	"consumer" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	CONSTRAINT "runtime_event_deliveries_event_id_consumer_pk" PRIMARY KEY("event_id","consumer"),
	CONSTRAINT "runtime_event_deliveries_status_check" CHECK ("app"."runtime_event_deliveries"."status" in ('pending', 'done', 'needs_attention'))
);
--> statement-breakpoint
CREATE TABLE "app"."runtime_events" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "app"."runtime_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"type" text NOT NULL,
	"schema_version" integer NOT NULL,
	"root_id" uuid NOT NULL,
	"task_id" uuid,
	"causation_id" uuid,
	"state_revision" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_events_payload_size_check" CHECK (octet_length("app"."runtime_events"."payload"::text) <= 8192)
);
--> statement-breakpoint
CREATE TABLE "app"."runtime_inbox" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"recipient_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"sender" text NOT NULL,
	"payload" jsonb NOT NULL,
	"revive" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"delivered_step" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_inbox_recipient_seq_key" UNIQUE("recipient_id","seq"),
	CONSTRAINT "runtime_inbox_status_check" CHECK ("app"."runtime_inbox"."status" in ('pending', 'delivered'))
);
--> statement-breakpoint
CREATE TABLE "app"."runtime_model_calls" (
	"call_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"task_id" uuid,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_read_tokens" integer NOT NULL,
	"cache_write_tokens" integer NOT NULL,
	"cost_usd" numeric(18, 9) NOT NULL,
	"called_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."runtime_tasks" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"owner_id" text NOT NULL,
	"parent_id" uuid,
	"root_id" uuid NOT NULL,
	"depth" integer NOT NULL,
	"input" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"wait_reason" text,
	"step_no" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"step_claims" integer DEFAULT 0 NOT NULL,
	"recoveries" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"next_message_seq" integer DEFAULT 0 NOT NULL,
	"result" jsonb,
	"failure" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "app"."runtime_tasks_created_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "runtime_tasks_status_check" CHECK ("app"."runtime_tasks"."status" in ('queued', 'running', 'waiting', 'completed', 'failed', 'stopped')),
	CONSTRAINT "runtime_tasks_wait_reason_check" CHECK ("app"."runtime_tasks"."wait_reason" in ('messages', 'decision', 'interrupted')),
	CONSTRAINT "runtime_tasks_waiting_check" CHECK (("app"."runtime_tasks"."status" = 'waiting') = ("app"."runtime_tasks"."wait_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "app"."access_grants" ADD CONSTRAINT "access_grants_role_id_identity_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "app"."identity_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."access_grants" ADD CONSTRAINT "access_grants_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."access_grants" ADD CONSTRAINT "access_grants_model_access_models_id_fk" FOREIGN KEY ("model") REFERENCES "app"."access_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."access_model_defaults" ADD CONSTRAINT "access_model_defaults_chat_model_access_models_id_fk" FOREIGN KEY ("chat_model") REFERENCES "app"."access_models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."access_model_defaults" ADD CONSTRAINT "access_model_defaults_embedding_model_access_models_id_fk" FOREIGN KEY ("embedding_model") REFERENCES "app"."access_models"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_code_calls" ADD CONSTRAINT "agent_code_calls_run_call_fk" FOREIGN KEY ("task_id","run_call_id") REFERENCES "app"."agent_tool_calls"("task_id","call_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_knowledge_embedding" ADD CONSTRAINT "agent_knowledge_embedding_record_id_library_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "app"."library_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_knowledge_entities" ADD CONSTRAINT "agent_knowledge_entities_record_id_library_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "app"."library_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_knowledge_questions" ADD CONSTRAINT "agent_knowledge_questions_task_id_agent_sessions_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "app"."agent_sessions"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_knowledge_relations" ADD CONSTRAINT "agent_knowledge_relations_record_id_library_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "app"."library_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_knowledge_relations" ADD CONSTRAINT "agent_knowledge_relations_from_entity_fk" FOREIGN KEY ("from_entity_id") REFERENCES "app"."agent_knowledge_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_knowledge_relations" ADD CONSTRAINT "agent_knowledge_relations_to_entity_fk" FOREIGN KEY ("to_entity_id") REFERENCES "app"."agent_knowledge_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_knowledge_runs" ADD CONSTRAINT "agent_knowledge_runs_run_id_agent_sessions_task_id_fk" FOREIGN KEY ("run_id") REFERENCES "app"."agent_sessions"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_knowledge_vectors" ADD CONSTRAINT "agent_knowledge_vectors_record_id_library_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "app"."library_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_mcp_accounts" ADD CONSTRAINT "agent_mcp_accounts_server_agent_mcp_servers_name_fk" FOREIGN KEY ("server") REFERENCES "app"."agent_mcp_servers"("name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_messages" ADD CONSTRAINT "agent_messages_task_id_agent_sessions_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "app"."agent_sessions"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_sessions" ADD CONSTRAINT "agent_sessions_task_id_runtime_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "app"."runtime_tasks"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_task_id_agent_sessions_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "app"."agent_sessions"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_tool_results" ADD CONSTRAINT "agent_tool_results_call_fk" FOREIGN KEY ("task_id","call_id") REFERENCES "app"."agent_tool_calls"("task_id","call_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."chat_drafts" ADD CONSTRAINT "chat_drafts_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "app"."chat_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."identity_login_requests" ADD CONSTRAINT "identity_login_requests_provider_id_identity_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "app"."identity_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."identity_role_members" ADD CONSTRAINT "identity_role_members_role_id_identity_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "app"."identity_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."identity_role_members" ADD CONSTRAINT "identity_role_members_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."identity_sessions" ADD CONSTRAINT "identity_sessions_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."library_records" ADD CONSTRAINT "library_records_owner_id_identity_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "app"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."library_shares" ADD CONSTRAINT "library_shares_record_id_library_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "app"."library_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."library_shares" ADD CONSTRAINT "library_shares_role_id_identity_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "app"."identity_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."library_shares" ADD CONSTRAINT "library_shares_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."runtime_decisions" ADD CONSTRAINT "runtime_decisions_task_id_runtime_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "app"."runtime_tasks"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."runtime_event_deliveries" ADD CONSTRAINT "runtime_event_deliveries_event_id_runtime_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "app"."runtime_events"("event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."runtime_events" ADD CONSTRAINT "runtime_events_root_id_runtime_tasks_task_id_fk" FOREIGN KEY ("root_id") REFERENCES "app"."runtime_tasks"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."runtime_inbox" ADD CONSTRAINT "runtime_inbox_recipient_id_runtime_tasks_task_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "app"."runtime_tasks"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."runtime_tasks" ADD CONSTRAINT "runtime_tasks_parent_id_runtime_tasks_task_id_fk" FOREIGN KEY ("parent_id") REFERENCES "app"."runtime_tasks"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."runtime_tasks" ADD CONSTRAINT "runtime_tasks_root_id_runtime_tasks_task_id_fk" FOREIGN KEY ("root_id") REFERENCES "app"."runtime_tasks"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_grants_user_idx" ON "app"."access_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_knowledge_embedding_pass_task_idx" ON "app"."agent_knowledge_embedding" USING btree ("pass_task_id") WHERE "app"."agent_knowledge_embedding"."pass_task_id" is not null;--> statement-breakpoint
CREATE INDEX "agent_knowledge_entities_record_idx" ON "app"."agent_knowledge_entities" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "agent_knowledge_relations_record_idx" ON "app"."agent_knowledge_relations" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "agent_knowledge_relations_from_entity_idx" ON "app"."agent_knowledge_relations" USING btree ("from_entity_id");--> statement-breakpoint
CREATE INDEX "agent_knowledge_relations_to_entity_idx" ON "app"."agent_knowledge_relations" USING btree ("to_entity_id");--> statement-breakpoint
CREATE INDEX "agent_knowledge_runs_record_idx" ON "app"."agent_knowledge_runs" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "agent_knowledge_runs_extract_task_idx" ON "app"."agent_knowledge_runs" USING btree ("extract_task_id") WHERE "app"."agent_knowledge_runs"."extract_task_id" is not null;--> statement-breakpoint
CREATE INDEX "agent_knowledge_runs_last_extract_task_idx" ON "app"."agent_knowledge_runs" USING btree ("last_extract_task_id") WHERE "app"."agent_knowledge_runs"."last_extract_task_id" is not null;--> statement-breakpoint
CREATE INDEX "agent_sessions_owner_record_idx" ON "app"."agent_sessions" USING btree ("owner_id","record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_conversations_root_idx" ON "app"."chat_conversations" USING btree ("root_id");--> statement-breakpoint
CREATE INDEX "chat_conversations_owner_page_idx" ON "app"."chat_conversations" USING btree ("owner_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "chat_drafts_conversation_idx" ON "app"."chat_drafts" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "identity_role_members_user_idx" ON "app"."identity_role_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_roles_name_idx" ON "app"."identity_roles" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "identity_sessions_user_idx" ON "app"."identity_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_users_email_idx" ON "app"."identity_users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_users_login_idx" ON "app"."identity_users" USING btree ("login");--> statement-breakpoint
CREATE UNIQUE INDEX "library_records_owner_name_idx" ON "app"."library_records" USING btree ("owner_id",lower("name")) WHERE "app"."library_records"."owner_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "library_records_system_name_idx" ON "app"."library_records" USING btree (lower("name")) WHERE "app"."library_records"."owner_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "library_records_builtin_key_idx" ON "app"."library_records" USING btree ("builtin_key");--> statement-breakpoint
CREATE INDEX "library_shares_role_idx" ON "app"."library_shares" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "library_shares_user_idx" ON "app"."library_shares" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_decisions_open_task_idx" ON "app"."runtime_decisions" USING btree ("task_id") WHERE "app"."runtime_decisions"."status" = 'open';--> statement-breakpoint
CREATE INDEX "runtime_decisions_task_idx" ON "app"."runtime_decisions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "runtime_decisions_root_idx" ON "app"."runtime_decisions" USING btree ("root_id");--> statement-breakpoint
CREATE INDEX "runtime_event_deliveries_pending_idx" ON "app"."runtime_event_deliveries" USING btree ("next_attempt_at") WHERE "app"."runtime_event_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "runtime_events_root_seq_idx" ON "app"."runtime_events" USING btree ("root_id","seq");--> statement-breakpoint
CREATE INDEX "runtime_inbox_pending_idx" ON "app"."runtime_inbox" USING btree ("recipient_id","seq") WHERE "app"."runtime_inbox"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "runtime_model_calls_owner_called_idx" ON "app"."runtime_model_calls" USING btree ("owner_id","called_at");--> statement-breakpoint
CREATE INDEX "runtime_tasks_ready_idx" ON "app"."runtime_tasks" USING btree ("created_at","task_id") WHERE "app"."runtime_tasks"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "runtime_tasks_lease_idx" ON "app"."runtime_tasks" USING btree ("lease_expires_at") WHERE "app"."runtime_tasks"."status" = 'running';--> statement-breakpoint
CREATE INDEX "runtime_tasks_root_idx" ON "app"."runtime_tasks" USING btree ("root_id");--> statement-breakpoint
CREATE INDEX "runtime_tasks_parent_idx" ON "app"."runtime_tasks" USING btree ("parent_id");--> statement-breakpoint
INSERT INTO "app"."identity_roles" ("name", "is_admin", "builtin") VALUES ('Супер-администратор', true, true);--> statement-breakpoint
INSERT INTO "app"."identity_settings" ("id", "idle_minutes", "absolute_minutes") VALUES (true, 480, 1440);--> statement-breakpoint
INSERT INTO "app"."library_settings" ("id", "default_max_turns") VALUES (true, 40);--> statement-breakpoint
INSERT INTO "app"."access_model_defaults" ("id") VALUES (true);--> statement-breakpoint
INSERT INTO "app"."agent_knowledge_settings" ("id") VALUES (true);