import type { RoadSetup } from './axles'
import type { Dims, Orientation, Vec3 } from './geometry'

export type Verification = 'VERIFIED' | 'ESTIMATED' | 'UNVERIFIED'

/**
 * Snapshots: cópias imutáveis dos cadastros no momento em que entram numa montagem/carga.
 * Uma edição posterior do cadastro NUNCA altera uma carga já salva.
 */
export interface PackSnapshot {
  packagingVersionId: number
  version: number
  sku: string
  name: string
  packageType: string
  dims: Dims
  netKg: number
  grossKg: number
  unitsPerPackage: number
  allowedOrientations: Orientation[]
  stackable: boolean
  maxStackLayers: number | null
  maxStackKg: number | null
  fragile: boolean
  verification: Verification
  color: string
  /** preço de referência no momento do snapshot (opcional; cargas antigas não têm) */
  price?: PriceSnapshot | null
  /** acompanhantes obrigatórios por caixa (ex.: 1 kit por Hydroforce) — ver domain/companions */
  companions?: { sku: string; qty: number }[]
  /**
   * MÁXIMO de caixas por palete do catálogo logístico (regra estrita: a montagem automática nunca passa
   * disso; pode pôr menos). Snapshots antigos não têm (sem limite).
   */
  boxesPerPallet?: number | null
  /**
   * Caixa COLETIVA de kits (ex.: caixa 79583 com 26 KIT-HF; meia caixa até 13): mesmo SKU do kit,
   * unitsPerPackage = kits dentro; `unit` guarda a caixa individual do catálogo (ver domain/kitBoxes).
   */
  kitBox?: KitBoxSnapshot
}

export interface KitBoxSnapshot {
  kind: 'BIG' | 'HALF'
  code: string
  /** kits por caixa (máximo) */
  capacity: number
  /** kits dentro desta caixa */
  kits: number
  /** embalagem individual de origem */
  unit: { dims: Dims; netKg: number; grossKg: number; unitsPerPackage: number; allowedOrientations: Orientation[] }
}

export type PriceUnit = 'UNIT' | 'BOX' | 'PALLET'

export interface PriceSnapshot {
  amount: number
  currency: string
  /** por unidade de produto, por caixa (volume) ou por palete */
  per: PriceUnit
}

export interface PalletTypeSnapshot {
  palletTypeId: number
  code: string
  name: string
  dims: Dims
  tareKg: number
  staticMaxKg: number | null
  dynamicMaxKg: number | null
  maxLoadKg: number | null
  overhangAllowed: boolean
  overhangMaxMm: number
  verification: Verification
}

export interface PalletItem {
  id: string
  packId: string
  /** Posição local: x/y a partir do canto do palete; z a partir do topo do tabuleiro. */
  pos: Vec3
  orientation: Orientation
  locked: boolean
}

export interface PalletDoc {
  name: string
  palletType: PalletTypeSnapshot
  packs: Record<string, PackSnapshot>
  items: PalletItem[]
  /** Aceita outro palete por cima? */
  stackable: boolean
  maxTopKg: number | null
  /** Peso de acessórios (filme, cantoneiras, fitas…) somado ao bruto do palete. */
  accessoriesKg: number
  /** palete PARCIAL: chave da montagem de origem e quantidade de caixas quando completo */
  baseKey?: string
  fullBoxes?: number
}

/** NONE = envio sem equipamento (LCL, aéreo carga solta, só paletes, courier): piso virtual */
export type SpaceKind = 'CONTAINER' | 'VEHICLE' | 'NONE'

export interface SpaceSnapshot {
  kind: SpaceKind
  typeId: number
  code: string
  name: string
  inner: Dims
  door: { w: number; h: number }
  tareKg: number
  maxPayloadKg: number | null
  maxGrossKg: number | null
  floorLoadKgPerM: number | null
  source: string | null
  verification: Verification
  /** modal do equipamento; AIR = ULD aérea (peso taxável volumétrico) */
  transport?: 'SEA' | 'ROAD' | 'AIR'
  /** comprimento útil do CADASTRO quando o comprimento foi informado na carga (inner.l = o informado) */
  baseInnerL?: number
  /** só kind NONE: tipo do envio sem equipamento */
  service?: 'LCL' | 'ROAD_LTL' | 'AIR_LOOSE' | 'PALLETS_ONLY' | 'COURIER'
  /** só kind NONE (paletes): altura máxima do palete carregado (= inner.h) */
  maxLoadHeightMm?: number
  /** só COURIER: divisor volumétrico (cm³/kg) */
  courierDivisor?: number
}

export type LimitScope = 'CARRIER' | 'LEGAL' | 'ROUTE' | 'OPERATIONAL'

export interface LimitSnapshot {
  profileId: number
  name: string
  scope: LimitScope
  maxPayloadKg: number | null
  maxGrossKg: number | null
  maxHeightMm: number | null
  minSupportPct: number | null
  cgLongTolPct: number | null
  cgLatTolPct: number | null
  lowUtilPct: number | null
}

export interface Thresholds {
  minSupportPct: number
  cgLongTolPct: number
  cgLatTolPct: number
  lowUtilPct: number
  collisionTolMm: number
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  minSupportPct: 70,
  cgLongTolPct: 10,
  cgLatTolPct: 5,
  lowUtilPct: 50,
  collisionTolMm: 0,
}

export type LoadUnit =
  | {
      id: string
      kind: 'PALLET'
      palletKey: string
      pos: Vec3
      /** Palete só gira em torno de Z. */
      yaw: boolean
      locked: boolean
      label?: string
    }
  | {
      id: string
      kind: 'PACKAGE'
      packId: string
      pos: Vec3
      orientation: Orientation
      locked: boolean
      label?: string
    }

export interface LoadDoc {
  space: SpaceSnapshot
  limits: LimitSnapshot[]
  packs: Record<string, PackSnapshot>
  pallets: Record<string, PalletDoc>
  units: LoadUnit[]
  /** rodoviário: cavalo + implemento (ou chassi com o contêiner) + limites por eixo do país */
  road?: RoadSetup
}
