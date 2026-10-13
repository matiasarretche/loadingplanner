/**
 * PREÇOS DE EXPORTAÇÃO — cálculo puro (sem banco), base das futuras Proformas Comerciais.
 *
 * Fluxo: país de destino → categoria comercial (A, B, C…) → família do produto → regra de preço da
 * família + preço da família nessa categoria → peso LÍQUIDO do produto (catálogo mestre) → preço unitário.
 * O preço sempre incide sobre o peso líquido (só o produto), nunca sobre o bruto.
 *
 * Regras (por família; novas regras entram em PriceMethod + unitPriceFor):
 *   PER_KG              preço unitário = peso líquido × USD/kg
 *   PER_KG_PLUS_FIXED   preço unitário = peso líquido × USD/kg + valor fixo USD/unidade (Hidrosilo, Hidroforce)
 *   INCLUDED            sem preço próprio (0): incluído no valor de outro produto (KIT-HF no fixo do Hidroforce)
 *   RELATIVE            preço da família de referência (pela regra e pelos valores dela, com o peso líquido DESTE
 *                       produto) ARREDONDADO PARA CIMA ao dólar inteiro + acréscimo % (Hidroforce = Hidrosilo
 *                       arredondado + 40%: 51,54 → 52 × 1,4 = 72,80)
 *
 * HIDROSILO / HIDROFORCE DE 3 m: o preço é o do Hidrosilo de 2 m da MESMA capacidade — calculado com o peso
 * líquido do 2 m (inclusive o recargo CIF), nunca pelo peso próprio do 3 m. O Hidroforce 3 m segue a regra
 * relativa sobre esse Hidrosilo (arredondado + 40%). Sem Hidrosilo 2 m da mesma capacidade → sem preço.
 *
 * FAIXAS DE DIÂMETRO (Silo-bolsa): a família pode ter USD/kg próprio por faixa de diâmetro (5 a 8 pés, 9 a 12 pés,
 * 14 pés), por categoria. O sistema lê o diâmetro do produto e usa a faixa dele; diâmetro fora de todas as faixas →
 * a faixa de CENTRO mais próximo (empate: a menor). Ex.: 8,5 → 5 a 8; 13 → 14.
 *
 * Cotação CIF: RECARGO CIF por kg líquido (padrão geral, ex.: USD 0,05/kg; cada família pode ter o seu,
 * ex.: Hidrosilo e Hidroforce) somado ao preço depois da marca; o fixo por unidade continua. Só CIF.
 * Depois da regra da família vale o AJUSTE POR MARCA (% sobre o preço de lista; ex.: Ecobag −5%).
 * Venda via AGENTE: comissão incluída no preço, como % do preço FINAL faturado: preço = base ÷ (1 − %).
 * O % vem do PERFIL DO AGENTE, por família (o país não influi na comissão). Sem % para a família →
 * sem comissão definida (avisa e não calcula).
 *
 * ARREDONDAMENTO (regra Pacifil): o preço unitário FINAL é sempre arredondado PARA CIMA ao dólar inteiro
 * (51,01 → 52). Os passos intermediários (lista, marca, comissão) não são arredondados; o preço manual de
 * uma cotização fica como digitado.
 *
 * Em uma cotização o preço calculado pode ser alterado manualmente (QuoteLine.overrideUnitUsd) sem
 * mudar a tabela mestra.
 */

export type PriceMethod = 'PER_KG' | 'PER_KG_PLUS_FIXED' | 'INCLUDED' | 'RELATIVE'

export const PRICE_METHOD_LABEL: Record<PriceMethod, string> = {
  PER_KG: 'USD/kg líquido',
  PER_KG_PLUS_FIXED: 'USD/kg líquido + valor fixo USD/unidade',
  INCLUDED: 'Incluído no valor de outro produto (sem preço próprio)',
  RELATIVE: '% sobre o preço de outra família',
}

/** Regra da família (RELATIVE usa a família de referência e o acréscimo %). */
export interface FamilyRule {
  method: PriceMethod
  refFamilyId?: number | null
  markupPct?: number | null
  /** recargo CIF próprio da família (USD/kg líquido); null = o padrão geral */
  cifUsdPerKg?: number | null
}

