CREATE TABLE "app"."runtime_trackers" (
	"tracker_id" uuid PRIMARY KEY NOT NULL,
	"task_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "runtime_trackers_status_check" CHECK ("app"."runtime_trackers"."status" in ('open', 'finished'))
);
--> statement-breakpoint
ALTER TABLE "app"."runtime_tasks" DROP CONSTRAINT "runtime_tasks_wait_reason_check";--> statement-breakpoint
ALTER TABLE "app"."runtime_tasks" ADD COLUMN "tracker_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."runtime_trackers" ADD CONSTRAINT "runtime_trackers_task_id_runtime_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "app"."runtime_tasks"("task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_trackers_open_task_idx" ON "app"."runtime_trackers" USING btree ("task_id") WHERE "app"."runtime_trackers"."status" = 'open';--> statement-breakpoint
CREATE INDEX "runtime_trackers_task_idx" ON "app"."runtime_trackers" USING btree ("task_id");--> statement-breakpoint
ALTER TABLE "app"."runtime_tasks" ADD CONSTRAINT "runtime_tasks_tracker_id_runtime_trackers_tracker_id_fk" FOREIGN KEY ("tracker_id") REFERENCES "app"."runtime_trackers"("tracker_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runtime_tasks_tracker_idx" ON "app"."runtime_tasks" USING btree ("tracker_id");--> statement-breakpoint
ALTER TABLE "app"."runtime_tasks" ADD CONSTRAINT "runtime_tasks_wait_reason_check" CHECK ("app"."runtime_tasks"."wait_reason" in ('messages', 'decision', 'interrupted', 'tasks'));