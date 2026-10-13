/** Paleta de cores por produto (bem distintas entre si, legíveis com texto escuro na etiqueta). */
export const SKU_PALETTE = [
  '#2f7ebc', '#e07b39', '#3a9d5d', '#c44e52', '#8c6bb1', '#d4a72c', '#1f9e9a', '#b5577e', '#6c8ebf', '#7f8c3a',
  '#a0522d', '#4b6584', '#e15f99', '#5aa02c', '#9467bd', '#17becf', '#bcbd22', '#ff7f0e', '#8c564b', '#2ca02c',
]

/** Cor padrão de um SKU (hash estável sobre as 12 primeiras cores — as mesmas de sempre; as demais desempatam). */
export function skuColor(sku: string): string {
  let h = 0
  for (const c of sku) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return SKU_PALETTE[h % 12]
}

/**
 * Cores para exibição de uma carga: cada SKU mantém sua cor padrão, a não ser que outro SKU da MESMA
 * carga já a use; nesse caso recebe a próxima cor livre da paleta (determinístico: ordem alfabética).
 */
export function distinctSkuColors(skus: { sku: string; color?: string }[]): Map<string, string> {
  const out = new Map<string, string>()
  const used = new Set<string>()
  const uniq = [...new Map(skus.map((s) => [s.sku, s])).values()].sort((a, b) => a.sku.localeCompare(b.sku))
  for (const s of uniq) {
    let c = s.color ?? skuColor(s.sku)
    if (used.has(c)) c = SKU_PALETTE.find((p) => !used.has(p)) ?? c
    used.add(c)
    out.set(s.sku, c)
  }
  return out
}
