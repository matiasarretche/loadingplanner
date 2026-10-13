CREATE TABLE "password_reset" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_reset_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "session_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "failed_logins" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app_user" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "password_reset" ADD CONSTRAINT "password_reset_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE cascade ON UPDATE no action;