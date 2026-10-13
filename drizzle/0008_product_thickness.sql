ALTER TABLE "product_variant" ADD COLUMN "thickness_um" integer;--> statement-breakpoint
-- espessura já cadastrada nos atributos passa para o campo próprio (só valores numéricos > 0; nada é inventado)
UPDATE "product_variant" SET "thickness_um" = round(replace("attrs"->>'espessura_um', ',', '.')::numeric)::int WHERE ("attrs"->>'espessura_um') ~ '^[0-9]+([.,][0-9]+)?$' AND replace("attrs"->>'espessura_um', ',', '.')::numeric > 0;--> statement-breakpoint
-- remove dos atributos só o que foi movido (ou vazio); valores não numéricos ficam para revisão manual
UPDATE "product_variant" SET "attrs" = "attrs" - 'espessura_um' WHERE "attrs" ? 'espessura_um' AND ("thickness_um" IS NOT NULL OR coalesce("attrs"->>'espessura_um', '') = '');
