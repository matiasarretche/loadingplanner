ALTER TABLE "load_plan" ADD COLUMN "edit_lock_by" integer;--> statement-breakpoint
ALTER TABLE "load_plan" ADD COLUMN "edit_lock_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer" DROP COLUMN "edit_lock_by";--> statement-breakpoint
ALTER TABLE "customer" DROP COLUMN "edit_lock_at";