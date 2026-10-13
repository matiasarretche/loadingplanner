/**
 * Os TRÊS pesos da Pacifil (DUE, documentos e telas):
 *   - Peso líquido                 = só o produto                          (netKg)
 *   - Peso líquido com embalagem   = produto + caixa                       (grossKg do volume / bySku)
 *   - Peso bruto                   = produto + caixa + palete (tara)       (payload da carga)
 * O peso com a tara do equipamento (contêiner/veículo) é outro número: "peso total com equipamento".
 */
import { palletSummary } from './pallet'
import type { LoadDoc } from './types'

/**
 * Tara dos paletes (e acessórios) atribuída a cada produto: em cada palete carregado, a tara é
 * repartida entre os produtos na proporção do peso com embalagem de cada um. Volumes soltos não têm tara.
 */
export function palletTareBySku(doc: LoadDoc): Map<string, number> {
  const out = new Map<string, number>()
  for (const u of doc.units) {
    if (u.kind !== 'PALLET') continue
    const p = doc.pallets[u.palletKey]
    if (!p) continue
    const s = palletSummary(p)
    const goods = s.bySku.reduce((t, l) => t + l.grossKg, 0)
    const tare = s.grossKg - goods
    if (!(tare > 0)) continue
    for (const l of s.bySku) {
      const share = goods > 0 ? l.grossKg / goods : 1 / s.bySku.length
      out.set(l.sku, (out.get(l.sku) ?? 0) + tare * share)
    }
  }
  return out
}
