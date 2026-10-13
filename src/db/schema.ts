import {
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core'
import type { LoadDoc, PalletDoc } from '@/domain/types'
import type { Issue } from '@/domain/issues'
import type { FrozenPricing, QuoteSnapshotLine } from '@/domain/pricing'
import type { PaymentTerms } from '@/domain/paymentTerms'
import type { FieldSources } from '@/domain/exportTracking'

// Convenções: medidas em mm (integer), pesos em kg (numeric 12,3), timestamps com fuso.
const kg = (name: string) => numeric(name, { precision: 12, scale: 3, mode: 'number' })
const pct = (name: string) => numeric(name, { precision: 6, scale: 2, mode: 'number' })

export const roleEnum = pgEnum('role', ['ADMIN', 'EXPORT_MANAGER', 'EXPORT_ASSISTANT', 'WAREHOUSE_VIEWER'])
export const verificationEnum = pgEnum('verification', ['VERIFIED', 'ESTIMATED', 'UNVERIFIED'])
export const limitScopeEnum = pgEnum('limit_scope', ['CARRIER', 'LEGAL', 'ROUTE', 'OPERATIONAL'])
export const priceUnitEnum = pgEnum('price_unit', ['UNIT', 'BOX', 'PALLET'])
export const transportModeEnum = pgEnum('transport_mode', ['SEA', 'ROAD', 'AIR'])
export const spaceKindEnum = pgEnum('space_kind', ['CONTAINER', 'VEHICLE', 'NONE'])
/** tipo de envio (Nova carga): com equipamento (FCL, ROAD, AIR_ULD) ou sem (LCL, ROAD_LTL, AIR_LOOSE, PALLETS_ONLY, COURIER) */
export const shipmentServiceEnum = pgEnum('shipment_service', ['FCL', 'ROAD', 'AIR_ULD', 'LCL', 'ROAD_LTL', 'AIR_LOOSE', 'PALLETS_ONLY', 'COURIER'])
export const planStatusEnum = pgEnum('plan_status', ['DRAFT', 'IN_REVIEW', 'APPROVED', 'SUPERSEDED'])
/** área de negócio: define quem vê cada carga (Exportação × Mercado Interno; novas áreas entram aqui) */
export const businessAreaEnum = pgEnum('business_area', ['EXPORT', 'DOMESTIC'])
/** conjunto de eixos (limites legais por tipo): simples 2 pneus, simples 4 pneus, tandem duplo, tandem triplo */
export const axleGroupEnum = pgEnum('axle_group', ['STEER', 'SINGLE_DUAL', 'TANDEM2', 'TANDEM3'])
/** implemento rodoviário: semirreboque (com cavalo), caminhão rígido, chassi porta-contêiner */
export const carrierKindEnum = pgEnum('carrier_kind', ['SEMITRAILER', 'RIGID', 'CHASSIS'])
/** etapa da exportação confirmada (src/domain/exportTracking.ts); CANCELLED é situação especial */
export const exportStatusEnum = pgEnum('export_status', ['CONFIRMED', 'IN_PRODUCTION', 'LOADING_SCHEDULED', 'LOADED', 'IN_TRANSIT', 'ARRIVED', 'FINISHED', 'CANCELLED'])

const audit = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer('updated_by'),
})

export const users = pgTable('app_user', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  role: roleEnum('role').notNull(),
  passwordHash: text('password_hash').notNull(),
  active: boolean('active').notNull().default(true),
  mustChangePassword: boolean('must_change_password').notNull().default(true),
  /** áreas em que o usuário trabalha (vê e edita só as cargas delas); ADMIN vê todas */
  areas: businessAreaEnum('areas').array().notNull().default(['EXPORT']),
  /** avatar: um emoji ou 'foto:<hash>' (a foto fica em avatarImage); único entre usuários (NULL = sem avatar) */
  avatar: text('avatar').unique(),
  /** foto do usuário (data URL JPEG pequena, ~160 px), servida em /avatar/[id] */
  avatarImage: text('avatar_image'),
  /** versão da sessão: muda ao trocar/redefinir a senha → todas as sessões abertas caem */
  sessionVersion: integer('session_version').notNull().default(0),
  /** senhas erradas na conta inteira (todos os endereços, 15 min) no último bloqueio; zera ao entrar. Informativo: as contagens vêm de audit_log */
  failedLogins: integer('failed_logins').notNull().default(0),
  /** bloqueio da CONTA inteira (vale 15 min a partir daqui; ver src/lib/loginGuard.ts) */
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  ...audit(),
})

/** Link de redefinição de senha (por e-mail): só o hash do token é guardado; vale 1 hora, uso único. */
export const passwordResets = pgTable('password_reset', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ---------------------------------------------------------------------------
// Produtos
// ---------------------------------------------------------------------------

export const productFamilies = pgTable('product_family', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  sort: integer('sort').notNull().default(0),
  active: boolean('active').notNull().default(true),
  /** tecnologia comercial (chave em src/domain/technology.ts, ex.: 'NXT'); null = nenhuma */
  technology: text('technology'),
  /** como aparece nos PDFs comerciais: 'MENTION' (texto) | 'SEAL' (selo + texto); null quando sem tecnologia */
  technologyDisplay: text('technology_display'),
})