/** Incoterms em que o recargo por kg se aplica (definição Pacifil: só CIF). */
export const CIF_SURCHARGE_INCOTERMS = ['CIF']
export const appliesCifSurcharge = (incoterm: string | null | undefined) => CIF_SURCHARGE_INCOTERMS.includes((incoterm ?? '').trim().toUpperCase())

/** a regra usa o valor fixo por unidade? */
export const methodUsesFixed = (m: PriceMethod) => m === 'PER_KG_PLUS_FIXED'
/** a regra usa USD/kg? */
export const methodUsesKg = (m: PriceMethod) => m === 'PER_KG' || m === 'PER_KG_PLUS_FIXED'

export interface FamilyPriceValues {
  usdPerKg: number | null
  fixedUsdPerUnit: number | null
}

export type UnitPriceResult =
  | {
      ok: true
      unitUsd: number
      method: PriceMethod
      kgPart: number
      fixedPart: number
      netKg: number
      usdPerKg: number | null
      fixedUsdPerUnit: number | null
      base?: { familyId: number; unitUsd: number; markupPct: number }
      listUnitUsd?: number
      brandAdjustPct?: number
      /** recargo CIF aplicado (USD/kg e USD por unidade) */
      cifUsdPerKg?: number
      cifSurchargeUsd?: number
      /** 3 m: preço calculado como o deste Hidrosilo de 2 m (o netKg acima é o dele) */
      priceAs?: PriceTwin
      /** família com faixas de diâmetro: a faixa usada (nearest = diâmetro fora de todas as faixas) */
      band?: { key: string; label: string; diameterFt: number; nearest: boolean }
    }
  | { ok: false; reason: string }

const r2 = (x: number) => Math.round(x * 100) / 100

/**
 * Preço unitário (USD) de um produto: unidade de venda do catálogo (o peso líquido do catálogo é por
 * essa unidade). Arredondado a centavos. Sem dado suficiente → motivo (nunca inventa valor).
 */
export function unitPriceFor(method: PriceMethod, price: FamilyPriceValues | null | undefined, netKg: number | null | undefined): UnitPriceResult {
  if (method === 'RELATIVE') return { ok: false, reason: 'regra relativa: use familyUnitPrice (precisa da família de referência)' }
  if (method === 'INCLUDED') return { ok: true, unitUsd: 0, method, kgPart: 0, fixedPart: 0, netKg: netKg ?? 0, usdPerKg: null, fixedUsdPerUnit: null }
  if (!price || price.usdPerKg == null) return { ok: false, reason: 'sem USD/kg para esta família e categoria' }
  if (methodUsesFixed(method) && price.fixedUsdPerUnit == null) return { ok: false, reason: 'sem valor fixo por unidade para esta família e categoria' }
  if (netKg == null || !(netKg > 0)) return { ok: false, reason: 'produto sem peso líquido no catálogo' }
  const kgPart = netKg * price.usdPerKg
  const fixedPart = methodUsesFixed(method) ? (price.fixedUsdPerUnit ?? 0) : 0
  // valor EXATO (sem arredondar): o preço final é arredondado para cima ao dólar só no fim (quotePrice)
  return { ok: true, unitUsd: kgPart + fixedPart, method, kgPart: r2(kgPart), fixedPart: r2(fixedPart), netKg, usdPerKg: price.usdPerKg, fixedUsdPerUnit: methodUsesFixed(method) ? price.fixedUsdPerUnit : null }
}

