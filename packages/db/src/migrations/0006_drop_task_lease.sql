DROP INDEX "app"."runtime_tasks_lease_idx";--> statement-breakpoint
ALTER TABLE "app"."runtime_tasks" DROP COLUMN "lease_expires_at";