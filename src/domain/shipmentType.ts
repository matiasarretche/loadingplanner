/**
 * TIPO DE ENVIO — fonte única. Toda carga nasce em "Nova carga" com um destes tipos:
 *  - com equipamento (editor 3D): FCL (contêiner), ROAD (caminhão), AIR_ULD (aéreo em ULD);
 *  - sem equipamento: LCL (marítimo consolidado), ROAD_LTL (caminhão consolidado / carga fracionada),
 *    AIR_LOOSE (aéreo carga solta, paletes), PALLETS_ONLY (só paletes) e COURIER (volumes/caixas).
 * As cargas sem equipamento usam um "piso virtual" (space.kind = 'NONE'): os paletes/caixas ficam
 * lado a lado num piso de 2,4 m de largura cujo comprimento acompanha o conteúdo; a altura do
 * espaço é a altura máxima do palete carregado (ou da pilha de caixas no courier).
 */
import type { LoadDoc, SpaceSnapshot } from './types'

export const SHIPMENT_SERVICES = ['FCL', 'ROAD', 'AIR_ULD', 'LCL', 'ROAD_LTL', 'AIR_LOOSE', 'PALLETS_ONLY', 'COURIER'] as const
export type ShipmentService = (typeof SHIPMENT_SERVICES)[number]
export type NoEquipmentService = 'LCL' | 'ROAD_LTL' | 'AIR_LOOSE' | 'PALLETS_ONLY' | 'COURIER'
export type TransportMode = 'SEA' | 'ROAD' | 'AIR'

export interface TypeInfo {
  label: string
  /** rótulo curto para listas */
  short: string
  /** modalidade de transporte gravada no pedido (null = não se aplica) */
  mode: TransportMode | null
  equipment: boolean
  /** como chamar origem/destino: portos, aeroportos ou endereços */
  placeMode: TransportMode
  /** modo do planejador de paletes mistos / IA */
  plannerMode: 'FCL' | 'ROAD' | 'AIR' | 'LCL' | 'PALLETS_ONLY' | 'COURIER'
  /** altura máxima padrão do palete carregado (mm) — sem equipamento */
  defaultHeightMm?: number
  hint: string
}

export const TYPE_INFO: Record<ShipmentService, TypeInfo> = {
  FCL: { label: 'Contêiner completo (FCL)', short: 'FCL', mode: 'SEA', equipment: true, placeMode: 'SEA', plannerMode: 'FCL', hint: 'Marítimo, editor 3D do contêiner' },
  ROAD: { label: 'Caminhão', short: 'Caminhão', mode: 'ROAD', equipment: true, placeMode: 'ROAD', plannerMode: 'ROAD', hint: 'Rodoviário, editor 3D do veículo e carga por eixo' },
  AIR_ULD: { label: 'Aéreo em ULD', short: 'Aéreo ULD', mode: 'AIR', equipment: true, placeMode: 'AIR', plannerMode: 'AIR', hint: 'Aéreo com ULD, editor 3D' },
  LCL: { label: 'Marítimo consolidado (LCL)', short: 'LCL', mode: 'SEA', equipment: false, placeMode: 'SEA', plannerMode: 'LCL', defaultHeightMm: 2000, hint: 'Paletes mistos, sem contêiner' },
  ROAD_LTL: { label: 'Caminhão consolidado', short: 'Caminhão consol.', mode: 'ROAD', equipment: false, placeMode: 'ROAD', plannerMode: 'ROAD', defaultHeightMm: 2000, hint: 'Rodoviário fracionado, paletes mistos, sem veículo' },
  AIR_LOOSE: { label: 'Aéreo carga solta (paletes)', short: 'Aéreo solto', mode: 'AIR', equipment: false, placeMode: 'AIR', plannerMode: 'AIR', defaultHeightMm: 1600, hint: 'Paletes mistos, sem ULD; peso taxável' },
  PALLETS_ONLY: { label: 'Só paletes', short: 'Só paletes', mode: null, equipment: false, placeMode: 'ROAD', plannerMode: 'PALLETS_ONLY', defaultHeightMm: 2000, hint: 'Otimização de paletes mistos' },
  COURIER: { label: 'Courier (DHL, FedEx…)', short: 'Courier', mode: null, equipment: false, placeMode: 'ROAD', plannerMode: 'COURIER', hint: 'Caixas soltas; peso real, volumétrico e taxável' },
}

export const isService = (s: unknown): s is ShipmentService => typeof s === 'string' && (SHIPMENT_SERVICES as readonly string[]).includes(s)
export const isNoEquipment = (s: ShipmentService | null | undefined): s is NoEquipmentService => s != null && !TYPE_INFO[s].equipment
export const isNoneSpace = (space: Pick<SpaceSnapshot, 'kind'>) => space.kind === 'NONE'

