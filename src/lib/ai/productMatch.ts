/**
 * Identificação de produtos a partir de texto livre ("hidro de 10 mil litros", "HS 10000", "o de 10k").
 * Determinístico e sem IA: a IA recebe a lista ranqueada e decide se é inequívoco ou se precisa perguntar.
 */
export interface MatchCandidate {
  sku: string
  name: string
  family: string
  line: string
  /** atributos numéricos relevantes (capacidade_l, diametro_ft, comprimento_m, largura_m…) */
  attrs: Record<string, unknown>
}

export interface MatchResult<T extends MatchCandidate> {
  item: T
  score: number
  reasons: string[]
}

export const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

/** Números citados, entendendo "10 mil", "10k", "10.000", "10,5", "500 l". */
export function extractNumbers(text: string): number[] {
  const t = normalize(text)
  const out: number[] = []
  const re = /(\d+(?:[.,]\d+)*)\s*(mil\b|k\b|m3\b|m³)?/g
  for (const m of t.matchAll(re)) {
    let raw = m[1]
    // "10.000" / "1.000.000" = milhar; "5,5" / "5.5" com 1–2 casas = decimal
    if (/^\d{1,3}([.]\d{3})+$/.test(raw)) raw = raw.replace(/\./g, '')
    else raw = raw.replace(',', '.')
    let n = Number(raw)
    if (!Number.isFinite(n)) continue
    if (m[2] === 'mil' || m[2] === 'k') n *= 1000
    if (m[2] === 'm3' || m[2] === 'm³') n *= 1000 // m³ → litros
    out.push(n)
  }
  return out
}

const STOP = new Set(['de', 'do', 'da', 'el', 'la', 'los', 'las', 'o', 'a', 'os', 'as', 'con', 'com', 'litros', 'litro', 'l', 'lts', 'lt', 'pallet', 'pallets', 'palete', 'paletes', 'producto', 'produto'])

/** Ranqueia candidatos. Pontuação alta = forte; o chamador decide ambiguidade pela distância entre os primeiros. */
/** grafias equivalentes ("Hydroforce" = "Hidroforce", "hydrosilo" = "hidrosilo") */
const synonyms = (s: string) => s.replace(/hydro/g, 'hidro')

export function rankProducts<T extends MatchCandidate>(query: string, items: T[], limit = 8): MatchResult<T>[] {
  const q = synonyms(normalize(query))
  const nums = extractNumbers(query)
  const words = q
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !STOP.has(w) && !/^\d+$/.test(w))
  const qCompact = q.replace(/[^a-z0-9]/g, '')

  const res: MatchResult<T>[] = []
  for (const it of items) {
    const reasons: string[] = []
    let score = 0
    const sku = normalize(it.sku)
    const skuCompact = sku.replace(/[^a-z0-9]/g, '')
    const hay = synonyms(normalize(`${it.sku} ${it.name} ${it.family} ${it.line}`))

    if (qCompact && skuCompact === qCompact) {
      score += 100
      reasons.push('código exato')
    } else if (qCompact.length >= 3 && (skuCompact.includes(qCompact) || qCompact.includes(skuCompact))) {
      score += 40
      reasons.push('código parcial')
    }
    for (const w of words) {
      if (w.length < 2) continue
      if (hay.includes(w)) {
        score += w.length >= 4 ? 12 : 6
        if (w.length >= 4 && synonyms(normalize(it.family)).includes(w)) score += 12 // nomeou a família
        reasons.push(`"${w}"`)
      } else if (w.length >= 4 && hay.split(/\s+/).some((h) => h.startsWith(w.slice(0, w.length >= 8 ? 6 : 4)))) {
        // prefixo: "hidro" ~ "hidrosilo"; palavras longas exigem mais letras ("hidroforce" ≠ "hidrosilo")
        score += 6 // "hidro" ~ "hidrosilo"
        reasons.push(`~"${w}"`)
      }
    }
    // números: capacidade em litros, medidas, e números no código (HS-10K = 10000)
    const numeric = Object.entries(it.attrs).filter(([, v]) => typeof v === 'number') as [string, number][]
    const skuNums = extractNumbers(it.sku.replace(/(\d)K\b/i, '$1 k').replace(/(\d)L\b/i, '$1'))
    for (const n of nums) {
      const hit = numeric.find(([, v]) => v === n)
      if (hit) {
        score += 35
        reasons.push(`${hit[0]} = ${n}`)
      } else if (skuNums.includes(n)) {
        score += 30
        reasons.push(`código contém ${n}`)
      } else if (numeric.length || skuNums.length) {
        score -= 8 // número citado que não bate com este produto
      }
    }
    if (score > 0) res.push({ item: it, score, reasons })
  }
  return res.sort((a, b) => b.score - a.score || a.item.sku.localeCompare(b.item.sku, 'pt-BR', { numeric: true })).slice(0, limit)
}

