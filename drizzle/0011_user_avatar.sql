ALTER TABLE "app_user" ADD COLUMN "avatar" text;--> statement-breakpoint
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_avatar_unique" UNIQUE("avatar");