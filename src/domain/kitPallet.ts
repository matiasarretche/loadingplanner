/**
 * PALETE COM KITS NA ALTURA DA CARGA.
 *
 * As montagens padrão (REF) de Hydroforce levam o máximo do catálogo + 1 kit por unidade por cima e
 * algumas passam de 2.292 mm (ex.: 36 HF-2M-5K = 2.390 mm: só 40' HC / rodoviário). Numa carga com altura
 * menor (porta do 20'/40' Dry) usa-se o MAIOR palete do produto que cabe — motor de paletes, kits =
 * unidades nas caixas da regra (domain/kitBoxes), nunca acima do padrão — com aviso. Usado pelo editor de
 * cargas e pelo Assistente IA. Módulo puro.
 */
import { kitBaseOf, kitFamilyOf, packKeyOf } from './kitBoxes'
import { optimizeMixedPallets, OrderLine } from './mixedPallets'
import { palletSummary } from './pallet'
import type { PalletDoc } from './types'

export interface KitPalletFit {
  pallet: PalletDoc
  sku: string
  /** unidades do produto no palete padrão e no que cabe */
  fullUnits: number
  units: number
  /** altura do padrão (com os kits) e limite da carga */
  fullHeightMm: number
  limitMm: number
  /** texto curto para a origem do palete / mensagem do editor */
  note: string
}

/** O produto principal (com kits em caixas coletivas) de um palete de UM produto; null se não for o caso. */
function kitMainOf(pallet: PalletDoc): { packId: string; sku: string } | null {
  const mains = Object.entries(pallet.packs).filter(([, k]) => (k.companions ?? []).some((c) => kitFamilyOf(c.sku)))
  const skus = new Set(mains.map(([, k]) => k.sku))
  if (mains.length !== 1 || skus.size !== 1) return null
  const kitSkus = new Set((mains[0][1].companions ?? []).map((c) => c.sku))
  // só o produto e os kits dele
  if (pallet.items.some((it) => pallet.packs[it.packId] && pallet.packs[it.packId].sku !== mains[0][1].sku && !kitSkus.has(pallet.packs[it.packId].sku))) return null
  return { packId: mains[0][0], sku: mains[0][1].sku }
}

/**
 * Palete com kits mais alto que `limitMm`: devolve o maior palete do produto que cabe (null = cabe como está,
 * não é palete de um produto com kits, ou nem uma unidade cabe).
 */
export function kitPalletForHeight(pallet: PalletDoc, limitMm: number): KitPalletFit | null {
  const h = palletSummary(pallet).totalHeightMm
  if (!Number.isFinite(limitMm) || h <= limitMm + 0.5) return null
  const main = kitMainOf(pallet)
  if (!main) return null
  const pack = pallet.packs[main.packId]
  const n = pallet.items.filter((it) => pallet.packs[it.packId]?.sku === main.sku).length
  const kits = (pack.companions ?? []).map((c) => {
    const k = Object.values(pallet.packs).find((x) => x.sku === c.sku)
    const base = k ? kitBaseOf(k) : null
    return base && kitFamilyOf(base.sku) ? { packId: packKeyOf(base), pack: base, boxes: Math.ceil(n * c.qty) } : null
  })
  if (!n || kits.some((k) => !k)) return null
  const r = optimizeMixedPallets([{ packId: main.packId, pack, boxes: n }, ...(kits as OrderLine[])], { palletTypes: [pallet.palletType], maxHeightMm: limitMm })
  const count = (d: PalletDoc) => d.items.filter((it) => d.packs[it.packId]?.sku === main.sku).length
  const best = r.pallets.map((p) => p.doc).filter((d) => palletSummary(d).totalHeightMm <= limitMm + 0.5).sort((a, b) => count(b) - count(a))[0]
  if (!best || !count(best)) return null
  const m = count(best)
  const lim = Math.round(limitMm)
  return {
    pallet: { ...best, name: `REF · ${main.sku} · ${m} u · até ${lim} mm` },
    sku: main.sku,
    fullUnits: n,
    units: m,
    fullHeightMm: h,
    limitMm,
    note: `o padrão de ${n} un. tem ${Math.round(h)} mm (com os kits) e não passa na altura máx. desta carga (${lim} mm): usado o maior que cabe, ${m} un. + ${m} kits`,
  }
}
