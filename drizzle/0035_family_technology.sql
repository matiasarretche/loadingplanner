ALTER TABLE "product_family" ADD COLUMN "technology" text;--> statement-breakpoint
ALTER TABLE "product_family" ADD COLUMN "technology_display" text;--> statement-breakpoint
-- PACIFIL NXT (definido com o Matías em 12/10/2026): Hidrosilo com SELO + texto; lonas e silo-bolsas só com a
-- menção (texto). Editável depois no Catálogo (Editar família → Tecnologia).
UPDATE "product_family" SET "technology" = 'NXT', "technology_display" = 'SEAL' WHERE "code" = 'HIDROSILO';--> statement-breakpoint
UPDATE "product_family" SET "technology" = 'NXT', "technology_display" = 'MENTION' WHERE "code" IN ('SILO_BAG', 'SILAGE_TARP');
