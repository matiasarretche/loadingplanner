CREATE TYPE "public"."shipment_service" AS ENUM('FCL', 'ROAD', 'AIR_ULD', 'LCL', 'AIR_LOOSE', 'PALLETS_ONLY', 'COURIER');--> statement-breakpoint
ALTER TYPE "public"."space_kind" ADD VALUE 'NONE';--> statement-breakpoint
ALTER TABLE "shipment" ALTER COLUMN "mode" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shipment" ADD COLUMN "service" "shipment_service" DEFAULT 'FCL' NOT NULL;--> statement-breakpoint
UPDATE "shipment" SET "service" = CASE "mode" WHEN 'ROAD' THEN 'ROAD'::"shipment_service" WHEN 'AIR' THEN 'AIR_ULD'::"shipment_service" ELSE 'FCL'::"shipment_service" END;