export const products = pgTable('product', {
  id: serial('id').primaryKey(),
  familyId: integer('family_id').notNull().references(() => productFamilies.id),
  name: text('name').notNull(),
  notes: text('notes'),
  active: boolean('active').notNull().default(true),
  ...audit(),
})

export const productVariants = pgTable('product_variant', {
  id: serial('id').primaryKey(),
  productId: integer('product_id').notNull().references(() => products.id),
  sku: text('sku').notNull().unique(),
  name: text('name').notNull(),
  /** marca comercial (Pacifil, EcoBag, ProBag, Bridon, ADP…); padrão PACIFIL — ver DEFAULT_BRAND */
  brand: text('brand').notNull().default('Pacifil'),
  /** atributos técnicos da família: diâmetro_ft, comprimento_m, capacidade_l, largura_m… (a espessura tem campo próprio) */
  attrs: jsonb('attrs').$type<Record<string, string | number | null>>().notNull().default({}),
  /** espessura do filme em micrômetros (µm); null = não informada (aparece em vermelho até ser cadastrada) */
  thicknessUm: integer('thickness_um'),
  /** MEDIDAS DO PRODUTO (campos próprios; null = não informada → vermelho onde a família exige) */
  /** silo-bolsa: diâmetro em pés */
  diameterFt: numeric('diameter_ft', { precision: 6, scale: 2, mode: 'number' }),
  /** lona, Animal Comfort, Hidrosilo, Hydroforce: largura em metros */
  widthM: numeric('width_m', { precision: 8, scale: 3, mode: 'number' }),
  /** comprimento em metros */
  lengthM: numeric('length_m', { precision: 8, scale: 3, mode: 'number' }),
  /** comprimento comercial em pés (silo-bolsas vendidas em pés, ex.: 300 pés) */
  lengthFt: numeric('length_ft', { precision: 8, scale: 2, mode: 'number' }),
  /**
   * Preço de referência (lógica definitiva de precificação a definir: listas por cliente/Incoterm etc.).
   * Copiado no snapshot da carga para que cargas antigas mantenham o preço da época.
   */
  price: numeric('price', { precision: 14, scale: 4, mode: 'number' }),
  priceCurrency: text('price_currency').notNull().default('USD'),
  priceUnit: priceUnitEnum('price_unit').notNull().default('UNIT'),
  priceUpdatedAt: timestamp('price_updated_at', { withTimezone: true }),
  notes: text('notes'),
  active: boolean('active').notNull().default(true),
  ...audit(),
})

/** Versão de embalagem: imutável depois de usada em uma carga salva (`locked`). */
export const packagingVersions = pgTable(
  'packaging_version',
  {
    id: serial('id').primaryKey(),
    variantId: integer('variant_id').notNull().references(() => productVariants.id),
    version: integer('version').notNull(),
    validFrom: date('valid_from').notNull(),
    validTo: date('valid_to'),
    packageType: text('package_type').notNull(),
    lengthMm: integer('length_mm').notNull(),
    widthMm: integer('width_mm').notNull(),
    heightMm: integer('height_mm').notNull(),
    netKg: kg('net_kg').notNull(),
    grossKg: kg('gross_kg').notNull(),
    unitsPerPackage: integer('units_per_package').notNull().default(1),
    packagesPerLayer: integer('packages_per_layer'),
    layersPerPallet: integer('layers_per_pallet'),
    unitsPerPallet: integer('units_per_pallet'),
    palletTypeId: integer('pallet_type_id').references(() => palletTypes.id),
    palletPattern: jsonb('pallet_pattern'),
    allowedOrientations: text('allowed_orientations').array().notNull().default(['LWH', 'WLH']),
    stackable: boolean('stackable').notNull().default(true),
    maxStackLayers: integer('max_stack_layers'),
    maxStackWeightKg: kg('max_stack_weight_kg'),
    fragile: boolean('fragile').notNull().default(false),
    orientationRequired: boolean('orientation_required').notNull().default(false),
    verification: verificationEnum('verification').notNull().default('UNVERIFIED'),
    verifiedAt: date('verified_at'),
    verifiedBy: text('verified_by'),
    photoUrl: text('photo_url'),
    notes: text('notes'),
    locked: boolean('locked').notNull().default(false),
    ...audit(),
  },
  (t) => [unique('packaging_variant_version').on(t.variantId, t.version)],
)

// ---------------------------------------------------------------------------
// Paletes e equipamentos
// ---------------------------------------------------------------------------

