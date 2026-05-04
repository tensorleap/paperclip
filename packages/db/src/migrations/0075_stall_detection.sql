ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "system_author" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "stall_policy" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_log_entity_action_idx" ON "activity_log" USING btree ("entity_type","entity_id","action","created_at");
