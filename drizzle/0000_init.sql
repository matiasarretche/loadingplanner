CREATE TYPE "public"."limit_scope" AS ENUM('CARRIER', 'LEGAL', 'ROUTE', 'OPERATIONAL');--> statement-breakpoint
CREATE TYPE "public"."plan_status" AS ENUM('DRAFT', 'IN_REVIEW', 'APPROVED', 'SUPERSEDED');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('ADMIN', 'EXPORT_MANAGER', 'EXPORT_ASSISTANT', 'WAREHOUSE_VIEWER');--> statement-breakpoint
CREATE TYPE "public"."space_kind" AS ENUM('CONTAINER', 'VEHICLE');--> statement-breakpoint
CREATE TYPE "public"."transport_mode" AS ENUM('SEA', 'ROAD');--> statement-breakpoint
CREATE TYPE "public"."verification" AS ENUM('VERIFIED', 'ESTIMATED', 'UNVERIFIED');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"entity" text NOT NULL,
	"entity_id" integer,
	"action" text NOT NULL,
	"diff" jsonb,
	"user_id" integer,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "constraint_profile" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"scope" "limit_scope" NOT NULL,
	"country" text,
	"carrier" text,
	"max_payload_kg" numeric(12, 3),
	"max_gross_kg" numeric(12, 3),
	"max_height_mm" integer,
	"min_support_pct" numeric(6, 2),
	"cg_long_tol_pct" numeric(6, 2),
	"cg_lat_tol_pct" numeric(6, 2),
	"low_util_pct" numeric(6, 2),
	"source" text,
	"valid_from" date,
	"valid_to" date,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer
);
--> statement-breakpoint
CREATE TABLE "container_type" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"inner_length_mm" integer NOT NULL,
	"inner_width_mm" integer NOT NULL,
	"inner_height_mm" integer NOT NULL,
	"door_width_mm" integer NOT NULL,
	"door_height_mm" integer NOT NULL,
	"ext_length_mm" integer,
	"ext_width_mm" integer,
	"ext_height_mm" integer,
	"tare_kg" numeric(12, 3) NOT NULL,
	"max_payload_kg" numeric(12, 3),
	"max_gross_kg" numeric(12, 3),
	"volume_m3" numeric(8, 2),
	"floor_load_kg_per_m" numeric(12, 3),
	"carrier" text,
	"source" text,
	"valid_from" date,
	"valid_to" date,
	"verification" "verification" DEFAULT 'ESTIMATED' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	CONSTRAINT "container_type_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "customer" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"country" text,
	"city" text,
	"tax_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer
);
--> statement-breakpoint
CREATE TABLE "load_plan_version" (
	"id" serial PRIMARY KEY NOT NULL,
	"load_plan_id" integer NOT NULL,
	"version" integer NOT NULL,
	"status" "plan_status" DEFAULT 'DRAFT' NOT NULL,
	"space_kind" "space_kind" NOT NULL,
	"space_type_id" integer NOT NULL,
	"document" jsonb NOT NULL,
	"summary" jsonb,
	"issues" jsonb,
	"critical_count" integer DEFAULT 0 NOT NULL,
	"warning_count" integer DEFAULT 0 NOT NULL,
	"changelog" text,
	"approved_by" integer,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	CONSTRAINT "load_plan_version_unique" UNIQUE("load_plan_id","version")
);
--> statement-breakpoint
CREATE TABLE "load_plan" (
	"id" serial PRIMARY KEY NOT NULL,
	"shipment_id" integer NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer
);
--> statement-breakpoint
CREATE TABLE "packaging_version" (
	"id" serial PRIMARY KEY NOT NULL,
	"variant_id" integer NOT NULL,
	"version" integer NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"package_type" text NOT NULL,
	"length_mm" integer NOT NULL,
	"width_mm" integer NOT NULL,
	"height_mm" integer NOT NULL,
	"net_kg" numeric(12, 3) NOT NULL,
	"gross_kg" numeric(12, 3) NOT NULL,
	"units_per_package" integer DEFAULT 1 NOT NULL,
	"packages_per_layer" integer,
	"layers_per_pallet" integer,
	"units_per_pallet" integer,
	"pallet_type_id" integer,
	"pallet_pattern" jsonb,
	"allowed_orientations" text[] DEFAULT '{"LWH","WLH"}' NOT NULL,
	"stackable" boolean DEFAULT true NOT NULL,
	"max_stack_layers" integer,
	"max_stack_weight_kg" numeric(12, 3),
	"fragile" boolean DEFAULT false NOT NULL,
	"orientation_required" boolean DEFAULT false NOT NULL,
	"verification" "verification" DEFAULT 'UNVERIFIED' NOT NULL,
	"verified_at" date,
	"verified_by" text,
	"photo_url" text,
	"notes" text,
	"locked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	CONSTRAINT "packaging_variant_version" UNIQUE("variant_id","version")
);
--> statement-breakpoint
CREATE TABLE "pallet_composition" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"pallet_type_id" integer NOT NULL,
	"document" jsonb NOT NULL,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer
);
--> statement-breakpoint
CREATE TABLE "pallet_type" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"length_mm" integer NOT NULL,
	"width_mm" integer NOT NULL,
	"height_mm" integer,
	"tare_kg" numeric(12, 3),
	"static_max_kg" numeric(12, 3),
	"dynamic_max_kg" numeric(12, 3),
	"material" text,
	"four_way" boolean DEFAULT true NOT NULL,
	"ispm15" boolean DEFAULT false NOT NULL,
	"stackable" boolean DEFAULT false NOT NULL,
	"max_total_height_mm" integer,
	"max_load_kg" numeric(12, 3),
	"overhang_allowed" boolean DEFAULT false NOT NULL,
	"overhang_max_mm" integer DEFAULT 0 NOT NULL,
	"verification" "verification" DEFAULT 'UNVERIFIED' NOT NULL,
	"source" text,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	CONSTRAINT "pallet_type_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "product_family" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "product_family_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "product_variant" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"attrs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	CONSTRAINT "product_variant_sku_unique" UNIQUE("sku")
);
--> statement-breakpoint
CREATE TABLE "product" (
	"id" serial PRIMARY KEY NOT NULL,
	"family_id" integer NOT NULL,
	"name" text NOT NULL,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer
);
--> statement-breakpoint
CREATE TABLE "shipment" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"order_ref" text,
	"destination_country" text NOT NULL,
	"incoterm" text NOT NULL,
	"mode" "transport_mode" NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer
);
--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" "role" NOT NULL,
	"password_hash" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"must_change_password" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	CONSTRAINT "app_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "vehicle_type" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"country" text,
	"kind" text,
	"carrier" text,
	"inner_length_mm" integer NOT NULL,
	"inner_width_mm" integer NOT NULL,
	"inner_height_mm" integer NOT NULL,
	"door_width_mm" integer NOT NULL,
	"door_height_mm" integer NOT NULL,
	"tare_kg" numeric(12, 3) NOT NULL,
	"max_payload_kg" numeric(12, 3),
	"max_gross_kg" numeric(12, 3),
	"floor_load_kg_per_m" numeric(12, 3),
	"axle_configuration" jsonb,
	"legal_profile_id" integer,
	"verification" "verification" DEFAULT 'UNVERIFIED' NOT NULL,
	"source" text,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" integer,
	CONSTRAINT "vehicle_type_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "load_plan_version" ADD CONSTRAINT "load_plan_version_load_plan_id_load_plan_id_fk" FOREIGN KEY ("load_plan_id") REFERENCES "public"."load_plan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_plan" ADD CONSTRAINT "load_plan_shipment_id_shipment_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packaging_version" ADD CONSTRAINT "packaging_version_variant_id_product_variant_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packaging_version" ADD CONSTRAINT "packaging_version_pallet_type_id_pallet_type_id_fk" FOREIGN KEY ("pallet_type_id") REFERENCES "public"."pallet_type"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pallet_composition" ADD CONSTRAINT "pallet_composition_pallet_type_id_pallet_type_id_fk" FOREIGN KEY ("pallet_type_id") REFERENCES "public"."pallet_type"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variant" ADD CONSTRAINT "product_variant_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_family_id_product_family_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."product_family"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_type" ADD CONSTRAINT "vehicle_type_legal_profile_id_constraint_profile_id_fk" FOREIGN KEY ("legal_profile_id") REFERENCES "public"."constraint_profile"("id") ON DELETE no action ON UPDATE no action;