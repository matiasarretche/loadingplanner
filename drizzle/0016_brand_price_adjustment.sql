CREATE TABLE "brand_price_adjustment" (
	"brand" text PRIMARY KEY NOT NULL,
	"pct" numeric(8, 4) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer
);
