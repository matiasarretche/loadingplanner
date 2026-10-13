CREATE TABLE "export_price_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" numeric(12, 4) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer
);
--> statement-breakpoint
CREATE TABLE "transport_company" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"contact" text,
	"phone" text,
	"email" text,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	CONSTRAINT "transport_company_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "family_price_rule" ADD COLUMN "cif_usd_per_kg" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "load_plan" ADD COLUMN "transport_company_id" integer;--> statement-breakpoint
ALTER TABLE "load_plan" ADD COLUMN "freight_usd" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "load_plan" ADD COLUMN "insurance_usd" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "load_plan" ADD COLUMN "payment_terms" jsonb;--> statement-breakpoint
ALTER TABLE "price_quote" ADD COLUMN "incoterm" text;--> statement-breakpoint
ALTER TABLE "price_quote" ADD COLUMN "freight_usd" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "price_quote" ADD COLUMN "insurance_usd" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "price_quote" ADD COLUMN "grand_total_usd" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "price_quote" ADD COLUMN "payment_terms" text;--> statement-breakpoint
ALTER TABLE "price_quote" ADD COLUMN "transport_company" text;--> statement-breakpoint
ALTER TABLE "load_plan" ADD CONSTRAINT "load_plan_transport_company_id_transport_company_id_fk" FOREIGN KEY ("transport_company_id") REFERENCES "public"."transport_company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- recargo CIF padrão (USD/kg líquido), definido pela Pacifil; editável em Preços de exportação
INSERT INTO "export_price_setting" ("key", "value") VALUES ('cif_usd_per_kg', 0.05) ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
-- cotações já emitidas: total geral = mercadoria (não havia frete/seguro)
UPDATE "price_quote" SET "grand_total_usd" = "total_usd" WHERE "grand_total_usd" IS NULL;
