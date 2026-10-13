-- RECARGO CIF SÓ POR FAMÍLIA (definido com o Matías em 13/10/2026): acaba o "recargo CIF padrão" geral
-- (export_price_setting 'cif_usd_per_kg'). Hidrosilo e Hidroforce = USD 0,10/kg líquido; as demais famílias
-- (exceto as "incluídas", ex.: Acessórios, que não têm recargo) = USD 0,05/kg. Família sem valor fica sem
-- preço em cotações CIF. Cada valor que muda vai para o histórico de preços (antes de alterar); idempotente.
-- Valores no histórico como texto do número (0.1, 0.05), igual às alterações feitas pela tela.
INSERT INTO "price_history" ("kind", "family_id", "field", "old_value", "new_value", "user_id")
SELECT 'cif', f."id", 'cifUsdPerKg', r."cif_usd_per_kg"::float8::text,
  (CASE WHEN f."code" IN ('HIDROSILO', 'HYDROFORCE') THEN 0.10 ELSE 0.05 END)::float8::text,
  (SELECT u."id" FROM "app_user" u WHERE u."email" = 'matias@pacifil.com.br')
FROM "product_family" f
LEFT JOIN "family_price_rule" r ON r."family_id" = f."id"
-- sem linha de regra = PER_KG (entra também, recebe a linha abaixo)
WHERE r."method" IS DISTINCT FROM 'INCLUDED'
  AND r."cif_usd_per_kg" IS DISTINCT FROM (CASE WHEN f."code" IN ('HIDROSILO', 'HYDROFORCE') THEN 0.10 ELSE 0.05 END)
ORDER BY f."id";--> statement-breakpoint
UPDATE "family_price_rule" r
SET "cif_usd_per_kg" = CASE WHEN f."code" IN ('HIDROSILO', 'HYDROFORCE') THEN 0.10 ELSE 0.05 END,
  "updated_at" = now(),
  "updated_by" = (SELECT u."id" FROM "app_user" u WHERE u."email" = 'matias@pacifil.com.br')
FROM "product_family" f
WHERE f."id" = r."family_id"
  AND r."method" <> 'INCLUDED'
  AND r."cif_usd_per_kg" IS DISTINCT FROM (CASE WHEN f."code" IN ('HIDROSILO', 'HYDROFORCE') THEN 0.10 ELSE 0.05 END);--> statement-breakpoint
-- família sem linha de regra (só acontece se nunca teve regra/recargo editados; vale PER_KG): cria a linha
-- com o recargo — também para família inativa, que antes cotava CIF pelo padrão geral
INSERT INTO "family_price_rule" ("family_id", "method", "cif_usd_per_kg", "updated_by")
SELECT f."id", 'PER_KG'::"price_method",
  CASE WHEN f."code" IN ('HIDROSILO', 'HYDROFORCE') THEN 0.10 ELSE 0.05 END,
  (SELECT u."id" FROM "app_user" u WHERE u."email" = 'matias@pacifil.com.br')
FROM "product_family" f
WHERE NOT EXISTS (SELECT 1 FROM "family_price_rule" r WHERE r."family_id" = f."id")
ON CONFLICT ("family_id") DO NOTHING;--> statement-breakpoint
-- o padrão geral deixa de existir: registra o valor que tinha e apaga a linha
INSERT INTO "price_history" ("kind", "family_id", "field", "old_value", "new_value", "user_id")
SELECT 'cif_default', NULL, 'cifDefault', s."value"::float8::text, NULL,
  (SELECT u."id" FROM "app_user" u WHERE u."email" = 'matias@pacifil.com.br')
FROM "export_price_setting" s
WHERE s."key" = 'cif_usd_per_kg';--> statement-breakpoint
DELETE FROM "export_price_setting" WHERE "key" = 'cif_usd_per_kg';
