ALTER TABLE "app"."research_engine_runs" DROP COLUMN "source_snapshots";--> statement-breakpoint
ALTER TABLE "app"."research_engine_runs" ADD COLUMN "source_catalog" jsonb DEFAULT '[]'::jsonb NOT NULL;
