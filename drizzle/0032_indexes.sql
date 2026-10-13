-- Índices secundários (consultas por carga, pedido, cliente, fotos, conversas, auditoria, cotações)
CREATE INDEX IF NOT EXISTS "load_plan_shipment_idx" ON "load_plan" ("shipment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "load_plan_version_plan_idx" ON "load_plan_version" ("load_plan_id", "version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "load_plan_version_status_idx" ON "load_plan_version" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shipment_customer_area_idx" ON "shipment" ("customer_id", "area");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "load_photo_plan_idx" ON "load_photo" ("load_plan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_entity_idx" ON "audit_log" ("entity", "entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "price_quote_plan_idx" ON "price_quote" ("load_plan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "packaging_version_variant_idx" ON "packaging_version" ("variant_id");
