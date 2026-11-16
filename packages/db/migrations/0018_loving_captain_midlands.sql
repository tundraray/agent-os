CREATE TABLE "app"."agent_mcp_accounts" (
	"owner_id" text NOT NULL,
	"server" text NOT NULL,
	"token_type" text NOT NULL,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"expires_at" timestamp with time zone,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"refreshed_at" timestamp with time zone,
	CONSTRAINT "agent_mcp_accounts_owner_id_server_pk" PRIMARY KEY("owner_id","server"),
	CONSTRAINT "agent_mcp_accounts_token_type_check" CHECK ("app"."agent_mcp_accounts"."token_type" in ('oauth'))
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
ALTER TABLE "app"."agent_code_calls" DROP CONSTRAINT "agent_code_calls_outcome_check";--> statement-breakpoint
ALTER TABLE "app"."agent_tool_calls" DROP CONSTRAINT "agent_tool_calls_outcome_check";--> statement-breakpoint
ALTER TABLE "app"."agent_mcp_accounts" ADD CONSTRAINT "agent_mcp_accounts_server_agent_mcp_servers_name_fk" FOREIGN KEY ("server") REFERENCES "app"."agent_mcp_servers"("name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."agent_code_calls" ADD CONSTRAINT "agent_code_calls_outcome_check" CHECK ("app"."agent_code_calls"."outcome" in ('success', 'empty', 'tool_error', 'transport_failure', 'refused', 'rejected', 'interrupted', 'unknown', 'auth_required'));--> statement-breakpoint
ALTER TABLE "app"."agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_outcome_check" CHECK ("app"."agent_tool_calls"."outcome" in ('success', 'empty', 'tool_error', 'transport_failure', 'refused', 'rejected', 'interrupted', 'unknown', 'auth_required'));