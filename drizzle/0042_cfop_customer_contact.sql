-- CFOP da operação no pedido (shipment.cfop, digitado ao criar a carga) e contato do cliente (nome, e-mail, telefone).
-- Matías, 29/10/2026. Só acrescenta colunas: nada é apagado nem alterado.
ALTER TABLE "customer" ADD COLUMN "contact_name" text;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "contact_email" text;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "contact_phone" text;--> statement-breakpoint
ALTER TABLE "shipment" ADD COLUMN "cfop" text;