-- IMPORTAÇÃO DO CATÁLOGO OFICIAL (definida com o Matías em 13/10/2026). Só acréscimos, nada é apagado:
-- • product_variant.ean / ean_status: código de barras da planilha oficial como TEXTO (nunca número) e a
--   validade dele (EAN13 válido, GTIN14 = código da caixa, INVALID); null = sem EAN.
-- • catalog_import: cada envio das planilhas (Manutenção) gera uma prévia com o plano completo; aplicar grava o
--   catálogo e depois atualiza as montagens de palete. Histórico das importações (quem, quando, arquivos, sha256).
CREATE TABLE "catalog_import" (
	"id" serial PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'PREVIEW' NOT NULL,
	"engine_version" text NOT NULL,
	"products_file" text NOT NULL,
	"products_sha256" text NOT NULL,
	"boxes_file" text NOT NULL,
	"boxes_sha256" text NOT NULL,
	"catalog_fingerprint" text NOT NULL,
	"plan" jsonb NOT NULL,
	"summary" jsonb NOT NULL,
	"result" jsonb,
	"sync_report" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	"applied_at" timestamp with time zone,
	"applied_by" integer,
	"synced_at" timestamp with time zone,
	CONSTRAINT "catalog_import_status_chk" CHECK ("catalog_import"."status" IN ('PREVIEW','APPLIED','SYNCING','SYNCED','SYNC_FAILED','DISCARDED','SUPERSEDED'))
);
--> statement-breakpoint
ALTER TABLE "product_variant" ADD COLUMN "ean" text;--> statement-breakpoint
ALTER TABLE "product_variant" ADD COLUMN "ean_status" text;--> statement-breakpoint
ALTER TABLE "catalog_import" ADD CONSTRAINT "catalog_import_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_import" ADD CONSTRAINT "catalog_import_applied_by_app_user_id_fk" FOREIGN KEY ("applied_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "catalog_import_created_idx" ON "catalog_import" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "product_variant_ean_idx" ON "product_variant" USING btree ("ean");--> statement-breakpoint
ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_ean_status_chk" CHECK ("product_variant"."ean_status" IS NULL OR "product_variant"."ean_status" IN ('EAN13','GTIN14','INVALID'));