export const palletTypes = pgTable('pallet_type', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  lengthMm: integer('length_mm').notNull(),
  widthMm: integer('width_mm').notNull(),
  heightMm: integer('height_mm'),
  tareKg: kg('tare_kg'),
  staticMaxKg: kg('static_max_kg'),
  dynamicMaxKg: kg('dynamic_max_kg'),
  material: text('material'),
  fourWay: boolean('four_way').notNull().default(true),
  ispm15: boolean('ispm15').notNull().default(false),
  stackable: boolean('stackable').notNull().default(false),
  maxLoadKg: kg('max_load_kg'),
  overhangAllowed: boolean('overhang_allowed').notNull().default(false),
  overhangMaxMm: integer('overhang_max_mm').notNull().default(0),
  verification: verificationEnum('verification').notNull().default('UNVERIFIED'),
  source: text('source'),
  active: boolean('active').notNull().default(true),
  notes: text('notes'),
  ...audit(),
})

export const containerTypes = pgTable('container_type', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  innerLengthMm: integer('inner_length_mm').notNull(),
  innerWidthMm: integer('inner_width_mm').notNull(),
  innerHeightMm: integer('inner_height_mm').notNull(),
  doorWidthMm: integer('door_width_mm').notNull(),
  doorHeightMm: integer('door_height_mm').notNull(),
  extLengthMm: integer('ext_length_mm'),
  extWidthMm: integer('ext_width_mm'),
  extHeightMm: integer('ext_height_mm'),
  tareKg: kg('tare_kg').notNull(),
  maxPayloadKg: kg('max_payload_kg'),
  maxGrossKg: kg('max_gross_kg'),
  volumeM3: numeric('volume_m3', { precision: 8, scale: 2, mode: 'number' }),
  floorLoadKgPerM: kg('floor_load_kg_per_m'),
  /** SEA = contêiner marítimo; AIR = ULD (pallet/contêiner aéreo) */
  transportMode: transportModeEnum('transport_mode').notNull().default('SEA'),
  carrier: text('carrier'),
  source: text('source'),
  validFrom: date('valid_from'),
  validTo: date('valid_to'),
  verification: verificationEnum('verification').notNull().default('ESTIMATED'),
  active: boolean('active').notNull().default(true),
  notes: text('notes'),
  ...audit(),
})

export const vehicleTypes = pgTable('vehicle_type', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  country: text('country'),
  kind: text('kind'),
  carrier: text('carrier'),
  innerLengthMm: integer('inner_length_mm').notNull(),
  innerWidthMm: integer('inner_width_mm').notNull(),
  innerHeightMm: integer('inner_height_mm').notNull(),
  doorWidthMm: integer('door_width_mm').notNull(),
  doorHeightMm: integer('door_height_mm').notNull(),
  tareKg: kg('tare_kg').notNull(),
  maxPayloadKg: kg('max_payload_kg'),
  maxGrossKg: kg('max_gross_kg'),
  floorLoadKgPerM: kg('floor_load_kg_per_m'),
  axleConfiguration: jsonb('axle_configuration'),
  // --- distribuição por eixo (referencial: frente do implemento, mm para trás) ---
  /** SEMITRAILER / RIGID = espaço de carga; CHASSIS = porta-contêiner (não aparece como espaço de carga) */
  carrierKind: carrierKindEnum('carrier_kind'),
  lengthMm: integer('length_mm'),
  kingpinMm: integer('kingpin_mm'),
  frontAxleAheadMm: integer('front_axle_ahead_mm'),
  axleGroup: axleGroupEnum('axle_group'),
  axleGroupCenterMm: integer('axle_group_center_mm'),
  axleSpacingMm: integer('axle_spacing_mm'),
  techGroupKg: kg('tech_group_kg'),
  techFrontKg: kg('tech_front_kg'),
  tareCgMm: integer('tare_cg_mm'),
  cargoStartMm: integer('cargo_start_mm'),
  legalProfileId: integer('legal_profile_id').references(() => constraintProfiles.id),
  verification: verificationEnum('verification').notNull().default('UNVERIFIED'),
  source: text('source'),
  active: boolean('active').notNull().default(true),
  notes: text('notes'),
  ...audit(),
})

/** Cavalo mecânico (unidade tratora) para a distribuição por eixo. */
export const roadTractors = pgTable('road_tractor', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  country: text('country'),
  /** eixo dianteiro → centro do conjunto traseiro */
  wheelbaseMm: integer('wheelbase_mm').notNull(),
  /** 5ª roda à frente do centro do conjunto traseiro */
  fifthWheelAheadMm: integer('fifth_wheel_ahead_mm').notNull(),
  rearGroup: axleGroupEnum('rear_group').notNull(),
  rearSpacingMm: integer('rear_spacing_mm').notNull().default(0),
  tareFrontKg: kg('tare_front_kg').notNull(),
  tareRearKg: kg('tare_rear_kg').notNull(),
  techFrontKg: kg('tech_front_kg'),
  techRearKg: kg('tech_rear_kg'),
  verification: verificationEnum('verification').notNull().default('ESTIMATED'),
  source: text('source'),
  active: boolean('active').notNull().default(true),
  notes: text('notes'),
  ...audit(),
})