/** Configuração comercial carregada do banco (ver lib/exportPricing.ts). */
export interface PricingConfig {
  categories: { id: number; code: string; name: string; active: boolean }[]
  /** ISO alfa-2 → categoria */
  countryCategory: Map<string, number>
  /** família → regra (sem entrada = PER_KG) */
  familyRule: Map<number, FamilyRule>
  /** `${familyId}:${categoryId}` → valores */
  familyPrice: Map<string, FamilyPriceValues>
  /** marca (minúsculas) → ajuste % sobre o preço de lista (negativo = desconto) */
  brandAdjust?: Map<string, number>
  /** comissão: `${agentId}:${familyId}` → % (perfil do agente) */
  commission?: Map<string, number>
  /** recargo CIF padrão (USD/kg líquido) para famílias sem valor próprio */
  cifDefaultUsdPerKg?: number | null
  /** SKU (maiúsculas) de 3 m → Hidrosilo de 2 m da mesma capacidade cujo peso define o preço; null = sem equivalente */
  priceTwin?: Map<string, PriceTwin | null>
  /** família → faixas de diâmetro com USD/kg próprio (Silo-bolsa) */
  familyBands?: Map<number, PriceBand[]>
  /** `${familyId}:${categoryId}:${bandKey}` → USD/kg da faixa */
  bandPrice?: Map<string, number>
  /** SKU (maiúsculas) → diâmetro em pés (catálogo), lido pelas famílias com faixas */
  skuDiameterFt?: Map<string, number>
}

/** Faixa de diâmetro (pés, inclusive) com USD/kg próprio */
export interface PriceBand {
  key: string
  label: string
  minFt: number
  maxFt: number
}

export const bandPriceKey = (familyId: number, categoryId: number, bandKey: string) => `${familyId}:${categoryId}:${bandKey}`

/**
 * Faixa do diâmetro: a que o contém (limites inclusive); fora de todas, a de CENTRO mais próximo do
 * diâmetro (empate: a de diâmetro menor). Sem faixas → null.
 */
export function bandFor(bands: PriceBand[], diameterFt: number): { band: PriceBand; nearest: boolean } | null {
  if (!bands.length) return null
  const sorted = [...bands].sort((a, b) => a.minFt - b.minFt || a.maxFt - b.maxFt)
  const eps = 1e-6
  const inside = sorted.find((b) => diameterFt >= b.minFt - eps && diameterFt <= b.maxFt + eps)
  if (inside) return { band: inside, nearest: false }
  let best = sorted[0]
  let bestD = Infinity
  for (const b of sorted) {
    const d = Math.abs(diameterFt - (b.minFt + b.maxFt) / 2)
    if (d < bestD - eps) {
      best = b
      bestD = d
    }
  }
  return { band: best, nearest: true }
}

/** Diâmetro do produto em pés: campo do catálogo; senão attrs.diametro_m; senão "9 pés" no nome. */
export function diameterFtOf(v: { diameterFt?: number | null; attrs?: unknown; name?: string | null }): number | null {
  if (v.diameterFt != null && v.diameterFt > 0) return v.diameterFt
  const m = (v.attrs as Record<string, unknown> | null | undefined)?.diametro_m
  if (typeof m === 'number' && m > 0) return Math.round((m / 0.3048) * 2) / 2
  const ft = /(\d+(?:[.,]\d+)?)\s*p[ée]s\b/i.exec(v.name ?? '')?.[1]
  return ft ? Number(ft.replace(',', '.')) : null
}

/** Hidrosilo de 2 m cujo preço vale para um Hidrosilo / Hidroforce de 3 m da mesma capacidade */
export interface PriceTwin {
  sku: string
  /** peso líquido por unidade do 2 m (catálogo) */
  netKg: number
}

/** item do catálogo para montar os equivalentes de 3 m */
export interface TwinCandidate {
  sku: string
  family: string
  brand: string | null
  widthM: number | null
  capacityL: number | null
  netKg: number | null
  /** variante, produto e família ativos (false = desativado: o 3 m continua no mapa, mas nunca serve de referência 2 m) */
  active?: boolean
}

/** famílias de reservatório (Hidrosilo / Hidroforce) */
export const WATER_TANK_FAMILY = /hidrosilo|hidroforce|hydroforce/i
const widthIs = (w: number | null, m: number) => w != null && Math.abs(w - m) < 0.01

/**
 * Hidrosilo / Hidroforce de 3 m → Hidrosilo de 2 m ATIVO da MESMA capacidade (de preferência da mesma marca).
 * Só entram no mapa os itens de 3 m (ativos ou não: uma carga salva pode ter um 3 m desativado depois);
 * sem equivalente (ou sem capacidade) → null, e o item fica sem preço.
 */
