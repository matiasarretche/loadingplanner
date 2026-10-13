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

/**
 * Nome do palete montado pelo planejador: "Misto N · A+B" SÓ quando leva mais de um produto; palete de um
 * produto só (os acompanhantes obrigatórios, ex.: KIT-HF, não contam como outro produto) leva o código do
 * produto — sem número, para que paletes iguais se agrupem no PDF ("HS-2M-50K" × 3).
 */
export function plannerPalletName(p: PalletDoc, index: number): string {
  const companionSkus = new Set(Object.values(p.packs).flatMap((k) => (k.companions ?? []).map((c) => c.sku.toUpperCase())))
  const skus = [...new Set(Object.values(p.packs).map((k) => k.sku))]
  const main = skus.filter((s) => !companionSkus.has(s.toUpperCase()))
  if (main.length <= 1) {
    const kits = skus.filter((s) => companionSkus.has(s.toUpperCase()))
    return `${main[0] ?? skus[0] ?? `Palete ${index}`}${main.length && kits.length ? ` + ${kits.join('+')}` : ''}`
  }
  return `Misto ${index} · ${skus.join('+')}`
}

/**
 * Nome para exibir: cargas antigas chamavam de "Misto N · …" todo palete do planejador, até os de um produto
 * só (com ou sem KIT-HF) → recalcula pelo conteúdo do palete; os mistos de verdade continuam "Misto N · A+B".
 */
export function palletDisplayName(p: PalletDoc): string {
  const m = /^Misto (\d+) · /.exec(p.name)
  return m ? plannerPalletName(p, Number(m[1])) : p.name
}

export function placeMixedPalletsInLoad(doc0: LoadDoc, pallets: PalletDoc[], stamp: string): MixedLoadResult {
  const ordered = pallets
    .map((p, i) => ({ p, i, kg: palletSummary(p).grossKg, area: p.palletType.dims.l * p.palletType.dims.w }))
    .sort((a, b) => b.area - a.area || b.kg - a.kg || a.i - b.i)
  let d = doc0
  let placed = 0
  const failed: number[] = []
  for (const { p, i } of ordered) {
    const r = placePallets(d, `${stamp}_${i + 1}`, { ...p, name: plannerPalletName(p, i + 1) }, 1)
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
