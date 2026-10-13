-- medidas do produto passam dos atributos para campos próprios (só valores numéricos > 0; nada é inventado nem convertido)
ALTER TABLE "product_variant" ADD COLUMN "diameter_ft" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "product_variant" ADD COLUMN "width_m" numeric(8, 3);--> statement-breakpoint
ALTER TABLE "product_variant" ADD COLUMN "length_m" numeric(8, 3);--> statement-breakpoint
ALTER TABLE "product_variant" ADD COLUMN "length_ft" numeric(8, 2);--> statement-breakpoint
UPDATE "product_variant" SET "diameter_ft" = replace("attrs"->>'diametro_ft', ',', '.')::numeric WHERE ("attrs"->>'diametro_ft') ~ '^[0-9]+([.,][0-9]+)?$' AND replace("attrs"->>'diametro_ft', ',', '.')::numeric > 0;--> statement-breakpoint
UPDATE "product_variant" SET "attrs" = "attrs" - 'diametro_ft' WHERE "attrs" ? 'diametro_ft' AND ("diameter_ft" IS NOT NULL OR coalesce("attrs"->>'diametro_ft', '') = '');
--> statement-breakpoint
UPDATE "product_variant" SET "width_m" = replace("attrs"->>'largura_m', ',', '.')::numeric WHERE ("attrs"->>'largura_m') ~ '^[0-9]+([.,][0-9]+)?$' AND replace("attrs"->>'largura_m', ',', '.')::numeric > 0;--> statement-breakpoint
UPDATE "product_variant" SET "attrs" = "attrs" - 'largura_m' WHERE "attrs" ? 'largura_m' AND ("width_m" IS NOT NULL OR coalesce("attrs"->>'largura_m', '') = '');
--> statement-breakpoint
UPDATE "product_variant" SET "length_m" = replace("attrs"->>'comprimento_m', ',', '.')::numeric WHERE ("attrs"->>'comprimento_m') ~ '^[0-9]+([.,][0-9]+)?$' AND replace("attrs"->>'comprimento_m', ',', '.')::numeric > 0;--> statement-breakpoint
UPDATE "product_variant" SET "attrs" = "attrs" - 'comprimento_m' WHERE "attrs" ? 'comprimento_m' AND ("length_m" IS NOT NULL OR coalesce("attrs"->>'comprimento_m', '') = '');
--> statement-breakpoint
UPDATE "product_variant" SET "length_ft" = replace("attrs"->>'comprimento_ft', ',', '.')::numeric WHERE ("attrs"->>'comprimento_ft') ~ '^[0-9]+([.,][0-9]+)?$' AND replace("attrs"->>'comprimento_ft', ',', '.')::numeric > 0;--> statement-breakpoint
UPDATE "product_variant" SET "attrs" = "attrs" - 'comprimento_ft' WHERE "attrs" ? 'comprimento_ft' AND ("length_ft" IS NOT NULL OR coalesce("attrs"->>'comprimento_ft', '') = '');
