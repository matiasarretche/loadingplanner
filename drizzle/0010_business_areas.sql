CREATE TYPE "public"."business_area" AS ENUM('EXPORT', 'DOMESTIC');--> statement-breakpoint
ALTER TABLE "shipment" ADD COLUMN "area" "business_area" DEFAULT 'EXPORT' NOT NULL;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "areas" "business_area"[] DEFAULT '{"EXPORT"}' NOT NULL;