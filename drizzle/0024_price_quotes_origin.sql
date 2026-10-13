ALTER TABLE "price_quote" DROP CONSTRAINT "price_quote_version_signature";--> statement-breakpoint
ALTER TABLE "price_quote" ALTER COLUMN "load_plan_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "price_quote" ALTER COLUMN "load_plan_version_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "price_quote" ALTER COLUMN "version" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "price_quote" ADD COLUMN "origin" text DEFAULT 'load' NOT NULL;--> statement-breakpoint
ALTER TABLE "price_quote" ADD COLUMN "reference" text;--> statement-breakpoint
ALTER TABLE "price_quote" ADD CONSTRAINT "price_quote_version_signature" UNIQUE NULLS NOT DISTINCT("load_plan_version_id","signature");