ALTER TYPE "public"."transport_mode" ADD VALUE 'AIR';--> statement-breakpoint
ALTER TABLE "container_type" ADD COLUMN "transport_mode" "transport_mode" DEFAULT 'SEA' NOT NULL;