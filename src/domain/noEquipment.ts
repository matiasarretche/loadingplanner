/**
 * Envios SEM equipamento (LCL, aéreo carga solta, só paletes, courier): operações sobre o piso virtual.
 */
import { AIR_KG_PER_M3, loadGeometries } from './load'
import { COURIER_DIVISOR_DEFAULT, courierPlan } from './courier'
import { packKeyOf } from './kitBoxes'
import type { OrderLine } from './mixedPallets'
import { fitNoneFloor, withNoneWorkArea } from './shipmentType'
import type { LoadDoc, PackSnapshot } from './types'

const maxX = (doc: LoadDoc) => Math.max(0, ...loadGeometries(doc).map((g) => g.box.min.x + g.box.size.x))

/** piso virtual do tamanho do conteúdo (nada muda em cargas com equipamento) */
export const fitNone = (doc: LoadDoc): LoadDoc => fitNoneFloor(doc, maxX)

/** aplica uma operação de posicionamento num piso longo e depois encolhe o piso ao conteúdo */
export function onNoneWorkArea<T extends { doc: LoadDoc }>(doc: LoadDoc, op: (d: LoadDoc) => T): T {
  if (doc.space.kind !== 'NONE') return op(doc)
  const r = op(withNoneWorkArea(doc))
  return { ...r, doc: fitNone(r.doc) }
}

/** Pedido (caixas por embalagem) contido na carga: paletes + volumes soltos. */
export function docOrderLines(doc: LoadDoc): OrderLine[] {
  const by = new Map<string, OrderLine>()
  const add = (pack: PackSnapshot, n: number) => {
    // caixas coletivas de kits (26 / meia caixa) são embalagens distintas da individual
    const k = packKeyOf(pack)
    const cur = by.get(k) ?? { packId: k, pack, boxes: 0 }
    cur.boxes += n
    by.set(k, cur)
  }
  for (const u of doc.units) {
    if (u.kind === 'PACKAGE') {
      const p = doc.packs[u.packId]
      if (p) add(p, 1)
    } else {
      const pd = doc.pallets[u.palletKey]
      for (const it of pd?.items ?? []) if (pd.packs[it.packId]) add(pd.packs[it.packId], 1)
    }
  }
  return [...by.values()]
}

export interface NoneMetrics {
  pallets: number
  boxes: number
  grossKg: number
  netKg: number
  /** volume ocupado (envelope dos paletes / caixas), m³ */
  cbm: number
  /** aéreo carga solta: peso taxável estimado (IATA 1:6000) */
  chargeableKg: number | null
  /** courier: peso volumétrico e taxável (estimativa; o da transportadora prevalece) */
  courier: { pieces: number; volKg: number; chargeableKg: number; divisor: number } | null
}

/** Números de um envio sem equipamento (para o editor, o painel e os PDFs). */
export function noneMetrics(doc: LoadDoc): NoneMetrics {
  const geoms = loadGeometries(doc)
  const grossKg = geoms.reduce((s, g) => s + g.grossKg, 0)
  const netKg = geoms.reduce((s, g) => s + g.netKg, 0)
  const cbm = geoms.reduce((s, g) => s + (g.box.size.x * g.box.size.y * g.box.size.z) / 1e9, 0)
  const boxes = docOrderLines(doc).reduce((s, l) => s + l.boxes, 0)
  const service = doc.space.service
  const cp = service === 'COURIER' ? courierPlan(docOrderLines(doc), doc.space.courierDivisor ?? COURIER_DIVISOR_DEFAULT) : null
  return {
    pallets: doc.units.filter((u) => u.kind === 'PALLET').length,
    boxes,
    grossKg,
    netKg,
    cbm,
    chargeableKg: service === 'AIR_LOOSE' ? Math.max(grossKg, cbm * AIR_KG_PER_M3) : cp ? cp.totals.chargeableKg : null,
    courier: cp ? { pieces: cp.totals.pieces, volKg: cp.totals.volKg, chargeableKg: cp.totals.chargeableKg, divisor: cp.divisor } : null,
  }
}