/** Limites legais de peso por conjunto de eixos e PBTC, por país/acordo. */
export const axleLimitProfiles = pgTable('axle_limit_profile', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  country: text('country'),
  steerKg: kg('steer_kg'),
  singleDualKg: kg('single_dual_kg'),
  tandem2Kg: kg('tandem2_kg'),
  tandem3Kg: kg('tandem3_kg'),
  maxGrossKg: kg('max_gross_kg'),
  /** alerta "perto do limite" a partir desta % */
  warnPct: pct('warn_pct').notNull().default(95),
  axleTolPct: pct('axle_tol_pct'),
  grossTolPct: pct('gross_tol_pct'),
  validFrom: date('valid_from'),
  verification: verificationEnum('verification').notNull().default('ESTIMATED'),
  source: text('source'),
  active: boolean('active').notNull().default(true),
  notes: text('notes'),
  ...audit(),
})

export const constraintProfiles = pgTable('constraint_profile', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  scope: limitScopeEnum('scope').notNull(),
  country: text('country'),
  carrier: text('carrier'),
  maxPayloadKg: kg('max_payload_kg'),
  maxGrossKg: kg('max_gross_kg'),
  maxHeightMm: integer('max_height_mm'),
  minSupportPct: pct('min_support_pct'),
  cgLongTolPct: pct('cg_long_tol_pct'),
  cgLatTolPct: pct('cg_lat_tol_pct'),
  lowUtilPct: pct('low_util_pct'),
  source: text('source'),
  validFrom: date('valid_from'),
  validTo: date('valid_to'),
  active: boolean('active').notNull().default(true),
  notes: text('notes'),
  ...audit(),
})

/** Agente comercial (vendas com comissão incluída no preço). */
export const agents = pgTable('agent', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email'),
  phone: text('phone'),
  country: text('country'),
  active: boolean('active').notNull().default(true),
  notes: text('notes'),
  ...audit(),
})

export const customers = pgTable('customer', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  country: text('country'),
  city: text('city'),
  /** endereço do cliente (sugerido ao criar a carga) */
  address: text('address'),
  taxId: text('tax_id'),
  /** agente que intermedia as vendas a este cliente (comissão incluída no preço da cotização) */
  agentId: integer('agent_id').references(() => agents.id),
  active: boolean('active').notNull().default(true),
  notes: text('notes'),
  ...audit(),
})

// ---------------------------------------------------------------------------
// Montagens de palete (modelos) e cargas
// ---------------------------------------------------------------------------

/** Montagem de palete reutilizável. Ao entrar numa carga, é copiada (snapshot) para o documento da carga. */
export const palletCompositions = pgTable('pallet_composition', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  palletTypeId: integer('pallet_type_id').notNull().references(() => palletTypes.id),
  document: jsonb('document').$type<PalletDoc>().notNull(),
  notes: text('notes'),
  active: boolean('active').notNull().default(true),
  ...audit(),
})

export const shipments = pgTable('shipment', {
  id: serial('id').primaryKey(),
  customerId: integer('customer_id').notNull().references(() => customers.id),
  orderRef: text('order_ref'),
  destinationCountry: text('destination_country').notNull(),
  incoterm: text('incoterm').notNull(),
  /** modalidade (null em só paletes / courier) */
  mode: transportModeEnum('mode'),
  service: shipmentServiceEnum('service').notNull().default('FCL'),
  /** origem e destino conforme a modalidade: porto (marítimo), aeroporto (aéreo) ou endereço físico (rodoviário) */
  originPlace: text('origin_place'),
  destinationPlace: text('destination_place'),
  /** endereço do cliente neste pedido (sugerido do cadastro do cliente) */
  customerAddress: text('customer_address'),
  /** área do pedido (Exportação / Mercado Interno): as cargas herdam e só usuários da área as veem */
  area: businessAreaEnum('area').notNull().default('EXPORT'),
  notes: text('notes'),
  ...audit(),
})

/** Empresa transportadora (quem realiza o transporte): código único e ficha de contato. */
export const transportCompanies = pgTable('transport_company', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  contact: text('contact'),
  phone: text('phone'),
  email: text('email'),
  active: boolean('active').notNull().default(true),
  notes: text('notes'),
  ...audit(),
})

export const loadPlans = pgTable('load_plan', {
  id: serial('id').primaryKey(),
  shipmentId: integer('shipment_id').notNull().references(() => shipments.id),
  name: text('name').notNull(),
  /** transportadora desta carga (cada caminhão/contêiner pode ter a sua) */
  transportCompanyId: integer('transport_company_id').references(() => transportCompanies.id),
  /** agente desta carga (comissão no preço); ao criar vem do cadastro do cliente, editável por carga */
  agentId: integer('agent_id').references(() => agents.id),
  /** bloqueio de edição: quem está editando o rascunho agora (renovado a cada minuto; vale 3 min) */
  editLockBy: integer('edit_lock_by'),
  editLockAt: timestamp('edit_lock_at', { withTimezone: true }),
  /** proforma desta carga: frete e seguro em USD (somados ao subtotal da mercadoria) e condições de pagamento */
  freightUsd: numeric('freight_usd', { precision: 14, scale: 2, mode: 'number' }),
  insuranceUsd: numeric('insurance_usd', { precision: 14, scale: 2, mode: 'number' }),
  paymentTerms: jsonb('payment_terms').$type<PaymentTerms>(),
  ...audit(),
})

