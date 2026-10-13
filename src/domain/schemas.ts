/** Validação estrutural (zod) dos documentos que chegam do cliente. */
import { z } from 'zod'
import { ORIENTATIONS } from './geometry'

const mmInt = z.number().int().min(-100000).max(100000)
const pos = z.object({ x: mmInt, y: mmInt, z: mmInt })
const dimsSchema = z.object({ l: z.number().int().positive(), w: z.number().int().positive(), h: z.number().int().min(0) })
const orient = z.enum(ORIENTATIONS as [string, ...string[]])
const kg = z.number().min(0).max(1e7)
const ver = z.enum(['VERIFIED', 'ESTIMATED', 'UNVERIFIED'])

export const packSnapshotSchema = z.object({
  packagingVersionId: z.number().int(),
  version: z.number().int(),
  sku: z.string().min(1),
  name: z.string(),
  packageType: z.string(),
  dims: dimsSchema.extend({ h: z.number().int().positive() }),
  netKg: kg,
  grossKg: kg,
  unitsPerPackage: z.number().int().positive(),
  allowedOrientations: z.array(orient).min(1),
  stackable: z.boolean(),
  maxStackLayers: z.number().int().positive().nullable(),
  maxStackKg: kg.nullable(),
  fragile: z.boolean(),
  verification: ver,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  price: z.object({ amount: z.number().min(0), currency: z.string().min(3).max(3), per: z.enum(['UNIT', 'BOX', 'PALLET']) }).nullable().optional(),
  companions: z.array(z.object({ sku: z.string().min(1).max(60), qty: z.number().positive() })).max(10).optional(),
  boxesPerPallet: z.number().int().positive().nullable().optional(),
  // formato do volume (domain/packShape): 'ROLL' = lona/filme em rolo; sem isto o zod descartaria o campo ao salvar
  shape: z.literal('ROLL').optional(),
  // caixa coletiva de kits (domain/kitBoxes): sem isto o zod descartaria o campo ao salvar
  kitBox: z
    .object({
      kind: z.enum(['BIG', 'HALF']),
      code: z.string().min(1).max(40),
      capacity: z.number().int().positive(),
      kits: z.number().int().positive(),
      unit: z.object({ dims: dimsSchema.extend({ h: z.number().int().positive() }), netKg: kg, grossKg: kg, unitsPerPackage: z.number().int().positive(), allowedOrientations: z.array(orient).min(1) }),
    })
    .optional(),
})

export const palletTypeSnapshotSchema = z.object({
  palletTypeId: z.number().int(),
  code: z.string(),
  name: z.string(),
  dims: dimsSchema,
  tareKg: kg,
  staticMaxKg: kg.nullable(),
  dynamicMaxKg: kg.nullable(),
  maxLoadKg: kg.nullable(),
  overhangAllowed: z.boolean(),
  overhangMaxMm: z.number().int().min(0),
  verification: ver,
})

export const palletDocSchema = z.object({
  name: z.string().min(1).max(200),
  palletType: palletTypeSnapshotSchema,
  packs: z.record(z.string(), packSnapshotSchema),
  items: z
    .array(z.object({ id: z.string().min(1).max(64), packId: z.string(), pos, orientation: orient, locked: z.boolean() }))
    .max(5000),
  stackable: z.boolean(),
  maxTopKg: kg.nullable(),
  accessoriesKg: kg,
  baseKey: z.string().max(200).optional(),
  fullBoxes: z.number().int().min(0).optional(),
})

const spaceSchema = z.object({
  kind: z.enum(['CONTAINER', 'VEHICLE', 'NONE']),
  typeId: z.number().int(),
  code: z.string(),
  name: z.string(),
  inner: dimsSchema.extend({ h: z.number().int().positive() }),
  door: z.object({ w: z.number().int().positive(), h: z.number().int().positive() }),
  tareKg: kg,
  maxPayloadKg: kg.nullable(),
  maxGrossKg: kg.nullable(),
  floorLoadKgPerM: kg.nullable(),
  source: z.string().nullable(),
  verification: ver,
  transport: z.enum(['SEA', 'ROAD', 'AIR']).optional(),
  baseInnerL: z.number().int().positive().optional(),
  service: z.enum(['LCL', 'ROAD_LTL', 'AIR_LOOSE', 'PALLETS_ONLY', 'COURIER']).optional(),
  maxLoadHeightMm: z.number().int().min(300).max(4000).optional(),
  courierDivisor: z.number().int().min(1000).max(10000).optional(),
}).refine((s) => (s.kind === 'NONE') === (s.service != null), { message: 'Envio sem equipamento exige o tipo (e só ele).' })

