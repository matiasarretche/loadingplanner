-- Cliente com o endereço em campos (Matías, 16/10/2026: cadastro da carteira real de clientes de exportação):
-- código do ERP (único; nulo nos clientes criados pela tela), estado/província, bairro, código postal e complemento.
-- "address" continua sendo a rua e o número. Só acrescenta colunas: nada é apagado nem alterado.
ALTER TABLE "customer" ADD COLUMN "code" text;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "district" text;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "postal_code" text;--> statement-breakpoint
ALTER TABLE "customer" ADD COLUMN "address_complement" text;--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_code_unique" UNIQUE("code");