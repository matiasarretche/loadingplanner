ALTER TABLE "customer" ADD COLUMN "edit_lock_by" integer;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "edit_lock_at" timestamp with time zone;