const limitSchema = z.object({
  profileId: z.number().int(),
  name: z.string(),
  scope: z.enum(['CARRIER', 'LEGAL', 'ROUTE', 'OPERATIONAL']),
  maxPayloadKg: kg.nullable(),
  maxGrossKg: kg.nullable(),
  maxHeightMm: z.number().int().positive().nullable(),
  minSupportPct: z.number().min(0).max(100).nullable(),
  cgLongTolPct: z.number().min(0).max(100).nullable(),
  cgLatTolPct: z.number().min(0).max(100).nullable(),
  lowUtilPct: z.number().min(0).max(100).nullable(),
})

const unitSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.string().min(1).max(64), kind: z.literal('PALLET'), palletKey: z.string(), pos, yaw: z.boolean(), locked: z.boolean(), label: z.string().max(100).optional() }),
  z.object({ id: z.string().min(1).max(64), kind: z.literal('PACKAGE'), packId: z.string(), pos, orientation: orient, locked: z.boolean(), label: z.string().max(100).optional() }),
])

const axleType = z.enum(['STEER', 'SINGLE_DUAL', 'TANDEM2', 'TANDEM3'])
const mmN = z.number().finite().min(0).max(40000)
const kgN = z.number().finite().min(0).max(200000)
const roadSchema = z.object({
  tractor: z
    .object({
      id: z.number().int(),
      code: z.string(),
      name: z.string(),
      wheelbaseMm: mmN.positive(),
      fifthWheelAheadMm: z.number().finite().min(-3000).max(3000),
      rearGroup: axleType,
      rearSpacingMm: mmN,
      tareFrontKg: kgN,
      tareRearKg: kgN,
      techFrontKg: kgN.nullable(),
      techRearKg: kgN.nullable(),
      verification: ver,
      source: z.string().nullable(),
    })
    .nullable(),
  carrier: z.object({
    id: z.number().int(),
    code: z.string(),
    name: z.string(),
    kind: z.enum(['SEMITRAILER', 'RIGID', 'CHASSIS']),
    lengthMm: mmN.positive(),
    kingpinMm: mmN.nullable(),
    frontAxleAheadMm: mmN.nullable(),
    group: axleType,
    groupCenterMm: mmN.positive(),
    groupSpacingMm: mmN,
    techGroupKg: kgN.nullable(),
    techFrontKg: kgN.nullable(),
    tareKg: kgN,
    tareCgMm: mmN.nullable(),
    cargoStartMm: mmN,
    verification: ver,
    source: z.string().nullable(),
  }),
  profile: z.object({
    id: z.number().int(),
    code: z.string(),
    name: z.string(),
    country: z.string().nullable(),
    limits: z.object({ STEER: kgN.nullable(), SINGLE_DUAL: kgN.nullable(), TANDEM2: kgN.nullable(), TANDEM3: kgN.nullable() }),
    maxGrossKg: kgN.nullable(),
    warnPct: z.number().min(0).max(100),
    axleTolPct: z.number().min(0).max(100).nullable(),
    grossTolPct: z.number().min(0).max(100).nullable(),
    verification: ver,
    source: z.string().nullable(),
  }),
  containerFrontMm: mmN.optional(),
})

export const loadDocSchema = z.object({
  space: spaceSchema,
  limits: z.array(limitSchema),
  packs: z.record(z.string(), packSnapshotSchema),
  pallets: z.record(z.string(), palletDocSchema),
  units: z.array(unitSchema).max(5000),
  road: roadSchema.optional(),
})
