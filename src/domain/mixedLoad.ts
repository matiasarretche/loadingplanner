/**
 * Coloca paletes mistos (já otimizados) no equipamento da carga: maiores e mais pesados primeiro,
 * piso e empilhamento pelo motor (placePallets) e, no fim, distribuição de peso por quadrantes.
 * Usado pelo editor ("Colocar na carga") e pelo Assistente IA.
 */
import { placePallets } from './autoload'
import { balanceWeight } from './balance'
import { palletSummary } from './pallet'
import type { LoadDoc, PalletDoc } from './types'

export interface MixedLoadResult {
  doc: LoadDoc
  placed: number
  /** números (1-based) dos paletes que não couberam */
  failed: number[]
  balanced: boolean
}

export function placeMixedPalletsInLoad(doc0: LoadDoc, pallets: PalletDoc[], stamp: string): MixedLoadResult {
  const ordered = pallets
    .map((p, i) => ({ p, i, kg: palletSummary(p).grossKg, area: p.palletType.dims.l * p.palletType.dims.w }))
    .sort((a, b) => b.area - a.area || b.kg - a.kg || a.i - b.i)
  let d = doc0
  let placed = 0
  const failed: number[] = []
  for (const { p, i } of ordered) {
    const skus = [...new Set(Object.values(p.packs).map((k) => k.sku))].join('+')
    const r = placePallets(d, `${stamp}_${i + 1}`, { ...p, name: `Misto ${i + 1} · ${skus}` }, 1)
    if (r.placed) {
      d = r.doc
      placed++
    } else failed.push(i + 1)
  }
  if (!placed) return { doc: doc0, placed: 0, failed, balanced: false }
  // sem equipamento (piso virtual): não há distribuição de peso a fazer
  if (d.space.kind === 'NONE') return { doc: d, placed, failed: failed.sort((a, c) => a - c), balanced: false }
  const b = balanceWeight(d)
  const balanced = b.doc !== d && b.physicalIssuesAfter === 0
  return { doc: balanced ? b.doc : d, placed, failed: failed.sort((a, c) => a - c), balanced }
}
