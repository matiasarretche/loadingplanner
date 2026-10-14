/**
 * ORDEM DOS PRODUTOS NUMA LISTA (regra do Matías, 14/10/2026): largura da menor para a maior (silo-bolsa: o
 * diâmetro), depois o comprimento, depois a espessura. Empates — mesma medida e espessura, como as versões
 * BPT / BBT / BPM da fábrica — pela capacidade, pelo nome e pelo código, para a ordem nunca variar
 * (o nome sem sufixo vem antes: "… × 240 µm" < "… × 240 µm (BBT)").
 */
export interface CatalogOrderKey {
  /** largura para ordenar, em metros (silo-bolsa: diâmetro convertido para metros) */
  widthM: number | null
  lengthM: number | null
  thicknessUm: number | null
  capacityL?: number | null
  name: string
  sku: string
}

const n = (x: number | null | undefined) => x ?? 0
/** sem capacidade cadastrada → depois das que têm (valores ausentes vão para o fim, como em productOrder) */
const cap = (a: number | null | undefined, b: number | null | undefined) => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : a - b)

export function compareCatalogOrder(a: CatalogOrderKey, b: CatalogOrderKey): number {
  return (
    n(a.widthM) - n(b.widthM) ||
    n(a.lengthM) - n(b.lengthM) ||
    n(a.thicknessUm) - n(b.thicknessUm) ||
    cap(a.capacityL, b.capacityL) ||
    // numérico: "c/2 un" antes de "c/15 un"
    a.name.localeCompare(b.name, 'pt-BR', { numeric: true }) ||
    a.sku.localeCompare(b.sku)
  )
}
