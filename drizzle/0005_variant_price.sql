CREATE TYPE "public"."price_unit" AS ENUM('UNIT', 'BOX', 'PALLET');--> statement-breakpoint
ALTER TABLE "product_variant" ADD COLUMN "price" numeric(14, 4);--> statement-breakpoint
ALTER TABLE "product_variant" ADD COLUMN "price_currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_variant" ADD COLUMN "price_unit" "price_unit" DEFAULT 'UNIT' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_variant" ADD COLUMN "price_updated_at" timestamp with time zone;