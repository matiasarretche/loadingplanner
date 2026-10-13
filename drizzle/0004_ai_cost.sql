ALTER TABLE "ai_message" ADD COLUMN "cache_write_tokens" integer;--> statement-breakpoint
ALTER TABLE "ai_message" ADD COLUMN "cost_usd" numeric(10, 6);--> statement-breakpoint
ALTER TABLE "ai_message" ADD COLUMN "model" text;