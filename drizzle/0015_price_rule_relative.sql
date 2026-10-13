ALTER TYPE "public"."price_method" ADD VALUE 'RELATIVE';--> statement-breakpoint
ALTER TABLE "family_price_rule" ADD COLUMN "ref_family_id" integer;--> statement-breakpoint
ALTER TABLE "family_price_rule" ADD COLUMN "markup_pct" numeric(8, 4);--> statement-breakpoint
ALTER TABLE "family_price_rule" ADD CONSTRAINT "family_price_rule_ref_family_id_product_family_id_fk" FOREIGN KEY ("ref_family_id") REFERENCES "public"."product_family"("id") ON DELETE no action ON UPDATE no action;