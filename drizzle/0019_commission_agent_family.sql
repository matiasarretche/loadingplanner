ALTER TABLE "commission_rate" DROP CONSTRAINT "commission_rate_unique";--> statement-breakpoint
ALTER TABLE "commission_rate" DROP CONSTRAINT "commission_rate_category_id_price_category_id_fk";
--> statement-breakpoint
ALTER TABLE "commission_rate" ALTER COLUMN "agent_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "commission_rate" DROP COLUMN "category_id";--> statement-breakpoint
ALTER TABLE "commission_rate" ADD CONSTRAINT "commission_rate_agent_family" UNIQUE("agent_id","family_id");