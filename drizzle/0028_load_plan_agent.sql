ALTER TABLE "load_plan" ADD COLUMN "agent_id" integer;--> statement-breakpoint
ALTER TABLE "load_plan" ADD CONSTRAINT "load_plan_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
UPDATE "load_plan" lp SET "agent_id" = c."agent_id" FROM "shipment" s JOIN "customer" c ON c."id" = s."customer_id" WHERE s."id" = lp."shipment_id" AND c."agent_id" IS NOT NULL;