export function buildPriceTwins(items: TwinCandidate[]): Map<string, PriceTwin | null> {
  const refs = items
    .filter((i) => i.active !== false && /hidrosilo/i.test(i.family) && widthIs(i.widthM, 2) && i.capacityL != null && i.netKg != null && i.netKg > 0)
    .sort((a, b) => a.sku.localeCompare(b.sku))
  const out = new Map<string, PriceTwin | null>()
  for (const i of items) {
    if (!WATER_TANK_FAMILY.test(i.family) || !widthIs(i.widthM, 3)) continue
    const same = i.capacityL == null ? [] : refs.filter((x) => x.capacityL === i.capacityL)
    const ref = same.find((x) => brandKey(x.brand) === brandKey(i.brand)) ?? same[0]
    out.set(i.sku.toUpperCase(), ref ? { sku: ref.sku, netKg: ref.netKg! } : null)
  }
  return out
}

/**
 * Carga: se o Hidrosilo 2 m equivalente está na MESMA carga, o 3 m usa o peso do snapshot dele (o 2 m da carga
 * também é calculado pelo snapshot) — os dois saem com o mesmo preço na mesma Proforma. snapKg: SKU maiúsculo → kg/un.
 */
export function twinsWithSnapshot(priceTwin: Map<string, PriceTwin | null> | undefined, snapKg: Map<string, number>): Map<string, PriceTwin | null> | undefined {
  if (!priceTwin) return priceTwin
  const out = new Map(priceTwin)
  for (const [sku, t] of out) {
    const kg = t ? snapKg.get(t.sku.toUpperCase()) : undefined
    if (t && kg != null && kg > 0) out.set(sku, { ...t, netKg: kg })
  }
  return out
}

/** motivo de "sem preço" de um 3 m sem Hidrosilo 2 m equivalente */
export const NO_TWIN_REASON = '3 m de largura sem Hidrosilo de 2 m da mesma capacidade no catálogo (o 3 m não é calculado por kg)'

/** Recargo CIF (USD/kg) da família: o próprio ou o padrão geral. */
export function cifRateFor(cfg: Pick<PricingConfig, 'familyRule' | 'cifDefaultUsdPerKg'>, familyId: number): number | null {
  const own = cfg.familyRule.get(familyId)?.cifUsdPerKg
  return own != null ? own : cfg.cifDefaultUsdPerKg ?? null
}

/**
 * Cotação CIF: soma o recargo por kg líquido ao preço (depois da marca; o fixo por unidade continua).
 * Produto "incluído" (KIT-HF) continua 0. Outro Incoterm → inalterado.
 */
export function applyCifSurcharge(r: UnitPriceResult, cfg: Pick<PricingConfig, 'familyRule' | 'cifDefaultUsdPerKg'>, familyId: number, incoterm: string | null | undefined): UnitPriceResult {
  if (!r.ok || r.method === 'INCLUDED' || !appliesCifSurcharge(incoterm)) return r
  const rate = cifRateFor(cfg, familyId)
  if (!rate) return r
  const add = r.netKg * rate
  return { ...r, unitUsd: r.unitUsd + add, cifUsdPerKg: rate, cifSurchargeUsd: r2(add) }
}

export const commissionKey = (agentId: number, familyId: number) => `${agentId}:${familyId}`
/** faixa usual da comissão: fora dela o sistema avisa (o % é livre) */
export const COMMISSION_USUAL = { min: 2, max: 5 }

/** % de comissão do agente para a família (perfil do agente); null = não definido. */
export function commissionRateFor(cfg: Pick<PricingConfig, 'commission'>, agentId: number, familyId: number): { pct: number; source: 'agente' } | null {
  const a = cfg.commission?.get(commissionKey(agentId, familyId))
  return a != null ? { pct: a, source: 'agente' } : null
}