/** tipo de um pedido antigo (antes do campo service): pela modalidade */
export const serviceFromMode = (mode: string | null | undefined): ShipmentService => (mode === 'ROAD' ? 'ROAD' : mode === 'AIR' ? 'AIR_ULD' : 'FCL')

/** tipo efetivo do pedido (service gravado; senão, pela modalidade) */
export const serviceOf = (sh: { service?: string | null; mode?: string | null } | null | undefined): ShipmentService =>
  sh && isService(sh.service) ? sh.service : serviceFromMode(sh?.mode)

/** Largura do piso virtual (dois paletes de 1200 lado a lado). */
export const NONE_FLOOR_W = 2400
/** Comprimento de trabalho enquanto o motor posiciona (depois o piso encolhe ao conteúdo). */
export const NONE_WORK_L = 100_000
/** Altura da pilha de caixas no desenho do courier. */
export const COURIER_STACK_H = 1500
/** Divisor volumétrico padrão do courier (cm³/kg). */
export const DEFAULT_COURIER_DIVISOR = 5000

/** Espaço (piso virtual) de um envio sem equipamento. */
export function noneSpace(service: NoEquipmentService, o: { maxHeightMm?: number | null; courierDivisor?: number | null } = {}): SpaceSnapshot {
  const h = service === 'COURIER' ? COURIER_STACK_H : Math.round(o.maxHeightMm ?? TYPE_INFO[service].defaultHeightMm ?? 2000)
  return {
    kind: 'NONE',
    typeId: 0,
    code: TYPE_INFO[service].short,
    name: TYPE_INFO[service].label,
    inner: { l: NONE_FLOOR_W, w: NONE_FLOOR_W, h },
    door: { w: NONE_FLOOR_W, h },
    tareKg: 0,
    maxPayloadKg: null,
    maxGrossKg: null,
    floorLoadKgPerM: null,
    source: null,
    verification: 'VERIFIED',
    transport: TYPE_INFO[service].mode ?? undefined,
    service,
    ...(service === 'COURIER' ? { courierDivisor: Math.round(o.courierDivisor ?? DEFAULT_COURIER_DIVISOR) } : { maxLoadHeightMm: h }),
  }
}

/** Piso longo para o motor posicionar (paletes mistos, volumes soltos). */
export function withNoneWorkArea(doc: LoadDoc): LoadDoc {
  if (doc.space.kind !== 'NONE' || doc.space.inner.l === NONE_WORK_L) return doc
  return { ...doc, space: { ...doc.space, inner: { ...doc.space.inner, l: NONE_WORK_L } } }
}

/**
 * Piso virtual do tamanho do conteúdo: comprimento = até a última unidade (mín. 1 palete), largura
 * fixa. Idempotente (devolve o mesmo objeto quando nada muda).
 */
export function fitNoneFloor(doc: LoadDoc, unitMaxX: (doc: LoadDoc) => number): LoadDoc {
  if (doc.space.kind !== 'NONE') return doc
  const l = Math.max(1200, Math.ceil(unitMaxX(doc)))
  if (doc.space.inner.l === l) return doc
  return { ...doc, space: { ...doc.space, inner: { ...doc.space.inner, l } } }
}

/** colunas da versão (space_kind / space_type_id) a partir do espaço */
export const versionSpaceColumns = (space: SpaceSnapshot) => ({ spaceKind: space.kind, spaceTypeId: space.kind === 'NONE' ? 0 : space.typeId })

/** o espaço da carga corresponde ao tipo do pedido? (erro em texto, ou null) */
export function docServiceError(space: SpaceSnapshot, service: ShipmentService): string | null {
  if (isNoEquipment(service)) return space.kind === 'NONE' && space.service === service ? null : 'O envio é sem equipamento: o espaço da carga não pode ser trocado por um contêiner/veículo.'
  if (space.kind === 'NONE') return 'Este envio usa equipamento (contêiner/veículo/ULD).'
  if (service === 'ROAD' && space.kind !== 'VEHICLE') return 'Envio rodoviário: escolha um veículo.'
  if (service === 'FCL' && (space.kind !== 'CONTAINER' || space.transport === 'AIR')) return 'Envio FCL: escolha um contêiner marítimo.'
  if (service === 'AIR_ULD' && (space.kind !== 'CONTAINER' || space.transport !== 'AIR')) return 'Envio aéreo em ULD: escolha uma ULD.'
  return null
}
