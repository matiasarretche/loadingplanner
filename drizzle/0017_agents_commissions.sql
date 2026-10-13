CREATE TABLE "agent" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"country" text,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer
);
--> statement-breakpoint
CREATE TABLE "commission_rate" (
	"id" serial PRIMARY KEY NOT NULL,
	"agent_id" integer,
	"family_id" integer NOT NULL,
	"category_id" integer NOT NULL,
	"pct" numeric(8, 4) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	CONSTRAINT "commission_rate_unique" UNIQUE NULLS NOT DISTINCT("agent_id","family_id","category_id")
);
--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "agent_id" integer;--> statement-breakpoint
ALTER TABLE "commission_rate" ADD CONSTRAINT "commission_rate_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rate" ADD CONSTRAINT "commission_rate_family_id_product_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."product_family"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_rate" ADD CONSTRAINT "commission_rate_category_id_price_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."price_category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE no action ON UPDATE no action;