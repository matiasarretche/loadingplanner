/**
 * Valor do pedido a partir dos preços de referência copiados nos snapshots.
 * PROVISÓRIO: a regra definitiva de precificação (listas por cliente, Incoterm, frete, descontos)
 * será implementada depois; este módulo é o único ponto a trocar.
 */
import { loadGeometries } from './load'
import type { LoadDoc, PackSnapshot } from './types'

export interface ValueLine {
  sku: string
  currency: string | null
  unitPrice: number | null
  per: 'UNIT' | 'BOX' | 'PALLET' | null
  /** quantidade na unidade do preço */
  quantity: number
  amount: number | null
}

export interface OrderValue {
  lines: ValueLine[]
  /** total por moeda (só linhas com preço) */
  totals: Record<string, number>
  /** SKUs sem preço cadastrado */
  missing: string[]
}

export function orderValue(doc: LoadDoc): OrderValue {
  const acc = new Map<string, { pack: PackSnapshot; units: number; boxes: number; pallets: number }>()
  for (const g of loadGeometries(doc)) {
    const packs = g.unit.kind === 'PALLET' ? Object.values(doc.pallets[g.unit.palletKey].packs) : [doc.packs[g.unit.packId]]
    for (const l of g.bySku) {
      const pack = packs.find((p) => p.sku === l.sku)
      if (!pack) continue
      const cur = acc.get(l.sku) ?? { pack, units: 0, boxes: 0, pallets: 0 }
      cur.units += l.units
      cur.boxes += l.packages
      // palete conta para o SKU só se o palete for de um único SKU
      if (g.unit.kind === 'PALLET' && g.bySku.length === 1) cur.pallets += 1
      acc.set(l.sku, cur)
    }
  }
  const lines: ValueLine[] = []
  const totals: Record<string, number> = {}
  const missing: string[] = []
  for (const [sku, a] of [...acc.entries()].sort(([x], [y]) => x.localeCompare(y, 'pt-BR', { numeric: true }))) {
    const p = a.pack.price
    if (!p) {
      missing.push(sku)
      lines.push({ sku, currency: null, unitPrice: null, per: null, quantity: a.units, amount: null })
      continue
    }
    const quantity = p.per === 'BOX' ? a.boxes : p.per === 'PALLET' ? a.pallets : a.units
    const amount = Math.round(quantity * p.amount * 100) / 100
    totals[p.currency] = Math.round(((totals[p.currency] ?? 0) + amount) * 100) / 100
    lines.push({ sku, currency: p.currency, unitPrice: p.amount, per: p.per, quantity, amount })
  }
  return { lines, totals, missing }
}

// ---------------------------------------------------------------------------
// Preços do módulo "Preços de exportação" aplicados a uma carga
// ---------------------------------------------------------------------------

/** Preço resolvido de um SKU (por unidade de venda). unitUsd já inclui a comissão do agente, se houver. */
export interface PriceResolution {
  unitUsd: number | null
  /** motivo quando não há preço */
  reason?: string | null
  /** preço sem a comissão (lista + marca) */
  baseUnitUsd?: number | null
  /** comissão do agente (INTERNO: nunca vai para o PDF do cliente) */
  commissionPct?: number | null
  commissionUnitUsd?: number | null
  warning?: string | null
  /** COMO o preço foi calculado (para consultar meses depois); ausente em preços antigos */
  factors?: PriceFactors | null
}

/** Fatores usados no cálculo de um preço (registro histórico; não depende das tabelas atuais). */
export interface PriceFactors {
  familyId: number
  family: string
  /** regra da família: PER_KG | PER_KG_PLUS_FIXED | INCLUDED | RELATIVE */
  method: string
  category: string | null
  /** USD/kg líquido aplicado (na regra relativa: o da família de referência) */
  usdPerKg: number | null
  fixedUsdPerUnit: number | null
  /** regra relativa: família de referência e acréscimo % (ex.: Hidroforce = Hidrosilo + 40%) */
  refFamily: string | null
  markupPct: number | null
  brand: string | null
  brandAdjustPct: number | null
  /** peso líquido por unidade usado no cálculo (3 m: o do Hidrosilo 2 m equivalente) */
  netKgUnit: number
  /** 3 m: preço calculado como o deste Hidrosilo de 2 m da mesma capacidade */
  priceAsSku?: string | null
  /** família com faixas de diâmetro: a faixa usada (ex.: "9 a 12 pés") */
  priceBand?: string | null
  /** preço de lista + marca (+ recargo CIF), antes da comissão e do arredondamento */
  baseUnitUsd: number
  /** Incoterm da cotação e recargo CIF aplicado (USD/kg e USD por unidade) */
  incoterm?: string | null
  cifUsdPerKg?: number | null
  cifSurchargeUsd?: number | null
}

