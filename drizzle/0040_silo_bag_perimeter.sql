-- Perímetro REAL de fabricação do silo-bolsa por diâmetro (definido com o Matías em 14/10/2026):
-- peso líquido = perímetro real × comprimento × espessura × 0,932 g/cm³ (src/domain/siloPerimeter.ts).
-- Os três diâmetros já definidos entram aqui; o recálculo dos pesos é feito pela tela (Catálogo → Silo-bolsa →
-- "Editar família" → "Salvar perímetros e recalcular pesos"), que cria as novas versões de embalagem.
CREATE TABLE "family_perimeter" (
	"id" serial PRIMARY KEY NOT NULL,
	"family_id" integer NOT NULL,
	"diameter_ft" numeric(6, 2) NOT NULL,
	"perimeter_m" numeric(8, 3) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	CONSTRAINT "family_perimeter_unique" UNIQUE("family_id","diameter_ft"),
	CONSTRAINT "family_perimeter_positive" CHECK ("family_perimeter"."perimeter_m" > 0)
);
--> statement-breakpoint
ALTER TABLE "family_perimeter" ADD CONSTRAINT "family_perimeter_family_id_product_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."product_family"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "family_perimeter" ("family_id", "diameter_ft", "perimeter_m")
SELECT f."id", v.d, v.p FROM "product_family" f CROSS JOIN (VALUES (6.00, 5.750), (9.00, 8.700), (10.00, 9.650)) AS v(d, p)
WHERE f."code" = 'SILO_BAG'
ON CONFLICT DO NOTHING;