export interface StoredSummary {
  pallets: number
  packages: number
  units: number
  netKg: number
  payloadKg: number
  grossKg: number
  payloadPct: number | null
  cbmUnits: number
  volumeUtilPct: number
  floorUtilPct: number
}

/**
 * Versão de plano de carga. O documento contém snapshots de TODOS os cadastros usados,
 * então editar um cadastro depois não altera a carga. APPROVED é imutável: editar cria V(n+1).
 */
export const loadPlanVersions = pgTable(
  'load_plan_version',
  {
    id: serial('id').primaryKey(),
    loadPlanId: integer('load_plan_id').notNull().references(() => loadPlans.id),
    version: integer('version').notNull(),
    status: planStatusEnum('status').notNull().default('DRAFT'),
    spaceKind: spaceKindEnum('space_kind').notNull(),
    spaceTypeId: integer('space_type_id').notNull(),
    document: jsonb('document').$type<LoadDoc>().notNull(),
    summary: jsonb('summary').$type<StoredSummary>(),
    issues: jsonb('issues').$type<Issue[]>(),
    criticalCount: integer('critical_count').notNull().default(0),
    warningCount: integer('warning_count').notNull().default(0),
    changelog: text('changelog'),
    /** preços CONGELADOS na aprovação (módulo Preços de exportação); versões não aprovadas calculam na hora */
    pricing: jsonb('pricing').$type<FrozenPricing>(),
    approvedBy: integer('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    ...audit(),
  },
  (t) => [unique('load_plan_version_unique').on(t.loadPlanId, t.version)],
)

export const auditLog = pgTable(
  'audit_log',
  {
    id: serial('id').primaryKey(),
    entity: text('entity').notNull(),
    entityId: integer('entity_id'),
    action: text('action').notNull(),
    diff: jsonb('diff'),
    userId: integer('user_id'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  // por usuário e data: limites do login (conta inteira), do envio de e-mail e da IA.
  // O índice (entity, entity_id) está na migração 0032 (SQL manual), fora deste esquema.
  (t) => [index('audit_log_user_at_idx').on(t.userId, t.at)],
)

// ---------------------------------------------------------------------------
// Assistente IA: conversa por usuário + versão de carga, rascunho e auditoria
// ---------------------------------------------------------------------------

/** Conversa do assistente. Pertence a UM usuário e a UMA versão de carga; guarda o rascunho proposto. */
export const aiConversations = pgTable('ai_conversation', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  loadPlanVersionId: integer('load_plan_version_id')
    .notNull()
    .references(() => loadPlanVersions.id),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  /** rascunho atual da carga montado pelas tools (nunca gravado na versão sem o usuário aplicar e salvar) */
  draft: jsonb('draft').$type<LoadDoc>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Histórico append-only no formato do provedor (blocos de conteúdo, inclusive tool_use/tool_result). */
export const aiMessages = pgTable('ai_message', {
  id: serial('id').primaryKey(),
  conversationId: integer('conversation_id')
    .notNull()
    .references(() => aiConversations.id),
  role: text('role').notNull(),
  content: jsonb('content').notNull(),
  /** texto original digitado (só mensagens do usuário) */
  userText: text('user_text'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  cacheReadTokens: integer('cache_read_tokens'),
  cacheWriteTokens: integer('cache_write_tokens'),
  /** custo estimado em USD desta chamada (tabela de preços em lib/ai/pricing.ts) */
  costUsd: numeric('cost_usd', { precision: 10, scale: 6, mode: 'number' }),
  model: text('model'),
  stopReason: text('stop_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Auditoria de cada tool executada pela IA: parâmetros, resultado, erro, duração. */
export const aiToolCalls = pgTable('ai_tool_call', {
  id: serial('id').primaryKey(),
  conversationId: integer('conversation_id')
    .notNull()
    .references(() => aiConversations.id),
  userId: integer('user_id').notNull(),
  tool: text('tool').notNull(),
  input: jsonb('input'),
  output: jsonb('output'),
  error: text('error'),
  durationMs: integer('duration_ms'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
})

// ---------------------------------------------------------------------------
// Preços de exportação: categorias de mercado, países, regra e preço por família, histórico.
// Só dados COMERCIAIS: código, peso líquido, família etc. vêm sempre do catálogo mestre.
// ---------------------------------------------------------------------------

/**
 * Método de preço da família (extensível: novas famílias podem ganhar regras próprias):
 *   PER_KG              preço unitário = peso líquido × USD/kg
 *   PER_KG_PLUS_FIXED   preço unitário = peso líquido × USD/kg + valor fixo USD/unidade (ex.: Hidrosilo: válvulas)
 *   INCLUDED            sem preço próprio: incluído no valor de outro produto (ex.: KIT-HF no fixo do Hidroforce)
 *   RELATIVE            preço da família de referência (calculado com o peso líquido deste produto) + markup %
 *                       (ex.: Hidroforce = Hidrosilo + 40%)
 */
export const priceMethodEnum = pgEnum('price_method', ['PER_KG', 'PER_KG_PLUS_FIXED', 'INCLUDED', 'RELATIVE'])

/** Categoria comercial de mercado (A, B, C… administradas pela interface). */
export const priceCategories = pgTable('price_category', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  sort: integer('sort').notNull().default(0),
  active: boolean('active').notNull().default(true),
  ...audit(),
})

/** País de destino (ISO-3166 alfa-2) → categoria. País sem linha aqui = sem categoria (sem preço). */
export const countryPriceCategories = pgTable('country_price_category', {
  countryCode: text('country_code').primaryKey(),
  categoryId: integer('category_id')
    .notNull()
    .references(() => priceCategories.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer('updated_by'),
})

/** Regra de preço da família (sem linha = PER_KG). */
export const familyPriceRules = pgTable('family_price_rule', {
  familyId: integer('family_id')
    .primaryKey()
    .references(() => productFamilies.id),
  method: priceMethodEnum('method').notNull().default('PER_KG'),
  /** recargo CIF (USD/kg líquido) desta família, só em cotações CIF; vazio = não definido → sem preço em CIF (não há padrão geral) */
  cifUsdPerKg: numeric('cif_usd_per_kg', { precision: 12, scale: 4, mode: 'number' }),
  /** regra RELATIVE: família de referência e acréscimo em % sobre o preço dela */
  refFamilyId: integer('ref_family_id').references(() => productFamilies.id),
  markupPct: numeric('markup_pct', { precision: 8, scale: 4, mode: 'number' }),
  notes: text('notes'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer('updated_by'),
})

/** Preço da família por categoria: USD/kg líquido e, conforme a regra, valor fixo USD/unidade. */
export const familyPrices = pgTable(
  'family_price',
  {
    id: serial('id').primaryKey(),
    familyId: integer('family_id')
      .notNull()
      .references(() => productFamilies.id),
    categoryId: integer('category_id')
      .notNull()
      .references(() => priceCategories.id),
    usdPerKg: numeric('usd_per_kg', { precision: 12, scale: 4, mode: 'number' }),
    fixedUsdPerUnit: numeric('fixed_usd_per_unit', { precision: 12, scale: 4, mode: 'number' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: integer('updated_by'),
  },
  (t) => [unique('family_price_unique').on(t.familyId, t.categoryId)],
)

/**
 * Faixas de diâmetro (pés) com USD/kg próprio por categoria — ex.: Silo-bolsa 5 a 8 pés, 9 a 12 pés, 14 pés.
 * Família com faixas: o USD/kg vem da faixa do diâmetro do produto (fora de todas: a faixa de centro mais próximo).
 */
export const familyPriceBands = pgTable(
  'family_price_band',
  {
    id: serial('id').primaryKey(),
    familyId: integer('family_id')
      .notNull()
      .references(() => productFamilies.id),
    key: text('key').notNull(),
    label: text('label').notNull(),
    minFt: numeric('min_ft', { precision: 6, scale: 2, mode: 'number' }).notNull(),
    maxFt: numeric('max_ft', { precision: 6, scale: 2, mode: 'number' }).notNull(),
    sort: integer('sort').notNull().default(0),
  },
  (t) => [unique('family_price_band_unique').on(t.familyId, t.key)],
)

/** USD/kg líquido de cada faixa de diâmetro numa categoria */
export const familyBandPrices = pgTable(
  'family_band_price',
  {
    id: serial('id').primaryKey(),
    familyId: integer('family_id')
      .notNull()
      .references(() => productFamilies.id),
    categoryId: integer('category_id')
      .notNull()
      .references(() => priceCategories.id),
    bandKey: text('band_key').notNull(),
    usdPerKg: numeric('usd_per_kg', { precision: 12, scale: 4, mode: 'number' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: integer('updated_by'),
  },
  (t) => [unique('family_band_price_unique').on(t.familyId, t.categoryId, t.bandKey)],
)

/** Histórico de TODA alteração comercial (valor anterior e novo, quando e quem). Só inserção. */
export const priceHistory = pgTable('price_history', {
  id: serial('id').primaryKey(),
  /** 'family_price' | 'family_rule' | 'country_category' | 'category' | 'brand_adjust' | 'commission' | 'cif' | 'cif_default' */
  kind: text('kind').notNull(),
  familyId: integer('family_id'),
  categoryId: integer('category_id'),
  countryCode: text('country_code'),
  /** campo alterado (usdPerKg, fixedUsdPerUnit, method, categoryId, name, active…) */
  field: text('field').notNull(),
  oldValue: text('old_value'),
  newValue: text('new_value'),
  userId: integer('user_id'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * Ajuste do preço de lista por MARCA (catálogo: product_variant.brand), em % — negativo = desconto.
 * Ex.: Ecobag −5% (silo-bolsa ou lona). Aplicado depois da regra da família.
 */
export const brandPriceAdjustments = pgTable('brand_price_adjustment', {
  /** marca como no catálogo (comparação sem diferenciar maiúsculas) */
  brand: text('brand').primaryKey(),
  pct: numeric('pct', { precision: 8, scale: 4, mode: 'number' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer('updated_by'),
})

/**
 * % de comissão do AGENTE por FAMÍLIA (perfil do agente). Sem % para a família = sem comissão definida
 * (o sistema avisa e não calcula). A comissão é % do preço FINAL faturado: preço = base ÷ (1 − %).
 */
export const commissionRates = pgTable(
  'commission_rate',
  {
    id: serial('id').primaryKey(),
    agentId: integer('agent_id')
      .notNull()
      .references(() => agents.id),
    familyId: integer('family_id')
      .notNull()
      .references(() => productFamilies.id),
    pct: numeric('pct', { precision: 8, scale: 4, mode: 'number' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: integer('updated_by'),
  },
  (t) => [unique('commission_rate_agent_family').on(t.agentId, t.familyId)],
)

/**
 * COTAÇÕES EMITIDAS: cada PDF do pedido gerado (enviado ao cliente) registra o preço usado e COMO foi
 * calculado (categoria, comissão, USD/kg, fixo, marca, peso líquido) — para consultar meses depois,
 * mesmo que as tabelas de preço mudem. Gerar de novo com os mesmos preços só atualiza a data e o contador.
 */
export const priceQuotes = pgTable(
  'price_quote',
  {
    id: serial('id').primaryKey(),
    /** origem: 'load' (PDF do pedido de uma carga) | 'mixed' (paletes mistos) | 'courier' */
    origin: text('origin').notNull().default('load'),
    /** sem chave estrangeira: a cotação emitida continua registrada mesmo se a carga for excluída; null = sem carga (paletes mistos/courier) */
    loadPlanId: integer('load_plan_id'),
    loadPlanVersionId: integer('load_plan_version_id'),
    version: integer('version'),
    /** paletes mistos/courier: referência e destino digitados no planejamento */
    reference: text('reference'),
    /** dados do pedido na época (cópia: não mudam se o cadastro mudar) */
    planName: text('plan_name').notNull(),
    customerId: integer('customer_id'),
    customerName: text('customer_name'),
    orderRef: text('order_ref'),
    /** status da versão ao emitir e origem do preço: live (tabela vigente) | frozen (aprovação) | legacy */
    status: text('status').notNull(),
    source: text('source').notNull(),
    country: text('country'),
    category: text('category'),
    agentId: integer('agent_id'),
    agentName: text('agent_name'),
    /** subtotal da mercadoria (USD) */
    totalUsd: numeric('total_usd', { precision: 14, scale: 2, mode: 'number' }),
    incoterm: text('incoterm'),
    freightUsd: numeric('freight_usd', { precision: 14, scale: 2, mode: 'number' }),
    insuranceUsd: numeric('insurance_usd', { precision: 14, scale: 2, mode: 'number' }),
    /** total geral = mercadoria + frete + seguro */
    grandTotalUsd: numeric('grand_total_usd', { precision: 14, scale: 2, mode: 'number' }),
    paymentTerms: text('payment_terms'),
    transportCompany: text('transport_company'),
    commissionUsd: numeric('commission_usd', { precision: 14, scale: 2, mode: 'number' }),
    lines: jsonb('lines').$type<QuoteSnapshotLine[]>().notNull(),
    signature: text('signature').notNull(),
    lang: text('lang'),
    firstIssuedAt: timestamp('first_issued_at', { withTimezone: true }).notNull().defaultNow(),
    lastIssuedAt: timestamp('last_issued_at', { withTimezone: true }).notNull().defaultNow(),
    issueCount: integer('issue_count').notNull().default(1),
    createdBy: integer('created_by'),
    lastIssuedBy: integer('last_issued_by'),
  },
  // sem carga (versão null): mesma assinatura = mesma cotação (NULLS NOT DISTINCT)
  (t) => [unique('price_quote_version_signature').on(t.loadPlanVersionId, t.signature).nullsNotDistinct()],
)

/**
 * Parâmetros gerais de preços de exportação (chave → número). Hoje sem uso: o recargo CIF, que era o único
 * (cif_usd_per_kg), passou a ser só por família (family_price_rule.cif_usd_per_kg; migração 0038).
 */
export const exportPriceSettings = pgTable('export_price_setting', {
  key: text('key').primaryKey(),
  value: numeric('value', { precision: 12, scale: 4, mode: 'number' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer('updated_by'),
})

/** bytes (bytea) — imagens pequenas guardadas no banco */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea'
  },
})

/**
 * FOTOS DO CARREGAMENTO: registro de como a carga ficou realmente carregada (depois de aprovada).
 * A imagem chega reduzida do navegador (JPEG ~1600 px) com uma miniatura para a galeria.
 * Excluir a carga exclui as fotos dela.
 */
export const loadPhotos = pgTable('load_photo', {
  id: serial('id').primaryKey(),
  loadPlanId: integer('load_plan_id')
    .notNull()
    .references(() => loadPlans.id, { onDelete: 'cascade' }),
  /** versão aprovada vigente quando a foto foi anexada */
  loadPlanVersionId: integer('load_plan_version_id'),
  mime: text('mime').notNull(),
  data: bytea('data').notNull(),
  thumb: bytea('thumb'),
  /** versão média (~1000 px) para o PDF (mantém o PDF leve para e-mail/WhatsApp) */
  medium: bytea('medium'),
  width: integer('width'),
  height: integer('height'),
  sizeBytes: integer('size_bytes').notNull(),
  caption: text('caption'),
  /** data/hora da foto (EXIF não é lido: data do arquivo ou do envio) */
  takenAt: timestamp('taken_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer('created_by'),
})

/**
 * SEGUIMENTO DE EXPORTAÇÕES: uma operação por carga (contêiner/caminhão) cujo pedido o cliente confirmou.
 * Cliente, país, proforma, produtos, pesos, valor, Incoterm, portos e transportadora NÃO são copiados: vêm da
 * carga (load_plan → shipment → customer) e da última versão aprovada. Aqui só a logística e as datas.
 * fieldSources: origem de cada valor (MANUAL | CALC | API) — pronto para rastreio automático no futuro.
 * A carga com operação não pode ser excluída (FK sem cascade; as ações de excluir avisam).
 */
export const exportOperations = pgTable(
  'export_operation',
  {
    id: serial('id').primaryKey(),
    loadPlanId: integer('load_plan_id')
      .notNull()
      .references(() => loadPlans.id),
    /** versão aprovada no momento da confirmação (o seguimento mostra sempre a última aprovada) */
    confirmedVersionId: integer('confirmed_version_id'),
    status: exportStatusEnum('status').notNull().default('CONFIRMED'),
    /** situações especiais: marcada como atrasada (manual) e incidência (texto; vazio = sem incidência) */
    delayed: boolean('delayed').notNull().default(false),
    incident: text('incident'),
    confirmedAt: date('confirmed_at').notNull(),
    confirmedBy: integer('confirmed_by'),
    paymentReceivedAt: date('payment_received_at'),
    responsibleUserId: integer('responsible_user_id'),
    carrier: text('carrier'),
    forwarder: text('forwarder'),
    bookingNumber: text('booking_number'),
    containerNumber: text('container_number'),
    sealNumber: text('seal_number'),
    blNumber: text('bl_number'),
    vessel: text('vessel'),
    voyage: text('voyage'),
    plannedLoadingDate: date('planned_loading_date'),
    actualLoadingDate: date('actual_loading_date'),
    etd: date('etd'),
    atd: date('atd'),
    transitDays: integer('transit_days'),
    /** ETA: calculada (ETD + trânsito) quando os dois existem; senão informada (ou vinda de API) */
    eta: date('eta'),
    ata: date('ata'),
    deliveredAt: date('delivered_at'),
    /** rastreio (hoje manual; no futuro, integração): localização, status bruto do armador e quando foi atualizado */
    currentLocation: text('current_location'),
    trackingStatus: text('tracking_status'),
    lastTrackingUpdate: timestamp('last_tracking_update', { withTimezone: true }),
    /** integração futura: plataforma/armador e a referência do embarque nela */
    trackingProvider: text('tracking_provider'),
    trackingRef: text('tracking_ref'),
    notes: text('notes'),
    fieldSources: jsonb('field_sources').$type<FieldSources>().notNull().default({}),
    /** quando saiu do painel (finalizada ou cancelada) */
    closedAt: timestamp('closed_at', { withTimezone: true }),
    ...audit(),
  },
  (t) => [unique('export_operation_load_plan_unique').on(t.loadPlanId), index('export_operation_status_idx').on(t.status)],
)

/** HISTÓRICO do seguimento: cada alteração (quem, quando, de → para, origem manual/API) — só inserção */
export const exportEvents = pgTable(
  'export_event',
  {
    id: serial('id').primaryKey(),
    operationId: integer('operation_id')
      .notNull()
      .references(() => exportOperations.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    /** null = integração/sistema */
    userId: integer('user_id'),
    /** MANUAL | CALC | API | SYSTEM */
    source: text('source').notNull().default('MANUAL'),
    /** confirm | status | field | undo */
    kind: text('kind').notNull(),
    field: text('field'),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    /** texto legível: "ETD atualizado para 22/10/2026" */
    message: text('message').notNull(),
  },
  (t) => [index('export_event_operation_idx').on(t.operationId, t.at)],
)
