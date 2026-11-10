CREATE TABLE "app"."chat_thread_runs" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "chat_thread_runs_thread_id_check" CHECK ("app"."chat_thread_runs"."thread_id" <> '')
);
--> statement-breakpoint
ALTER TABLE "app"."research_investigations" DROP CONSTRAINT "research_investigations_status_check";--> statement-breakpoint
CREATE INDEX "chat_thread_runs_thread_idx" ON "app"."chat_thread_runs" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "chat_thread_runs_lease_idx" ON "app"."chat_thread_runs" USING btree ("lease_expires_at");--> statement-breakpoint
ALTER TABLE "app"."research_investigations" ADD CONSTRAINT "research_investigations_status_check" CHECK ("app"."research_investigations"."status" in ('active', 'completed', 'failed', 'cancelled', 'deleting'));--> statement-breakpoint
-- Close investigations that finished before this update by the status of their controller task
-- (design-lifecycle.md, Data Model; ADR-0006). Shells without a controller task stay `active`
-- for the start retry; no task row is touched.
UPDATE "app"."research_investigations" AS "investigation"
   SET "status" = CASE "controller"."status" WHEN 'succeeded' THEN 'completed' ELSE "controller"."status" END,
       "updated_at" = now()
  FROM "app"."research_engine_runs" AS "run"
  JOIN "app"."research_tasks" AS "controller" ON "controller"."task_id" = "run"."controller_task_id"
 WHERE "run"."investigation_id" = "investigation"."investigation_id"
   AND "controller"."investigation_id" = "investigation"."investigation_id"
   AND "investigation"."status" = 'active'
   AND "controller"."status" IN ('succeeded', 'failed', 'cancelled');
