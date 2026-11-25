CREATE TABLE "app"."runtime_tasks" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"owner_id" uuid,
	"parent_id" uuid,
	"root_id" uuid NOT NULL,
	"depth" integer NOT NULL,
	"input" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"wait_reason" text,
	"step_no" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"recoveries" integer DEFAULT 0 NOT NULL,
	"result" jsonb,
	"failure" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "app"."runtime_tasks_created_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"awaited_step" integer,
	"exclusive_key" text,
	CONSTRAINT "runtime_tasks_status_check" CHECK ("app"."runtime_tasks"."status" in ('queued', 'running', 'waiting', 'completed', 'failed', 'stopped')),
	CONSTRAINT "runtime_tasks_wait_reason_check" CHECK ("app"."runtime_tasks"."wait_reason" in ('messages', 'children', 'human')),
	CONSTRAINT "runtime_tasks_waiting_check" CHECK (("app"."runtime_tasks"."status" = 'waiting') = ("app"."runtime_tasks"."wait_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "app"."runtime_inbox" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"recipient_id" uuid NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "app"."runtime_inbox_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"revive" boolean DEFAULT false NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."runtime_model_calls" (
	"call_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid,
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
CREATE TABLE "app"."conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"parent_id" uuid,
	"owner_id" uuid NOT NULL,
	"start_call_id" text,
	"title" text,
	"updated_at" timestamp with time zone,
	"agent_version_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"model" text NOT NULL,
	"subagent" text,
	"first_run" boolean DEFAULT false NOT NULL,
	"forked_through_seq" integer,
	"forked_from_id" uuid,
	"turns" integer DEFAULT 0 NOT NULL,
	"interrupted" boolean DEFAULT false NOT NULL,
	"closed" boolean DEFAULT false NOT NULL,
	"last_input_tokens" integer,
	"last_task_number" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_start_call_check" CHECK (("app"."conversations"."start_call_id" is not null) = ("app"."conversations"."parent_id" is not null)),
	CONSTRAINT "conversations_root_check" CHECK (("app"."conversations"."title" is not null) = ("app"."conversations"."parent_id" is null) and ("app"."conversations"."updated_at" is not null) = ("app"."conversations"."parent_id" is null)),
	CONSTRAINT "conversations_fork_check" CHECK ("app"."conversations"."forked_from_id" is null or ("app"."conversations"."parent_id" is null and "app"."conversations"."forked_through_seq" is not null))
);
--> statement-breakpoint
CREATE TABLE "app"."messages" (
	"conversation_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"content" jsonb NOT NULL,
	"call_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_conversation_id_seq_pk" PRIMARY KEY("conversation_id","seq"),
	CONSTRAINT "messages_kind_check" CHECK ("app"."messages"."kind" in ('task', 'user_message', 'agent_message', 'child_report', 'model_answer', 'tool_confirmation', 'tool_decision', 'tool_sent', 'run_attempt', 'tool_result', 'notice', 'event', 'compaction')),
	CONSTRAINT "messages_call_id_check" CHECK (("app"."messages"."call_id" is not null) = ("app"."messages"."kind" in ('tool_confirmation', 'tool_decision', 'tool_sent', 'run_attempt', 'tool_result')))
);
--> statement-breakpoint
CREATE TABLE "app"."tool_results" (
	"conversation_id" uuid NOT NULL,
	"call_id" text NOT NULL,
	"value" jsonb NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_results_conversation_id_call_id_pk" PRIMARY KEY("conversation_id","call_id")
);
--> statement-breakpoint
CREATE TABLE "app"."code_calls" (
	"conversation_id" uuid NOT NULL,
	"run_call_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"seq" integer NOT NULL,
	"tool" text NOT NULL,
	"server" text,
	"args" jsonb NOT NULL,
	"outcome" text,
	"refusal_reason" text,
	"finished_at" timestamp with time zone,
	CONSTRAINT "code_calls_conversation_id_run_call_id_attempt_seq_pk" PRIMARY KEY("conversation_id","run_call_id","attempt","seq"),
	CONSTRAINT "code_calls_outcome_check" CHECK ("app"."code_calls"."outcome" in ('success', 'empty', 'tool_error', 'transport_failure', 'refused', 'rejected', 'interrupted', 'unknown', 'auth_required', 'recorded')),
	CONSTRAINT "code_calls_refusal_reason_check" CHECK ("app"."code_calls"."refusal_reason" in ('tool_not_in_definition', 'no_access', 'not_allowed', 'depth_limit', 'model_not_connected', 'model_not_allowed', 'model_not_configured', 'provider_missing', 'provider_disabled', 'provider_key_missing', 'unknown_agent', 'invalid_arguments', 'not_callable_from_code', 'changing_in_read_run', 'not_in_confirmed_script', 'record_unavailable', 'run_limit', 'read_only', 'shared', 'repeated_call', 'admin_only', 'builtin', 'name_taken', 'system_name', 'server_not_allowed', 'all_servers_not_allowed', 'agent_not_visible', 'version_conflict', 'looks_like_secret', 'looks_like_instruction', 'memory_changed'))
);
--> statement-breakpoint
CREATE TABLE "app"."conversation_tasks" (
	"conversation_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"subject" text NOT NULL,
	"description" text NOT NULL,
	"active_form" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"owner" text,
	"blocked_by" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_tasks_conversation_id_number_pk" PRIMARY KEY("conversation_id","number"),
	CONSTRAINT "conversation_tasks_status_check" CHECK ("app"."conversation_tasks"."status" in ('pending', 'in_progress', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "app"."mcp_servers" (
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
	CONSTRAINT "mcp_servers_mode_check" CHECK ("app"."mcp_servers"."mode" in ('shared', 'oauth')),
	CONSTRAINT "mcp_servers_shared_token_check" CHECK (("app"."mcp_servers"."mode" = 'shared') = ("app"."mcp_servers"."shared_token" is not null)),
	CONSTRAINT "mcp_servers_enabled_tools_check" CHECK (not "app"."mcp_servers"."enabled" or "app"."mcp_servers"."tools" is not null),
	CONSTRAINT "mcp_servers_oauth_client_check" CHECK ("app"."mcp_servers"."mode" <> 'oauth' or "app"."mcp_servers"."oauth_client_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "app"."mcp_accounts" (
	"owner_id" uuid NOT NULL,
	"server" text NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"expires_at" timestamp with time zone,
	CONSTRAINT "mcp_accounts_owner_id_server_pk" PRIMARY KEY("owner_id","server")
);
--> statement-breakpoint
CREATE TABLE "app"."model_providers" (
	"name" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"base_url" text,
	"api_key" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_providers_kind_check" CHECK ("app"."model_providers"."kind" in ('anthropic', 'gemini', 'openai_compatible'))
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
	"language" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_users_status_check" CHECK ("app"."identity_users"."status" in ('active', 'disabled')),
	CONSTRAINT "identity_users_language_check" CHECK ("app"."identity_users"."language" in ('en', 'ru'))
);
--> statement-breakpoint
CREATE TABLE "app"."identity_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"train_own" boolean DEFAULT false NOT NULL,
	"train_any" boolean DEFAULT false NOT NULL,
	"builtin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."identity_role_members" (
	"role_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "identity_role_members_role_id_user_id_pk" PRIMARY KEY("role_id","user_id")
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
CREATE TABLE "app"."models" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
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
	CONSTRAINT "models_provider_check" CHECK ("app"."models"."provider" = split_part("app"."models"."id", '/', 1)),
	CONSTRAINT "models_prices_check" CHECK ("app"."models"."input_usd_per_mtok" >= 0 and "app"."models"."output_usd_per_mtok" >= 0
        and "app"."models"."cache_write_usd_per_mtok" >= 0 and "app"."models"."cache_read_usd_per_mtok" >= 0
        and "app"."models"."long_context_input_usd_per_mtok" >= 0 and "app"."models"."long_context_output_usd_per_mtok" >= 0
        and "app"."models"."long_context_cache_write_usd_per_mtok" >= 0 and "app"."models"."long_context_cache_read_usd_per_mtok" >= 0),
	CONSTRAINT "models_long_context_threshold_check" CHECK ("app"."models"."long_context_above_input_tokens" > 0),
	CONSTRAINT "models_long_context_check" CHECK (num_nulls("app"."models"."long_context_above_input_tokens", "app"."models"."long_context_input_usd_per_mtok",
          "app"."models"."long_context_output_usd_per_mtok", "app"."models"."long_context_cache_write_usd_per_mtok",
          "app"."models"."long_context_cache_read_usd_per_mtok") = 0
        or num_nulls("app"."models"."long_context_above_input_tokens", "app"."models"."long_context_input_usd_per_mtok",
          "app"."models"."long_context_output_usd_per_mtok", "app"."models"."long_context_cache_write_usd_per_mtok",
          "app"."models"."long_context_cache_read_usd_per_mtok") = 5),
	CONSTRAINT "models_purpose_check" CHECK ("app"."models"."purpose" in ('chat', 'embedding')),
	CONSTRAINT "models_dimensions_check" CHECK (("app"."models"."purpose" = 'embedding'
          and "app"."models"."dimensions" is not null
          and "app"."models"."dimensions" between 1 and 4096
          and "app"."models"."long_context_above_input_tokens" is null)
        or ("app"."models"."purpose" = 'chat' and "app"."models"."dimensions" is null))
);
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
CREATE TABLE "app"."agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"owner_id" uuid,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"offer_in_chat" boolean DEFAULT false NOT NULL,
	"builtin_key" text,
	"closed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"active_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_kind_check" CHECK ("app"."agents"."kind" in ('agent', 'deep_agent')),
	CONSTRAINT "agents_builtin_key_check" CHECK ("app"."agents"."builtin_key" is null or ("app"."agents"."owner_id" is null and "app"."agents"."builtin_key" in ('chat', 'agent', 'deep_agent', 'trainer'))),
	CONSTRAINT "agents_closed_at_check" CHECK ("app"."agents"."closed_at" is null or "app"."agents"."owner_id" is not null),
	CONSTRAINT "agents_deleted_at_check" CHECK ("app"."agents"."deleted_at" is null or "app"."agents"."builtin_key" is null)
);
--> statement-breakpoint
CREATE TABLE "app"."agent_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"content" jsonb NOT NULL,
	"author_id" uuid,
	"training_id" uuid,
	"changes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_versions_agent_number_key" UNIQUE("agent_id","number"),
	CONSTRAINT "agent_versions_agent_id_key" UNIQUE("agent_id","id")
);
--> statement-breakpoint
CREATE TABLE "app"."agent_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"role_id" uuid,
	"user_id" uuid,
	"everyone" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_shares_agent_holder_key" UNIQUE NULLS NOT DISTINCT("agent_id","role_id","user_id","everyone"),
	CONSTRAINT "agent_shares_holder_check" CHECK (num_nonnulls("app"."agent_shares"."role_id", "app"."agent_shares"."user_id", nullif("app"."agent_shares"."everyone", false)) = 1)
);
--> statement-breakpoint
CREATE TABLE "app"."memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid,
	"user_id" uuid,
	"description" text NOT NULL,
	"current_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memories_owner_check" CHECK (num_nonnulls("app"."memories"."agent_id", "app"."memories"."user_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "app"."memory_versions" (
	"memory_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"text" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"author_id" uuid,
	CONSTRAINT "memory_versions_memory_id_version_pk" PRIMARY KEY("memory_id","version"),
	CONSTRAINT "memory_versions_kind_check" CHECK ("app"."memory_versions"."kind" in ('created', 'changed', 'deleted', 'reverted')),
	CONSTRAINT "memory_versions_text_check" CHECK (("app"."memory_versions"."text" is null) = ("app"."memory_versions"."kind" = 'deleted'))
);
--> statement-breakpoint
CREATE TABLE "app"."documents" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "app"."documents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"conversation_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"text" text NOT NULL,
	"report" boolean NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."trainings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid,
	"base_version_id" uuid,
	"cap_usd" numeric(18, 9) NOT NULL,
	"capped_at" timestamp with time zone,
	"comparisons" jsonb NOT NULL,
	"activated_at" timestamp with time zone,
	"activated_by" uuid,
	"description" text,
	"tests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"plan" jsonb,
	"offered_agent_id" uuid,
	"taken_agent_id" uuid,
	"taken_thread_id" uuid,
	CONSTRAINT "trainings_agent_check" CHECK (("app"."trainings"."agent_id" is null) = ("app"."trainings"."base_version_id" is null))
);
--> statement-breakpoint
CREATE TABLE "app"."schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"instruction" text NOT NULL,
	"agent_id" uuid,
	"rule" jsonb NOT NULL,
	"time_zone" text NOT NULL,
	"language" text NOT NULL,
	"target" text NOT NULL,
	"conversation_id" uuid,
	"state" text NOT NULL,
	"paused_because" text,
	"next_run_at" timestamp with time zone,
	"rule_set_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedules_language_check" CHECK ("app"."schedules"."language" in ('en', 'ru')),
	CONSTRAINT "schedules_target_check" CHECK ("app"."schedules"."target" in ('new_conversation', 'this_conversation')),
	CONSTRAINT "schedules_state_check" CHECK ("app"."schedules"."state" in ('active', 'paused', 'completed')),
	CONSTRAINT "schedules_paused_because_check" CHECK ("app"."schedules"."paused_because" in ('conversation_deleted')),
	CONSTRAINT "schedules_next_run_check" CHECK (("app"."schedules"."next_run_at" is not null) = ("app"."schedules"."state" = 'active')),
	CONSTRAINT "schedules_pause_reason_state_check" CHECK ("app"."schedules"."paused_because" is null or "app"."schedules"."state" = 'paused'),
	CONSTRAINT "schedules_target_conversation_check" CHECK ("app"."schedules"."target" <> 'this_conversation' or "app"."schedules"."conversation_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "app"."schedule_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"schedule_id" uuid NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"manual" boolean DEFAULT false NOT NULL,
	"outcome" text NOT NULL,
	"skip_reason" text,
	"conversation_id" uuid,
	"unfinished_conversation_id" uuid,
	"message_seq" bigint,
	"final_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_runs_outcome_check" CHECK ("app"."schedule_runs"."outcome" in ('starting', 'started', 'skipped')),
	CONSTRAINT "schedule_runs_skip_reason_check" CHECK ("app"."schedule_runs"."skip_reason" in ('previous_run_unfinished', 'conversation_busy', 'owner_disabled', 'agent_unavailable', 'quota_exhausted', 'server_down')),
	CONSTRAINT "schedule_runs_final_status_check" CHECK ("app"."schedule_runs"."final_status" in ('working', 'awaiting_confirmation', 'completed', 'failed', 'stopped')),
	CONSTRAINT "schedule_runs_skip_check" CHECK (("app"."schedule_runs"."skip_reason" is not null) = ("app"."schedule_runs"."outcome" = 'skipped')),
	CONSTRAINT "schedule_runs_conversation_check" CHECK (("app"."schedule_runs"."conversation_id" is not null) = ("app"."schedule_runs"."outcome" = 'started')),
	CONSTRAINT "schedule_runs_final_status_started_check" CHECK ("app"."schedule_runs"."final_status" is null or "app"."schedule_runs"."outcome" = 'started')
);
--> statement-breakpoint
CREATE TABLE "app"."settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone,
	"updated_by" uuid,
	CONSTRAINT "settings_key_check" CHECK ("app"."settings"."key" in ('sign_in_settings', 'library_settings', 'tool_result_settings', 'model_defaults', 'self_learning_settings'))
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
ALTER TABLE "app"."runtime_tasks" ADD CONSTRAINT "runtime_tasks_owner_id_identity_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "app"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."runtime_tasks" ADD CONSTRAINT "runtime_tasks_parent_id_runtime_tasks_task_id_fk" FOREIGN KEY ("parent_id") REFERENCES "app"."runtime_tasks"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."runtime_tasks" ADD CONSTRAINT "runtime_tasks_root_id_runtime_tasks_task_id_fk" FOREIGN KEY ("root_id") REFERENCES "app"."runtime_tasks"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."runtime_inbox" ADD CONSTRAINT "runtime_inbox_recipient_id_runtime_tasks_task_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "app"."runtime_tasks"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."runtime_model_calls" ADD CONSTRAINT "runtime_model_calls_owner_id_identity_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "app"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."runtime_model_calls" ADD CONSTRAINT "runtime_model_calls_task_id_runtime_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "app"."runtime_tasks"("task_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."conversations" ADD CONSTRAINT "conversations_id_runtime_tasks_task_id_fk" FOREIGN KEY ("id") REFERENCES "app"."runtime_tasks"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."conversations" ADD CONSTRAINT "conversations_parent_id_conversations_id_fk" FOREIGN KEY ("parent_id") REFERENCES "app"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."conversations" ADD CONSTRAINT "conversations_owner_id_identity_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "app"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."conversations" ADD CONSTRAINT "conversations_agent_version_id_agent_versions_id_fk" FOREIGN KEY ("agent_version_id") REFERENCES "app"."agent_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."conversations" ADD CONSTRAINT "conversations_forked_from_id_conversations_id_fk" FOREIGN KEY ("forked_from_id") REFERENCES "app"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "app"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tool_results" ADD CONSTRAINT "tool_results_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "app"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."code_calls" ADD CONSTRAINT "code_calls_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "app"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."conversation_tasks" ADD CONSTRAINT "conversation_tasks_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "app"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."mcp_accounts" ADD CONSTRAINT "mcp_accounts_owner_id_identity_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "app"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."mcp_accounts" ADD CONSTRAINT "mcp_accounts_server_mcp_servers_name_fk" FOREIGN KEY ("server") REFERENCES "app"."mcp_servers"("name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."identity_role_members" ADD CONSTRAINT "identity_role_members_role_id_identity_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "app"."identity_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."identity_role_members" ADD CONSTRAINT "identity_role_members_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."identity_login_requests" ADD CONSTRAINT "identity_login_requests_provider_id_identity_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "app"."identity_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."identity_sessions" ADD CONSTRAINT "identity_sessions_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."models" ADD CONSTRAINT "models_provider_model_providers_name_fk" FOREIGN KEY ("provider") REFERENCES "app"."model_providers"("name") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."access_grants" ADD CONSTRAINT "access_grants_role_id_identity_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "app"."identity_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."access_grants" ADD CONSTRAINT "access_grants_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."access_grants" ADD CONSTRAINT "access_grants_server_mcp_servers_name_fk" FOREIGN KEY ("server") REFERENCES "app"."mcp_servers"("name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."access_grants" ADD CONSTRAINT "access_grants_model_models_id_fk" FOREIGN KEY ("model") REFERENCES "app"."models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agents" ADD CONSTRAINT "agents_owner_id_identity_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "app"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agents" ADD CONSTRAINT "agents_active_version_fk" FOREIGN KEY ("id","active_version_id") REFERENCES "app"."agent_versions"("agent_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_versions" ADD CONSTRAINT "agent_versions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "app"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_versions" ADD CONSTRAINT "agent_versions_author_id_identity_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "app"."identity_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_versions" ADD CONSTRAINT "agent_versions_training_id_trainings_id_fk" FOREIGN KEY ("training_id") REFERENCES "app"."trainings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_shares" ADD CONSTRAINT "agent_shares_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "app"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_shares" ADD CONSTRAINT "agent_shares_role_id_identity_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "app"."identity_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_shares" ADD CONSTRAINT "agent_shares_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."memories" ADD CONSTRAINT "memories_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "app"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."memories" ADD CONSTRAINT "memories_user_id_identity_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."memories" ADD CONSTRAINT "memories_current_version_fk" FOREIGN KEY ("id","current_version") REFERENCES "app"."memory_versions"("memory_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."memory_versions" ADD CONSTRAINT "memory_versions_memory_id_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "app"."memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."memory_versions" ADD CONSTRAINT "memory_versions_author_id_identity_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "app"."identity_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."documents" ADD CONSTRAINT "documents_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "app"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."documents" ADD CONSTRAINT "documents_updated_by_conversations_id_fk" FOREIGN KEY ("updated_by") REFERENCES "app"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."trainings" ADD CONSTRAINT "trainings_id_conversations_id_fk" FOREIGN KEY ("id") REFERENCES "app"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."trainings" ADD CONSTRAINT "trainings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "app"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."trainings" ADD CONSTRAINT "trainings_base_version_id_agent_versions_id_fk" FOREIGN KEY ("base_version_id") REFERENCES "app"."agent_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."trainings" ADD CONSTRAINT "trainings_activated_by_identity_users_id_fk" FOREIGN KEY ("activated_by") REFERENCES "app"."identity_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."trainings" ADD CONSTRAINT "trainings_offered_agent_id_agents_id_fk" FOREIGN KEY ("offered_agent_id") REFERENCES "app"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."trainings" ADD CONSTRAINT "trainings_taken_agent_id_agents_id_fk" FOREIGN KEY ("taken_agent_id") REFERENCES "app"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."trainings" ADD CONSTRAINT "trainings_taken_thread_id_conversations_id_fk" FOREIGN KEY ("taken_thread_id") REFERENCES "app"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."schedules" ADD CONSTRAINT "schedules_owner_id_identity_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "app"."identity_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."schedules" ADD CONSTRAINT "schedules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "app"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."schedules" ADD CONSTRAINT "schedules_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "app"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."schedule_runs" ADD CONSTRAINT "schedule_runs_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "app"."schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."schedule_runs" ADD CONSTRAINT "schedule_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "app"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."schedule_runs" ADD CONSTRAINT "schedule_runs_unfinished_conversation_id_conversations_id_fk" FOREIGN KEY ("unfinished_conversation_id") REFERENCES "app"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."settings" ADD CONSTRAINT "settings_updated_by_identity_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "app"."identity_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runtime_tasks_ready_idx" ON "app"."runtime_tasks" USING btree ("created_at","task_id") WHERE "app"."runtime_tasks"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "runtime_tasks_root_idx" ON "app"."runtime_tasks" USING btree ("root_id");--> statement-breakpoint
CREATE INDEX "runtime_tasks_parent_idx" ON "app"."runtime_tasks" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_tasks_exclusive_key_idx" ON "app"."runtime_tasks" USING btree ("type","exclusive_key") WHERE "app"."runtime_tasks"."exclusive_key" is not null and "app"."runtime_tasks"."status" in ('queued', 'running', 'waiting');--> statement-breakpoint
CREATE INDEX "runtime_inbox_pending_idx" ON "app"."runtime_inbox" USING btree ("recipient_id","seq") WHERE "app"."runtime_inbox"."delivered_at" is null;--> statement-breakpoint
CREATE INDEX "runtime_model_calls_owner_called_idx" ON "app"."runtime_model_calls" USING btree ("owner_id","called_at");--> statement-breakpoint
CREATE INDEX "runtime_model_calls_task_idx" ON "app"."runtime_model_calls" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "conversations_owner_version_idx" ON "app"."conversations" USING btree ("owner_id","agent_version_id");--> statement-breakpoint
CREATE INDEX "conversations_agent_version_idx" ON "app"."conversations" USING btree ("agent_version_id");--> statement-breakpoint
CREATE INDEX "conversations_parent_idx" ON "app"."conversations" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "conversations_forked_from_idx" ON "app"."conversations" USING btree ("forked_from_id");--> statement-breakpoint
CREATE INDEX "conversations_owner_page_idx" ON "app"."conversations" USING btree ("owner_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "app"."conversations"."parent_id" IS NULL;--> statement-breakpoint
CREATE INDEX "conversations_title_search_idx" ON "app"."conversations" USING gin (to_tsvector('russian'::regconfig, left("title", 100000))) WHERE "app"."conversations"."parent_id" IS NULL;--> statement-breakpoint
CREATE INDEX "messages_call_idx" ON "app"."messages" USING btree ("conversation_id","call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_call_once_idx" ON "app"."messages" USING btree ("conversation_id","call_id","kind") WHERE "app"."messages"."kind" in ('tool_confirmation', 'tool_decision', 'tool_sent', 'tool_result');--> statement-breakpoint
CREATE INDEX "messages_text_search_idx" ON "app"."messages" USING gin (to_tsvector('russian'::regconfig, left(("content" ->> 'text'), 100000))) WHERE "app"."messages"."kind" in ('task', 'user_message', 'agent_message', 'model_answer', 'tool_result');--> statement-breakpoint
CREATE INDEX "tool_results_text_search_idx" ON "app"."tool_results" USING gin (to_tsvector('russian'::regconfig, left("text", 100000)));--> statement-breakpoint
CREATE UNIQUE INDEX "identity_users_email_idx" ON "app"."identity_users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_users_login_idx" ON "app"."identity_users" USING btree ("login");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_roles_name_idx" ON "app"."identity_roles" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "identity_role_members_user_idx" ON "app"."identity_role_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "identity_sessions_user_idx" ON "app"."identity_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "access_grants_user_idx" ON "app"."access_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "access_grants_server_idx" ON "app"."access_grants" USING btree ("server");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_owner_name_idx" ON "app"."agents" USING btree ("owner_id",lower("name")) WHERE "app"."agents"."owner_id" is not null and "app"."agents"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_system_name_idx" ON "app"."agents" USING btree (lower("name")) WHERE "app"."agents"."owner_id" is null and "app"."agents"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_builtin_key_idx" ON "app"."agents" USING btree ("builtin_key");--> statement-breakpoint
CREATE INDEX "agent_versions_training_idx" ON "app"."agent_versions" USING btree ("training_id");--> statement-breakpoint
CREATE INDEX "agent_shares_role_idx" ON "app"."agent_shares" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "agent_shares_user_idx" ON "app"."agent_shares" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memories_agent_description_idx" ON "app"."memories" USING btree ("agent_id","description");--> statement-breakpoint
CREATE UNIQUE INDEX "memories_user_description_idx" ON "app"."memories" USING btree ("user_id","description");--> statement-breakpoint
CREATE INDEX "documents_conversation_idx" ON "app"."documents" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "documents_updated_by_idx" ON "app"."documents" USING btree ("updated_by");--> statement-breakpoint
CREATE INDEX "trainings_agent_idx" ON "app"."trainings" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "trainings_base_version_idx" ON "app"."trainings" USING btree ("base_version_id");--> statement-breakpoint
CREATE INDEX "trainings_activated_by_idx" ON "app"."trainings" USING btree ("activated_by");--> statement-breakpoint
CREATE INDEX "trainings_offered_agent_idx" ON "app"."trainings" USING btree ("offered_agent_id");--> statement-breakpoint
CREATE INDEX "trainings_taken_agent_idx" ON "app"."trainings" USING btree ("taken_agent_id");--> statement-breakpoint
CREATE INDEX "trainings_taken_thread_idx" ON "app"."trainings" USING btree ("taken_thread_id");--> statement-breakpoint
CREATE INDEX "schedules_owner_idx" ON "app"."schedules" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "schedules_agent_idx" ON "app"."schedules" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "schedules_conversation_idx" ON "app"."schedules" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "schedules_due_idx" ON "app"."schedules" USING btree ("next_run_at") WHERE "app"."schedules"."state" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_runs_term_idx" ON "app"."schedule_runs" USING btree ("schedule_id","due_at") WHERE not "app"."schedule_runs"."manual";--> statement-breakpoint
CREATE INDEX "schedule_runs_page_idx" ON "app"."schedule_runs" USING btree ("schedule_id","due_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "schedule_runs_starting_idx" ON "app"."schedule_runs" USING btree ("id") WHERE "app"."schedule_runs"."outcome" = 'starting';--> statement-breakpoint
CREATE INDEX "schedule_runs_conversation_idx" ON "app"."schedule_runs" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "schedule_runs_unfinished_conversation_idx" ON "app"."schedule_runs" USING btree ("unfinished_conversation_id");