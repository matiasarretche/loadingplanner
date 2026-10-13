/**
 * Estado detalhado da carga (para editor, otimizador e Assistente IA):
 * palete completo × parcial, caixa solta no piso × empilhada, posição, orientação, pesos e espaço livre.
 */
import { Orientation, Vec3 } from './geometry'
import { effectiveLimits, loadGeometries, loadSummary } from './load'
import { palletBoxCounts } from './partial'
import type { LoadDoc } from './types'

export type UnitStatus = 'PALLET_FULL' | 'PALLET_PARTIAL' | 'BOX_ON_FLOOR' | 'BOX_STACKED'

export interface UnitState {
  id: string
  label: string
  status: UnitStatus
  skus: string[]
  boxes: number
  /** caixas quando completo (paletes) */
  fullBoxes: number | null
  pos: Vec3
  size: Vec3
  /** palete: girado 90°; caixa: orientação */
  orientation: Orientation | 'yaw' | 'no-yaw'
  grossKg: number
  topMm: number
}

export interface LoadState {
  units: UnitState[]
  counts: { fullPallets: number; partialPallets: number; boxesOnFloor: number; boxesStacked: number }
  /** maior altura ocupada e altura útil restante acima dela */
  maxTopMm: number
  heightLimitMm: number
  payloadKg: number
  remainingPayloadKg: number | null
  freeVolumeM3: number
  freeLengthMm: number
}

export function loadState(doc: LoadDoc): LoadState {
  const geoms = loadGeometries(doc)
  const sm = loadSummary(doc, geoms)
  const lim = effectiveLimits(doc)
  const units: UnitState[] = geoms.map((g) => {
    const u = g.unit
    const top = g.box.min.z + g.box.size.z
    if (u.kind === 'PALLET') {
      const c = palletBoxCounts(doc.pallets[u.palletKey])
      return {
        id: u.id,
        label: g.label,
        status: c.partial ? 'PALLET_PARTIAL' : 'PALLET_FULL',
        skus: g.bySku.map((l) => l.sku),
        boxes: c.boxes,
        fullBoxes: c.fullBoxes,
        pos: g.box.min,
        size: g.box.size,
        orientation: u.yaw ? 'yaw' : 'no-yaw',
        grossKg: g.grossKg,
        topMm: top,
      }
    }
    return {
      id: u.id,
      label: g.label,
      status: g.box.min.z > 0 ? 'BOX_STACKED' : 'BOX_ON_FLOOR',
      skus: g.bySku.map((l) => l.sku),
      boxes: 1,
      fullBoxes: null,
      pos: g.box.min,
      size: g.box.size,
      orientation: u.orientation,
      grossKg: g.grossKg,
      topMm: top,
    }
  })
  const count = (s: UnitStatus) => units.filter((u) => u.status === s).length
  const heightLimit = Math.min(lim.heightMm.value ?? doc.space.inner.h, doc.space.inner.h)
  return {
    units,
    counts: { fullPallets: count('PALLET_FULL'), partialPallets: count('PALLET_PARTIAL'), boxesOnFloor: count('BOX_ON_FLOOR'), boxesStacked: count('BOX_STACKED') },
    maxTopMm: units.reduce((m, u) => Math.max(m, u.topMm), 0),
    heightLimitMm: heightLimit,
    payloadKg: sm.payloadKg,
    remainingPayloadKg: lim.payloadKg.value != null ? Math.max(0, lim.payloadKg.value - sm.payloadKg) : null,
    freeVolumeM3: Math.max(0, sm.innerCbm - sm.cbmUnits),
    freeLengthMm: sm.freeLengthMm,
  }
}
