CREATE TABLE "family_band_price" (
	"id" serial PRIMARY KEY NOT NULL,
	"family_id" integer NOT NULL,
	"category_id" integer NOT NULL,
	"band_key" text NOT NULL,
	"usd_per_kg" numeric(12, 4),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	CONSTRAINT "family_band_price_unique" UNIQUE("family_id","category_id","band_key")
);
--> statement-breakpoint
CREATE TABLE "family_price_band" (
	"id" serial PRIMARY KEY NOT NULL,
	"family_id" integer NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"min_ft" numeric(6, 2) NOT NULL,
	"max_ft" numeric(6, 2) NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "family_price_band_unique" UNIQUE("family_id","key")
);
--> statement-breakpoint
ALTER TABLE "family_band_price" ADD CONSTRAINT "family_band_price_family_id_product_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."product_family"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_band_price" ADD CONSTRAINT "family_band_price_category_id_price_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."price_category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_price_band" ADD CONSTRAINT "family_price_band_family_id_product_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."product_family"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Silo-bolsa: USD/kg por faixa de diâmetro (5 a 8 pés, 9 a 12 pés, 14 pés). Começa com o USD/kg atual da família
-- em cada categoria (nenhum preço muda até o usuário definir os novos valores).
INSERT INTO "family_price_band" ("family_id", "key", "label", "min_ft", "max_ft", "sort")
SELECT f."id", b."key", b."label", b."min_ft", b."max_ft", b."sort"
FROM "product_family" f
CROSS JOIN (VALUES ('5-8', '5 a 8 pés', 5, 8, 1), ('9-12', '9 a 12 pés', 9, 12, 2), ('14', '14 pés', 14, 14, 3)) AS b("key", "label", "min_ft", "max_ft", "sort")
WHERE f."name" = 'Silo-bolsa'
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "family_band_price" ("family_id", "category_id", "band_key", "usd_per_kg", "updated_at", "updated_by")
SELECT fp."family_id", fp."category_id", b."key", fp."usd_per_kg", fp."updated_at", fp."updated_by"
FROM "family_price" fp
JOIN "family_price_band" b ON b."family_id" = fp."family_id"
WHERE fp."usd_per_kg" IS NOT NULL
ON CONFLICT DO NOTHING;
