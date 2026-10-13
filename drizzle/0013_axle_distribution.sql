CREATE TYPE "public"."axle_group" AS ENUM('STEER', 'SINGLE_DUAL', 'TANDEM2', 'TANDEM3');--> statement-breakpoint
CREATE TYPE "public"."carrier_kind" AS ENUM('SEMITRAILER', 'RIGID', 'CHASSIS');--> statement-breakpoint
CREATE TABLE "axle_limit_profile" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"country" text,
	"steer_kg" numeric(12, 3),
	"single_dual_kg" numeric(12, 3),
	"tandem2_kg" numeric(12, 3),
	"tandem3_kg" numeric(12, 3),
	"max_gross_kg" numeric(12, 3),
	"warn_pct" numeric(6, 2) DEFAULT 95 NOT NULL,
	"axle_tol_pct" numeric(6, 2),
	"gross_tol_pct" numeric(6, 2),
	"valid_from" date,
	"verification" "verification" DEFAULT 'ESTIMATED' NOT NULL,
	"source" text,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	CONSTRAINT "axle_limit_profile_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "road_tractor" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"country" text,
	"wheelbase_mm" integer NOT NULL,
	"fifth_wheel_ahead_mm" integer NOT NULL,
	"rear_group" "axle_group" NOT NULL,
	"rear_spacing_mm" integer DEFAULT 0 NOT NULL,
	"tare_front_kg" numeric(12, 3) NOT NULL,
	"tare_rear_kg" numeric(12, 3) NOT NULL,
	"tech_front_kg" numeric(12, 3),
	"tech_rear_kg" numeric(12, 3),
	"verification" "verification" DEFAULT 'ESTIMATED' NOT NULL,
	"source" text,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	CONSTRAINT "road_tractor_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "vehicle_type" ADD COLUMN "carrier_kind" "carrier_kind";--> statement-breakpoint
ALTER TABLE "vehicle_type" ADD COLUMN "length_mm" integer;--> statement-breakpoint
ALTER TABLE "vehicle_type" ADD COLUMN "kingpin_mm" integer;--> statement-breakpoint
ALTER TABLE "vehicle_type" ADD COLUMN "front_axle_ahead_mm" integer;--> statement-breakpoint
ALTER TABLE "vehicle_type" ADD COLUMN "axle_group" "axle_group";--> statement-breakpoint
ALTER TABLE "vehicle_type" ADD COLUMN "axle_group_center_mm" integer;--> statement-breakpoint
ALTER TABLE "vehicle_type" ADD COLUMN "axle_spacing_mm" integer;--> statement-breakpoint
ALTER TABLE "vehicle_type" ADD COLUMN "tech_group_kg" numeric(12, 3);--> statement-breakpoint
ALTER TABLE "vehicle_type" ADD COLUMN "tech_front_kg" numeric(12, 3);--> statement-breakpoint
ALTER TABLE "vehicle_type" ADD COLUMN "tare_cg_mm" integer;--> statement-breakpoint
ALTER TABLE "vehicle_type" ADD COLUMN "cargo_start_mm" integer;