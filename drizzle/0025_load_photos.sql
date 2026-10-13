CREATE TABLE "load_photo" (
	"id" serial PRIMARY KEY NOT NULL,
	"load_plan_id" integer NOT NULL,
	"load_plan_version_id" integer,
	"mime" text NOT NULL,
	"data" "bytea" NOT NULL,
	"thumb" "bytea",
	"width" integer,
	"height" integer,
	"size_bytes" integer NOT NULL,
	"caption" text,
	"taken_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" integer
);
--> statement-breakpoint
ALTER TABLE "load_photo" ADD CONSTRAINT "load_photo_load_plan_id_load_plan_id_fk" FOREIGN KEY ("load_plan_id") REFERENCES "public"."load_plan"("id") ON DELETE cascade ON UPDATE no action;