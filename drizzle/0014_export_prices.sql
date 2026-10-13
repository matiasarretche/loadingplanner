CREATE TYPE "public"."price_method" AS ENUM('PER_KG', 'PER_KG_PLUS_FIXED', 'INCLUDED');--> statement-breakpoint
CREATE TABLE "country_price_category" (
	"country_code" text PRIMARY KEY NOT NULL,
	"category_id" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer
);
--> statement-breakpoint
CREATE TABLE "family_price_rule" (
	"family_id" integer PRIMARY KEY NOT NULL,
	"method" "price_method" DEFAULT 'PER_KG' NOT NULL,
	"notes" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer
);
--> statement-breakpoint
CREATE TABLE "family_price" (
	"id" serial PRIMARY KEY NOT NULL,
	"family_id" integer NOT NULL,
	"category_id" integer NOT NULL,
	"usd_per_kg" numeric(12, 4),
	"fixed_usd_per_unit" numeric(12, 4),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	CONSTRAINT "family_price_unique" UNIQUE("family_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "price_category" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	CONSTRAINT "price_category_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "price_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"family_id" integer,
	"category_id" integer,
	"country_code" text,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"user_id" integer,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "country_price_category" ADD CONSTRAINT "country_price_category_category_id_price_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."price_category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_price_rule" ADD CONSTRAINT "family_price_rule_family_id_product_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."product_family"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_price" ADD CONSTRAINT "family_price_family_id_product_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."product_family"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_price" ADD CONSTRAINT "family_price_category_id_price_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."price_category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- categorias definidas pela Pacifil (editáveis na interface); nenhum preço é pré-carregado
INSERT INTO "price_category" ("code", "name", "sort") VALUES ('UY', 'Uruguai', 0), ('A', 'Categoria A', 1), ('B', 'Categoria B', 2), ('C', 'Categoria C', 3) ON CONFLICT ("code") DO NOTHING;--> statement-breakpoint
-- regras: Hidrosilo e Hidroforce = USD/kg + fixo por unidade (válvulas); Acessórios (KIT-HF) = incluído no fixo; demais = USD/kg
INSERT INTO "family_price_rule" ("family_id", "method") SELECT "id", (CASE WHEN "code" IN ('HIDROSILO', 'HYDROFORCE') THEN 'PER_KG_PLUS_FIXED' WHEN "code" = 'ACCESSORY' THEN 'INCLUDED' ELSE 'PER_KG' END)::"price_method" FROM "product_family" ON CONFLICT ("family_id") DO NOTHING;
