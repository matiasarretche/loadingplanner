CREATE TABLE "price_quote" (
	"id" serial PRIMARY KEY NOT NULL,
	"load_plan_id" integer NOT NULL,
	"load_plan_version_id" integer NOT NULL,
	"version" integer NOT NULL,
	"plan_name" text NOT NULL,
	"customer_id" integer,
	"customer_name" text,
	"order_ref" text,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"country" text,
	"category" text,
	"agent_id" integer,
	"agent_name" text,
	"total_usd" numeric(14, 2),
	"commission_usd" numeric(14, 2),
	"lines" jsonb NOT NULL,
	"signature" text NOT NULL,
	"lang" text,
	"first_issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issue_count" integer DEFAULT 1 NOT NULL,
	"created_by" integer,
	"last_issued_by" integer,
	CONSTRAINT "price_quote_version_signature" UNIQUE("load_plan_version_id","signature")
);
--> statement-breakpoint
ALTER TABLE "price_quote" ADD CONSTRAINT "price_quote_load_plan_id_load_plan_id_fk" FOREIGN KEY ("load_plan_id") REFERENCES "public"."load_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_quote" ADD CONSTRAINT "price_quote_load_plan_version_id_load_plan_version_id_fk" FOREIGN KEY ("load_plan_version_id") REFERENCES "public"."load_plan_version"("id") ON DELETE no action ON UPDATE no action;