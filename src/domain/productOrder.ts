/**
 * ORDEM ÚNICA DE PRODUTOS em toda a plataforma (catálogo logístico, produtos, seletores do editor,
 * paletes mistos, montagens, PDFs…). Mantém a ordem das famílias; dentro de cada família ordena pelas
 * MEDIDAS NUMÉRICAS (nunca alfabética: 5, 6, 8, 9, 10, 12, 14 pés — não 10, 12, 5…):
 *  - Silo-bolsa:        diâmetro (pés) → comprimento → espessura
 *  - Lona de silagem:   largura → comprimento → espessura (também Filmes em rolo)
 *  - Hidrosilo / Hydroforce: largura (2 m, 3 m) → capacidade (litros)
 *  - Animal Comfort:    largura → comprimento
 * Valores ausentes vão para o fim; empates: marca (Pacifil primeiro) e código em ordem natural.
 */
type Attrs = Record<string, unknown> | null | undefined

export interface ProductOrderInput {
  /** ordem da família (product_family.sort); famílias sem ordem vão ao fim */
  familySort?: number | null
  familyName?: string | null
  attrs?: Attrs
  thicknessUm?: number | null
  sku: string
  brand?: string | null
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.replace(',', '.')))) return Number(v.replace(',', '.'))
  return null
}
const norm = (s?: string | null) => (s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

export type ProductKind = 'silo' | 'lona' | 'hidro' | 'animal' | 'other'

/** Tipo de produto pela família (nome) — define o critério de ordem. */
export function productKind(familyName?: string | null): ProductKind {
  const f = norm(familyName)
  if (/silo.?bols|silobag|silo bag/.test(f)) return 'silo'
  if (/lona|silag/.test(f)) return 'lona'
  // filmes em rolo (BPF / BigSafe finos): medidas de lona — largura × comprimento × espessura
  if (/film/.test(f)) return 'lona'
  if (/hidro|hydro/.test(f)) return 'hidro'
  if (/animal|comfort|conforto/.test(f)) return 'animal'
  return 'other'
}

/** comprimento em metros (m, aproximado ou convertido de pés) */
function lengthM(a: Record<string, unknown>): number | null {
  return num(a.comprimento_m) ?? num(a.comprimento_m_aprox) ?? (num(a.comprimento_ft) != null ? num(a.comprimento_ft)! * 0.3048 : null)
}

/** Chave numérica de ordenação dentro da família (menor primeiro; ausente = Infinity). */
export function productSortKey(p: ProductOrderInput): number[] {
  const a = (p.attrs ?? {}) as Record<string, unknown>
  const v = (x: number | null | undefined) => (x == null ? Infinity : x)
  const thick = p.thicknessUm ?? num(a.espessura_um)
  const L = lengthM(a)
  switch (productKind(p.familyName)) {
    case 'silo':
      return [v(num(a.diametro_ft) ?? (num(a.diametro_m) != null ? num(a.diametro_m)! / 0.3048 : null)), v(L), v(thick)]
    case 'lona':
      return [v(num(a.largura_m)), v(L), v(thick)]
    case 'hidro':
      // primeiro a largura (2 m, 3 m…), depois a capacidade em litros
      return [v(num(a.largura_m)), v(num(a.capacidade_l)), v(L), v(thick)]
    case 'animal':
      return [v(num(a.largura_m)), v(L), v(thick)]
    default:
      return [v(num(a.capacidade_l)), v(num(a.diametro_ft)), v(num(a.largura_m)), v(L), v(thick)]
  }
}

const brandRank = (b?: string | null) => (norm(b) === 'pacifil' ? 0 : 1)

export function compareProducts(x: ProductOrderInput, y: ProductOrderInput): number {
  const fs = (x.familySort ?? Infinity) - (y.familySort ?? Infinity)
  if (fs && Number.isFinite(fs)) return fs
  if ((x.familySort == null) !== (y.familySort == null)) return x.familySort == null ? 1 : -1
  if (x.familyName !== y.familyName) return (x.familyName ?? '').localeCompare(y.familyName ?? '', 'pt-BR')
  const kx = productSortKey(x), ky = productSortKey(y)
  for (let i = 0; i < Math.max(kx.length, ky.length); i++) {
    const a = kx[i] ?? Infinity, b = ky[i] ?? Infinity
    if (a !== b) return a === Infinity ? 1 : b === Infinity ? -1 : a - b
  }
  const br = brandRank(x.brand) - brandRank(y.brand)
  if (br) return br
  if (norm(x.brand) !== norm(y.brand)) return (x.brand ?? '').localeCompare(y.brand ?? '', 'pt-BR')
  return x.sku.localeCompare(y.sku, 'pt-BR', { numeric: true })
}

/** Ordena uma lista qualquer de itens de produto pelo critério único. */
export function sortProducts<T>(items: T[], get: (t: T) => ProductOrderInput): T[] {
  return items
    .map((t) => ({ t, k: get(t) }))
    .sort((a, b) => compareProducts(a.k, b.k))
    .map((x) => x.t)
}

/** Famílias onde a espessura (µm) é dado obrigatório do produto (filmes plásticos). */
export function needsThickness(familyName?: string | null): boolean {
  return productKind(familyName) !== 'other' || !/acess|kit|acces/.test(norm(familyName))
}

/** Campos técnicos próprios que cada família exige (vazio → vermelho). 'length' = comprimento em m OU em pés. */
export type TechField = 'diameterFt' | 'widthM' | 'length' | 'thicknessUm'

export const TECH_FIELD_LABEL: Record<TechField, string> = { diameterFt: 'diâmetro (pés)', widthM: 'largura (m)', length: 'comprimento', thicknessUm: 'espessura (µm)' }

export function requiredFields(familyName?: string | null): TechField[] {
  switch (productKind(familyName)) {
    case 'silo':
      return ['diameterFt', 'length', 'thicknessUm']
    case 'lona':
    case 'hidro':
      return ['widthM', 'length', 'thicknessUm']
    case 'animal':
      return ['widthM', 'length']
    default:
      return needsThickness(familyName) ? ['thicknessUm'] : []
  }
}

/** Campos exigidos pela família que estão sem valor. */
export function missingFields(familyName: string | null | undefined, c: { thicknessUm?: number | null; diameterFt?: number | null; widthM?: number | null; lengthM?: number | null; lengthFt?: number | null }): TechField[] {
  return requiredFields(familyName).filter((f) => (f === 'length' ? c.lengthM == null && c.lengthFt == null : c[f] == null))
}