/** Proforma: frete e seguro (USD) somados uma única vez ao subtotal da mercadoria. */
export function proformaTotals(goodsUsd: number | null | undefined, freightUsd: number | null | undefined, insuranceUsd: number | null | undefined) {
  const g = goodsUsd ?? 0
  const f = freightUsd ?? 0
  const i = insuranceUsd ?? 0
  // sem preço da mercadoria não há total geral (frete + seguro sozinhos não são o valor da proforma)
  return { goodsUsd: goodsUsd ?? null, freightUsd: freightUsd ?? null, insuranceUsd: insuranceUsd ?? null, totalUsd: goodsUsd == null ? null : Math.round((g + f + i) * 100) / 100 }
}

/** Preços calculados para a carga (congelados na aprovação). */
export interface FrozenPricing {
  computedAt: string
  /** agente ou % de comissão trocados depois da aprovação: preços re-congelados com a nova comissão (mesma base) */
  recommissionedAt?: string
  country: string | null
  category: string | null
  agent: { id: number; name: string } | null
  lines: Record<string, PriceResolution>
}

/** Quantidades por SKU (unidades de venda) e o snapshot da embalagem. */
export function skuQuantities(doc: LoadDoc): Map<string, { pack: PackSnapshot; units: number; boxes: number }> {
  const acc = new Map<string, { pack: PackSnapshot; units: number; boxes: number }>()
  for (const g of loadGeometries(doc)) {
    const packs = g.unit.kind === 'PALLET' ? Object.values(doc.pallets[g.unit.palletKey].packs) : [doc.packs[g.unit.packId]]
    for (const l of g.bySku) {
      const pack = packs.find((p) => p.sku === l.sku)
      if (!pack) continue
      const cur = acc.get(l.sku) ?? { pack, units: 0, boxes: 0 }
      cur.units += l.units
      cur.boxes += l.packages
      acc.set(l.sku, cur)
    }
  }
  return acc
}

/** Valor do pedido com os preços do módulo (USD por unidade). Comissão total só para uso interno. */
export function orderValueFromPrices(doc: LoadDoc, prices: Record<string, PriceResolution>): OrderValue & { commissionUsd: number; reasons: Record<string, string> } {
  const lines: ValueLine[] = []
  const missing: string[] = []
  const reasons: Record<string, string> = {}
  let total = 0
  let commission = 0
  for (const [sku, a] of [...skuQuantities(doc).entries()].sort(([x], [y]) => x.localeCompare(y, 'pt-BR', { numeric: true }))) {
    const p = prices[sku]
    if (!p || p.unitUsd == null) {
      missing.push(sku)
      reasons[sku] = p?.reason ?? 'sem preço'
      lines.push({ sku, currency: null, unitPrice: null, per: null, quantity: a.units, amount: null })
      continue
    }
    const amount = Math.round(a.units * p.unitUsd * 100) / 100
    total += amount
    commission += a.units * (p.commissionUnitUsd ?? 0)
    lines.push({ sku, currency: 'USD', unitPrice: p.unitUsd, per: 'UNIT', quantity: a.units, amount })
  }
  return { lines, totals: total ? { USD: Math.round(total * 100) / 100 } : {}, missing, commissionUsd: Math.round(commission * 100) / 100, reasons }
}

// ---------------------------------------------------------------------------
// Cotações emitidas (registro do preço enviado ao cliente)
// ---------------------------------------------------------------------------

/** Linha de uma cotação emitida: quantidade, preço final e os fatores que o produziram. */
export interface QuoteSnapshotLine {
  sku: string
  name: string
  units: number
  unitUsd: number | null
  amount: number | null
  reason?: string | null
  commissionPct?: number | null
  commissionUnitUsd?: number | null
  factors?: PriceFactors | null
}

