ALTER TABLE "app"."research_claims" DROP CONSTRAINT "research_claims_status_check";--> statement-breakpoint
ALTER TABLE "app"."research_claims" ADD COLUMN "pointer" jsonb;--> statement-breakpoint
ALTER TABLE "app"."research_claims" ADD COLUMN "claim_type" text;--> statement-breakpoint
ALTER TABLE "app"."research_claims" ADD COLUMN "assessment" jsonb;--> statement-breakpoint
ALTER TABLE "app"."research_claims" ADD COLUMN "confidence" text;--> statement-breakpoint
ALTER TABLE "app"."research_claims" ADD CONSTRAINT "research_claims_status_check" CHECK ("app"."research_claims"."status" in ('unverified', 'supported', 'refuted', 'insufficient', 'causal'));