/** Preço com a comissão incluída (% do preço final): base ÷ (1 − %); comissão = preço − base. */
export function withCommission(baseUnitUsd: number, pct: number): { unitUsd: number; commissionUsd: number } {
  if (!(pct > 0)) return { unitUsd: r2(baseUnitUsd), commissionUsd: 0 }
  if (pct >= 100) throw new Error('comissão deve ser menor que 100%')
  const unit = r2(baseUnitUsd / (1 - pct / 100))
  return { unitUsd: unit, commissionUsd: r2(unit - baseUnitUsd) }
}

/** Preço unitário final: sempre PARA CIMA ao dólar inteiro (tolerância de float: 52,00000001 → 52). */
export const roundUpUsd = (x: number) => Math.ceil(Math.round(x * 10000) / 10000)

export const commissionOutsideUsual = (pct: number | null | undefined) => pct != null && pct > 0 && (pct < COMMISSION_USUAL.min || pct > COMMISSION_USUAL.max)

export const brandKey = (brand: string | null | undefined) => (brand ?? '').trim().toLowerCase()

/** Preço de lista → preço da marca (ajuste %). Sem ajuste cadastrado → igual ao de lista. */
export function applyBrandAdjust(r: UnitPriceResult, brand: string | null | undefined, adjust: Map<string, number> | undefined): UnitPriceResult {
  const pct = adjust?.get(brandKey(brand))
  if (!r.ok || pct == null || pct === 0) return r
  return { ...r, listUnitUsd: r2(r.unitUsd), brandAdjustPct: pct, unitUsd: r.unitUsd * (1 + pct / 100) }
}

export const priceKey = (familyId: number, categoryId: number) => `${familyId}:${categoryId}`

/** Categoria comercial do país (só categorias ativas). País sem categoria → null (sem preço). */
export function categoryOfCountry(cfg: PricingConfig, countryCode: string | null | undefined) {
  if (!countryCode) return null
  const id = cfg.countryCategory.get(countryCode.toUpperCase())
  return cfg.categories.find((c) => c.id === id && c.active) ?? null
}

/** Produto do catálogo mestre (só o que o preço precisa: nada é copiado para a tabela de preços). */
export interface PricedProduct {
  sku: string
  familyId: number
  /** marca do catálogo (ajuste por marca) */
  brand?: string | null
  /** peso líquido por unidade de venda (catálogo) */
  netKg: number | null
}

/**
 * Preço unitário de um produto de uma família numa categoria — ÚNICO ponto de cálculo (tela e Proformas).
 * RELATIVE: calcula pela família de referência com o peso líquido deste produto, ARREDONDA esse preço para cima
 * ao dólar inteiro (o preço pelo qual a família de referência é vendida) e aplica o acréscimo %.
 */
export function familyUnitPrice(
  cfg: Pick<PricingConfig, 'familyRule' | 'familyPrice' | 'familyBands' | 'bandPrice'>,
  familyId: number,
  categoryId: number,
  netKg: number | null | undefined,
  depth = 0,
  diameterFt: number | null = null,
): UnitPriceResult {
  const rule = cfg.familyRule.get(familyId) ?? { method: 'PER_KG' as const }
  if (rule.method !== 'RELATIVE') {
    const price = cfg.familyPrice.get(priceKey(familyId, categoryId))
    const bands = rule.method === 'INCLUDED' ? undefined : cfg.familyBands?.get(familyId)
    if (!bands?.length) return unitPriceFor(rule.method, price, netKg)
    // faixa de diâmetro: o USD/kg vem da faixa (o fixo por unidade, se houver, continua o da família)
    if (diameterFt == null || !(diameterFt > 0)) return { ok: false, reason: 'produto sem diâmetro no catálogo (o preço desta família depende do diâmetro)' }
    const hit = bandFor(bands, diameterFt)!
    const usdPerKg = cfg.bandPrice?.get(bandPriceKey(familyId, categoryId, hit.band.key))
    if (usdPerKg == null) return { ok: false, reason: `sem USD/kg para a faixa ${hit.band.label} nesta categoria` }
    const r = unitPriceFor(rule.method, { usdPerKg, fixedUsdPerUnit: price?.fixedUsdPerUnit ?? null }, netKg)
    return r.ok ? { ...r, band: { key: hit.band.key, label: hit.band.label, diameterFt, nearest: hit.nearest } } : r
  }
  if (rule.refFamilyId == null || rule.markupPct == null) return { ok: false, reason: 'regra relativa sem família de referência ou sem %' }
  if (rule.refFamilyId === familyId || depth > 3) return { ok: false, reason: 'regra relativa circular' }
  const base = familyUnitPrice(cfg, rule.refFamilyId, categoryId, netKg, depth + 1, diameterFt)
  if (!base.ok) return { ok: false, reason: `família de referência: ${base.reason}` }
  const f = 1 + rule.markupPct / 100
  // o acréscimo vale sobre o preço de VENDA da família de referência (já arredondado ao dólar inteiro)
  const baseUsd = roundUpUsd(base.unitUsd)
  return {
    ...base,
    method: 'RELATIVE',
    unitUsd: baseUsd * f,
    kgPart: r2(base.kgPart * f),
    fixedPart: r2(base.fixedPart * f),
    base: { familyId: rule.refFamilyId, unitUsd: baseUsd, markupPct: rule.markupPct },
  }
}

