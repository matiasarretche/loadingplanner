ALTER TABLE "customer" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "shipment" ADD COLUMN "origin_place" text;--> statement-breakpoint
ALTER TABLE "shipment" ADD COLUMN "destination_place" text;--> statement-breakpoint
ALTER TABLE "shipment" ADD COLUMN "customer_address" text;