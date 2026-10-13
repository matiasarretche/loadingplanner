CREATE TYPE "public"."export_status" AS ENUM('CONFIRMED', 'IN_PRODUCTION', 'LOADING_SCHEDULED', 'LOADED', 'IN_TRANSIT', 'ARRIVED', 'FINISHED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "export_event" (
	"id" serial PRIMARY KEY NOT NULL,
	"operation_id" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" integer,
	"source" text DEFAULT 'MANUAL' NOT NULL,
	"kind" text NOT NULL,
	"field" text,
	"old_value" text,
	"new_value" text,
	"message" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "export_operation" (
	"id" serial PRIMARY KEY NOT NULL,
	"load_plan_id" integer NOT NULL,
	"confirmed_version_id" integer,
	"status" "export_status" DEFAULT 'CONFIRMED' NOT NULL,
	"delayed" boolean DEFAULT false NOT NULL,
	"incident" text,
	"confirmed_at" date NOT NULL,
	"confirmed_by" integer,
	"payment_received_at" date,
	"responsible_user_id" integer,
	"carrier" text,
	"forwarder" text,
	"booking_number" text,
	"container_number" text,
	"seal_number" text,
	"bl_number" text,
	"vessel" text,
	"voyage" text,
	"planned_loading_date" date,
	"actual_loading_date" date,
	"etd" date,
	"atd" date,
	"transit_days" integer,
	"eta" date,
	"ata" date,
	"delivered_at" date,
	"current_location" text,
	"tracking_status" text,
	"last_tracking_update" timestamp with time zone,
	"tracking_provider" text,
	"tracking_ref" text,
	"notes" text,
	"field_sources" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	CONSTRAINT "export_operation_load_plan_unique" UNIQUE("load_plan_id")
);
--> statement-breakpoint
ALTER TABLE "export_event" ADD CONSTRAINT "export_event_operation_id_export_operation_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."export_operation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_operation" ADD CONSTRAINT "export_operation_load_plan_id_load_plan_id_fk" FOREIGN KEY ("load_plan_id") REFERENCES "public"."load_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "export_event_operation_idx" ON "export_event" USING btree ("operation_id","at");--> statement-breakpoint
CREATE INDEX "export_operation_status_idx" ON "export_operation" USING btree ("status");