/**
 * Preço de lista de um produto numa categoria: família → marca → recargo CIF (se a cotação for CIF).
 * Hidrosilo / Hidroforce de 3 m: com o peso do Hidrosilo de 2 m da mesma capacidade (ver buildPriceTwins).
 */
export function listUnitPrice(
  cfg: Pick<PricingConfig, 'familyRule' | 'familyPrice' | 'brandAdjust' | 'cifDefaultUsdPerKg' | 'priceTwin' | 'familyBands' | 'bandPrice' | 'skuDiameterFt'>,
  p: PricedProduct,
  categoryId: number,
  incoterm: string | null | undefined,
): UnitPriceResult {
  const twin = cfg.priceTwin?.get(p.sku.toUpperCase())
  if (twin === null) return { ok: false, reason: NO_TWIN_REASON }
  const diameterFt = cfg.skuDiameterFt?.get(p.sku.toUpperCase()) ?? null
  const r = applyCifSurcharge(applyBrandAdjust(familyUnitPrice(cfg, p.familyId, categoryId, twin ? twin.netKg : p.netKg, 0, diameterFt), p.brand, cfg.brandAdjust), cfg, p.familyId, incoterm)
  return r.ok && twin ? { ...r, priceAs: twin } : r
}

/** Preço de um produto para um país de destino (o caminho que a Proforma vai usar). */
export function priceForProduct(cfg: PricingConfig, p: PricedProduct, countryCode: string | null | undefined, o: { incoterm?: string | null } = {}): UnitPriceResult & { category: { id: number; code: string; name: string } | null } {
  const cat = categoryOfCountry(cfg, countryCode)
  if (!cat) return { ok: false, reason: countryCode ? `país ${countryCode} sem categoria comercial` : 'país de destino não informado', category: null }
  return { ...listUnitPrice(cfg, p, cat.id, o.incoterm), category: cat }
}

/**
 * Linha de cotização: preço calculado pela tabela (lista + marca), comissão do agente (incluída no
 * preço, % do preço final) e, se o usuário quiser, um preço manual só desta cotização (a tabela não
 * muda; com preço manual a comissão continua sendo o % dele).
 */
export interface QuoteLine {
  sku: string
  quantity: number
  /** preço de lista já com o ajuste da marca, SEM comissão */
  calculatedUnitUsd: number | null
  /** % de comissão do agente nesta linha (null/0 = sem agente) */
  commissionPct?: number | null
  overrideUnitUsd?: number | null
}
export function quoteLineTotal(l: QuoteLine): { unitUsd: number | null; totalUsd: number | null; manual: boolean; commissionPct: number; commissionUsd: number | null } {
  const pct = l.commissionPct ?? 0
  const manual = l.overrideUnitUsd != null
  // calculado: comissão sobre o preço sem arredondar e, no fim, PARA CIMA ao dólar inteiro
  const unit = manual ? l.overrideUnitUsd! : l.calculatedUnitUsd == null ? null : roundUpUsd(pct > 0 ? l.calculatedUnitUsd / (1 - pct / 100) : l.calculatedUnitUsd)
  const total = unit == null ? null : r2(unit * l.quantity)
  return { unitUsd: unit, totalUsd: total, manual, commissionPct: pct, commissionUsd: total == null || !pct ? (pct ? null : 0) : r2((total * pct) / 100) }
}