export interface QuoteSummary {
  /** família de maior valor na cotação (somando as faixas de diâmetro) e o USD/kg do seu maior grupo; sharePct = % da família */
  principal: { family: string; usdPerKg: number | null; fixedUsdPerUnit: number | null; method: string; sharePct: number; refFamily: string | null; markupPct: number | null; bands: string[]; groups: number } | null
  /** USD/kg por família (do maior para o menor valor); Silo-bolsa: um grupo por USD/kg, com as faixas de diâmetro */
  byFamily: { family: string; usdPerKg: number | null; fixedUsdPerUnit: number | null; method: string; refFamily: string | null; markupPct: number | null; amount: number; sharePct: number; bands: string[] }[]
  /** % de comissão usados (vazio = sem comissão) */
  commissionPcts: number[]
  /** linhas com ajuste de marca (ex.: Ecobag −5%) */
  brandAdjusts: { brand: string; pct: number }[]
}

/** Resumo para consulta rápida: categoria/comissão/USD/kg principal. */
export function quoteSummary(lines: QuoteSnapshotLine[]): QuoteSummary {
  const fam = new Map<string, QuoteSummary['byFamily'][number]>()
  const famAmt = new Map<string, number>()
  let total = 0
  for (const l of lines) {
    const f = l.factors
    if (!f || l.amount == null) continue
    total += l.amount
    const k = `${f.family}|${f.usdPerKg ?? ''}|${f.fixedUsdPerUnit ?? ''}`
    const cur = fam.get(k) ?? { family: f.family, usdPerKg: f.usdPerKg, fixedUsdPerUnit: f.fixedUsdPerUnit, method: f.method, refFamily: f.refFamily, markupPct: f.markupPct, amount: 0, sharePct: 0, bands: [] }
    cur.amount += l.amount
    // faixa de diâmetro sem o detalhe "(diâmetro X pés, faixa mais próxima)"
    const band = f.priceBand?.split(' (')[0]
    if (band && !cur.bands.includes(band)) cur.bands.push(band)
    fam.set(k, cur)
    if (f.method !== 'INCLUDED') famAmt.set(f.family, (famAmt.get(f.family) ?? 0) + l.amount)
  }
  const pct = (x: number) => (total > 0 ? Math.round((x / total) * 1000) / 10 : 0)
  const byFamily = [...fam.values()].map((x) => ({ ...x, amount: Math.round(x.amount * 100) / 100, sharePct: pct(x.amount) })).sort((a, b) => b.amount - a.amount)
  // principal = a família de maior valor (Silo-bolsa soma as faixas); USD/kg do maior grupo dela
  const topFam = [...famAmt].sort((a, b) => b[1] - a[1])[0]
  const pg = topFam ? byFamily.find((x) => x.family === topFam[0] && x.method !== 'INCLUDED') ?? null : null
  const p = pg && topFam ? { ...pg, sharePct: pct(topFam[1]), groups: byFamily.filter((x) => x.family === topFam[0] && x.method !== 'INCLUDED').length } : null
  const commissionPcts = [...new Set(lines.map((l) => l.commissionPct).filter((x): x is number => x != null && x > 0))].sort((a, b) => a - b)
  const ba = new Map<string, number>()
  for (const l of lines) if (l.factors?.brand && l.factors.brandAdjustPct) ba.set(l.factors.brand, l.factors.brandAdjustPct)
  return {
    principal: p ? { family: p.family, usdPerKg: p.usdPerKg, fixedUsdPerUnit: p.fixedUsdPerUnit, method: p.method, sharePct: p.sharePct, refFamily: p.refFamily, markupPct: p.markupPct, bands: p.bands, groups: p.groups } : null,
    byFamily,
    commissionPcts,
    brandAdjusts: [...ba].map(([brand, pct]) => ({ brand, pct })),
  }
}

/**
 * Conteúdo normalizado da cotação para a assinatura (mesma versão + mesmos preços e fatores = mesma
 * cotação; gerar o PDF de novo só atualiza a data). O hash (SHA-256) é feito no servidor.
 */
export function quoteSignatureInput(lines: QuoteSnapshotLine[]): string {
  const norm = [...lines]
    .sort((a, b) => a.sku.localeCompare(b.sku))
    .map((l) => [l.sku, l.units, l.unitUsd, l.commissionPct ?? null, l.factors ? [l.factors.category, l.factors.usdPerKg, l.factors.fixedUsdPerUnit, l.factors.refFamily, l.factors.markupPct, l.factors.brandAdjustPct, l.factors.netKgUnit, l.factors.incoterm ?? null, l.factors.cifUsdPerKg ?? null] : null])
  return JSON.stringify(norm)
}