// ---------------------------------------------------------------------------
// Marca: regra determinística (não depende do prompt)
// ---------------------------------------------------------------------------

/** Marca assumida quando o usuário não cita nenhuma. */
export const DEFAULT_BRAND = 'PACIFIL'

/** Apelidos de marca (como o usuário costuma escrever). Chave = marca normalizada. */
export const BRAND_ALIASES: Record<string, string[]> = {
  PACIFIL: ['pacifil'],
  ECOBAG: ['ecobag', 'eco bag', 'eco-bag'],
  PROBAG: ['probag', 'pro bag', 'pro-bag'],
  BRIDON: ['bridon', 'brydon', 'braidon'],
  ADP: ['adp'],
}

/** Marca normalizada para comparação ("Eco Bag" → "ECOBAG"). */
export const brandKey = (b: string | null | undefined) => normalize(b ?? '').replace(/[^a-z0-9]/g, '').toUpperCase() || DEFAULT_BRAND

/** Marca citada no texto (pelos apelidos ou pelos nomes de marca do catálogo), ou null. */
export function detectBrand(query: string, catalogBrands: string[] = []): string | null {
  const q = ` ${normalize(query).replace(/[^a-z0-9]+/g, ' ')} `
  const qc = q.replace(/\s+/g, '')
  const known = new Map<string, string[]>(Object.entries(BRAND_ALIASES))
  for (const b of catalogBrands) {
    const k = brandKey(b)
    if (!known.has(k)) known.set(k, [normalize(b)])
  }
  for (const [k, names] of known) {
    for (const n of names) {
      const words = n.replace(/[^a-z0-9]+/g, ' ').trim()
      if (q.includes(` ${words} `) || (words.length >= 5 && qc.includes(words.replace(/\s+/g, '')))) return k
    }
  }
  return null
}

export interface BrandAwareMatch<T extends MatchCandidate & { brand?: string }> {
  results: MatchResult<T>[]
  /** marca usada no filtro e se foi a padrão (usuário não citou nenhuma) */
  brand: { key: string | null; defaulted: boolean; note?: string }
}

/**
 * Busca com a regra de marca: se o texto cita uma marca, só ela; se não cita, PACIFIL (quando há
 * candidato Pacifil). Só mantém outras marcas se a marca pedida/padrão não tiver candidatos.
 */
export function resolveProducts<T extends MatchCandidate & { brand?: string }>(query: string, items: T[], limit = 5): BrandAwareMatch<T> {
  const ranked = rankProducts(query, items, 50)
  const asked = detectBrand(query, [...new Set(items.map((i) => i.brand ?? ''))].filter(Boolean))
  const target = asked ?? DEFAULT_BRAND
  const filtered = ranked.filter((r) => brandKey(r.item.brand) === target)
  if (filtered.length) return { results: filtered.slice(0, limit), brand: { key: target, defaulted: !asked } }
  return {
    results: ranked.slice(0, limit),
    brand: { key: null, defaulted: !asked, note: asked ? `Nenhum produto da marca ${asked} corresponde; mostrando outras marcas.` : undefined },
  }
}

/** Inequívoco quando o 1º tem pontuação razoável e folga clara sobre o 2º. */
export function isUnambiguous(r: MatchResult<MatchCandidate>[]): boolean {
  if (!r.length || r[0].score < 30) return false
  if (r.length === 1) return true
  return r[0].score - r[1].score >= 20
}