/**
 * Preço de cotização de um produto (o que a Proforma vai usar): lista da família → marca → comissão
 * do agente (se houver). `commissionPct` informado manualmente substitui o da tabela só nesta cotização.
 */
export function quotePrice(cfg: PricingConfig, p: PricedProduct, countryCode: string | null | undefined, o: { agentId?: number | null; commissionPct?: number | null; incoterm?: string | null } = {}) {
  const list = priceForProduct(cfg, p, countryCode, { incoterm: o.incoterm })
  if (!list.ok) return { ...list, commission: null }
  // incluído (KIT-HF): preço 0, sem comissão (não exige % do agente)
  if (list.method === 'INCLUDED') return { ...list, baseUnitUsd: 0, unitUsd: 0, commission: null }
  const rate = o.commissionPct != null ? { pct: o.commissionPct, source: 'manual' as const } : o.agentId != null ? commissionRateFor(cfg, o.agentId, p.familyId) : null
  if (o.agentId != null && !rate) return { ...list, commission: { pct: null, source: null, commissionUsd: null, warning: 'sem % de comissão definido para esta família no perfil do agente' } }
  // preço final sempre PARA CIMA ao dólar inteiro
  if (!rate) return { ...list, baseUnitUsd: r2(list.unitUsd), unitUsd: roundUpUsd(list.unitUsd), commission: null }
  if (rate.pct >= 100) return { ok: false as const, reason: 'comissão deve ser menor que 100%', category: list.category, commission: null }
  const unit = roundUpUsd(list.unitUsd / (1 - rate.pct / 100))
  return {
    ...list,
    baseUnitUsd: r2(list.unitUsd),
    unitUsd: unit,
    // comissão = % do preço final faturado (já arredondado)
    commission: { pct: rate.pct, source: rate.source, commissionUsd: r2((unit * rate.pct) / 100), warning: commissionOutsideUsual(rate.pct) ? `comissão ${rate.pct}% fora da faixa usual (${COMMISSION_USUAL.min}–${COMMISSION_USUAL.max}%)` : null },
  }
}

/** Configuração de preços em formato serializável (para telas que calculam no navegador). */
export interface PricingPayload {
  categories: PricingConfig['categories']
  countryCategory: [string, number][]
  familyRule: [number, FamilyRule][]
  familyPrice: [string, FamilyPriceValues][]
  brandAdjust: [string, number][]
  commission: [string, number][]
  cifDefaultUsdPerKg: number | null
  /** Hidrosilo / Hidroforce de 3 m → Hidrosilo de 2 m da mesma capacidade */
  priceTwin: [string, PriceTwin | null][]
  /** faixas de diâmetro por família, USD/kg de cada faixa por categoria e diâmetro (pés) dos SKUs dessas famílias */
  familyBands: [number, PriceBand[]][]
  bandPrice: [string, number][]
  skuDiameterFt: [string, number][]
  /** família e marca de cada SKU do catálogo (o peso líquido vem da embalagem) */
  products: { sku: string; familyId: number; brand: string | null }[]
  agents: { id: number; name: string }[]
}

export function configFromPayload(p: PricingPayload): PricingConfig {
  return {
    categories: p.categories,
    countryCategory: new Map(p.countryCategory),
    familyRule: new Map(p.familyRule),
    familyPrice: new Map(p.familyPrice),
    brandAdjust: new Map(p.brandAdjust),
    commission: new Map(p.commission),
    cifDefaultUsdPerKg: p.cifDefaultUsdPerKg,
    priceTwin: new Map(p.priceTwin ?? []),
    familyBands: new Map(p.familyBands ?? []),
    bandPrice: new Map(p.bandPrice ?? []),
    skuDiameterFt: new Map(p.skuDiameterFt ?? []),
  }
}
