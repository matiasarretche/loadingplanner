import type { schema } from '@/db'
import { skuColor } from '@/domain/colors'
import { companionsFromAttrs } from '@/domain/companions'
import { isOrientation, Orientation } from '@/domain/geometry'
import type { AxleProfileSnapshot, CarrierSnapshot, TractorSnapshot } from '@/domain/axles'
import type { LimitSnapshot, PackSnapshot, PalletTypeSnapshot, SpaceSnapshot } from '@/domain/types'

type PV = typeof schema.packagingVersions.$inferSelect
type Variant = typeof schema.productVariants.$inferSelect
type PT = typeof schema.palletTypes.$inferSelect
type CT = typeof schema.containerTypes.$inferSelect
type VT = typeof schema.vehicleTypes.$inferSelect
type CP = typeof schema.constraintProfiles.$inferSelect

export { skuColor }

export function packSnapshot(pv: PV, v: Variant): PackSnapshot {
  const allowed = (pv.allowedOrientations ?? []).filter(isOrientation) as Orientation[]
  return {
    packagingVersionId: pv.id,
    version: pv.version,
    sku: v.sku,
    name: v.name,
    packageType: pv.packageType,
    dims: { l: pv.lengthMm, w: pv.widthMm, h: pv.heightMm },
    netKg: pv.netKg,
    grossKg: pv.grossKg,
    unitsPerPackage: pv.unitsPerPackage,
    allowedOrientations: allowed.length ? allowed : ['LWH'],
    stackable: pv.stackable,
    maxStackLayers: pv.maxStackLayers,
    maxStackKg: pv.maxStackWeightKg,
    fragile: pv.fragile,
    verification: pv.verification,
    color: skuColor(v.sku),
    price: v.price != null ? { amount: v.price, currency: v.priceCurrency ?? 'USD', per: v.priceUnit ?? 'UNIT' } : null,
    ...(companionsFromAttrs(v.attrs).length ? { companions: companionsFromAttrs(v.attrs) } : {}),
    boxesPerPallet: pv.unitsPerPallet ?? null,
  }
}

export function palletTypeSnapshot(p: PT): PalletTypeSnapshot {
  const incomplete = p.heightMm == null || p.tareKg == null
  return {
    palletTypeId: p.id,
    code: p.code,
    name: p.name,
    dims: { l: p.lengthMm, w: p.widthMm, h: p.heightMm ?? 0 },
    tareKg: p.tareKg ?? 0,
    staticMaxKg: p.staticMaxKg,
    dynamicMaxKg: p.dynamicMaxKg,
    maxLoadKg: p.maxLoadKg,
    overhangAllowed: p.overhangAllowed,
    overhangMaxMm: p.overhangMaxMm,
    // altura/tara faltando = nunca "verificado"
    verification: incomplete ? 'UNVERIFIED' : p.verification,
  }
}

export function containerSpace(c: CT): SpaceSnapshot {
  return {
    kind: 'CONTAINER',
    typeId: c.id,
    code: c.code,
    name: c.name,
    inner: { l: c.innerLengthMm, w: c.innerWidthMm, h: c.innerHeightMm },
    door: { w: c.doorWidthMm, h: c.doorHeightMm },
    tareKg: c.tareKg,
    maxPayloadKg: c.maxPayloadKg,
    maxGrossKg: c.maxGrossKg,
    floorLoadKgPerM: c.floorLoadKgPerM,
    source: [c.carrier, c.source].filter(Boolean).join(' · ') || null,
    verification: c.verification,
    transport: c.transportMode === 'AIR' ? 'AIR' : 'SEA',
  }
}

export function vehicleSpace(v: VT): SpaceSnapshot {
  return {
    kind: 'VEHICLE',
    typeId: v.id,
    code: v.code,
    name: v.name,
    inner: { l: v.innerLengthMm, w: v.innerWidthMm, h: v.innerHeightMm },
    door: { w: v.doorWidthMm, h: v.doorHeightMm },
    tareKg: v.tareKg,
    maxPayloadKg: v.maxPayloadKg,
    maxGrossKg: v.maxGrossKg,
    floorLoadKgPerM: v.floorLoadKgPerM,
    source: [v.carrier, v.source].filter(Boolean).join(' · ') || null,
    verification: v.verification,
    transport: 'ROAD',
  }
}

export function limitSnapshot(p: CP): LimitSnapshot {
  return {
    profileId: p.id,
    name: p.name,
    scope: p.scope,
    maxPayloadKg: p.maxPayloadKg,
    maxGrossKg: p.maxGrossKg,
    maxHeightMm: p.maxHeightMm,
    minSupportPct: p.minSupportPct,
    cgLongTolPct: p.cgLongTolPct,
    cgLatTolPct: p.cgLatTolPct,
    lowUtilPct: p.lowUtilPct,
  }
}

type RT = typeof schema.roadTractors.$inferSelect
type AP = typeof schema.axleLimitProfiles.$inferSelect

export function tractorSnapshot(t: RT): TractorSnapshot {
  return {
    id: t.id,
    code: t.code,
    name: t.name,
    wheelbaseMm: t.wheelbaseMm,
    fifthWheelAheadMm: t.fifthWheelAheadMm,
    rearGroup: t.rearGroup,
    rearSpacingMm: t.rearSpacingMm,
    tareFrontKg: t.tareFrontKg,
    tareRearKg: t.tareRearKg,
    techFrontKg: t.techFrontKg,
    techRearKg: t.techRearKg,
    verification: t.verification,
    source: t.source,
  }
}

/** Geometria de eixos do veículo/chassi; null se o cadastro ainda não tem os dados mínimos. */
export function carrierSnapshot(v: VT): CarrierSnapshot | null {
  if (!v.carrierKind || !v.axleGroup || v.axleGroupCenterMm == null) return null
  if (v.carrierKind === 'RIGID' ? v.frontAxleAheadMm == null : v.kingpinMm == null) return null
  return {
    id: v.id,
    code: v.code,
    name: v.name,
    kind: v.carrierKind,
    lengthMm: v.lengthMm ?? v.innerLengthMm,
    kingpinMm: v.kingpinMm,
    frontAxleAheadMm: v.frontAxleAheadMm,
    group: v.axleGroup,
    groupCenterMm: v.axleGroupCenterMm,
    groupSpacingMm: v.axleSpacingMm ?? 0,
    techGroupKg: v.techGroupKg,
    techFrontKg: v.techFrontKg,
    tareKg: v.tareKg,
    tareCgMm: v.tareCgMm,
    cargoStartMm: v.cargoStartMm ?? 0,
    verification: v.verification,
    source: v.source,
  }
}

export function axleProfileSnapshot(p: AP): AxleProfileSnapshot {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    country: p.country,
    limits: { STEER: p.steerKg, SINGLE_DUAL: p.singleDualKg, TANDEM2: p.tandem2Kg, TANDEM3: p.tandem3Kg },
    maxGrossKg: p.maxGrossKg,
    warnPct: p.warnPct,
    axleTolPct: p.axleTolPct,
    grossTolPct: p.grossTolPct,
    verification: p.verification,
    source: p.source,
  }
}
