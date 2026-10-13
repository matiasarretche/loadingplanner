import 'server-only'
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '@/db'
import { bandPriceKey, brandKey, buildPriceTwins, commissionKey, diameterFtOf, PriceBand, PricedProduct, PricingPayload, quotePrice, priceKey, PriceMethod, PricingConfig, WATER_TANK_FAMILY } from '@/domain/exportPricing'
import { countryCode } from './countries'

/** chave do recargo CIF padrão em export_price_setting */
export const CIF_SETTING = 'cif_usd_per_kg'

/** Configuração comercial vigente (categorias, países, regras e preços por família). */
export async function loadPricingConfig(): Promise<PricingConfig> {
  const [categories, countries, rules, prices, brands, commissions, settings, priceTwin, bands] = await Promise.all([
    db.select().from(schema.priceCategories),
    db.select().from(schema.countryPriceCategories),
    db.select().from(schema.familyPriceRules),
    db.select().from(schema.familyPrices),
    db.select().from(schema.brandPriceAdjustments),
    db.select().from(schema.commissionRates),
    db.select().from(schema.exportPriceSettings),
    loadPriceTwins(),
    loadPriceBands(),
  ])
  return {
    categories: categories.sort((a, b) => a.sort - b.sort || a.code.localeCompare(b.code)).map((c) => ({ id: c.id, code: c.code, name: c.name, active: c.active })),
    countryCategory: new Map(countries.map((c) => [c.countryCode, c.categoryId])),
    familyRule: new Map(rules.map((r) => [r.familyId, { method: r.method as PriceMethod, refFamilyId: r.refFamilyId, markupPct: r.markupPct, cifUsdPerKg: r.cifUsdPerKg }])),
    cifDefaultUsdPerKg: settings.find((x) => x.key === CIF_SETTING)?.value ?? null,
    brandAdjust: new Map(brands.map((b) => [brandKey(b.brand), b.pct])),
    commission: new Map(commissions.map((c) => [commissionKey(c.agentId, c.familyId), c.pct])),
    familyPrice: new Map(prices.map((p) => [priceKey(p.familyId, p.categoryId), { usdPerKg: p.usdPerKg, fixedUsdPerUnit: p.fixedUsdPerUnit }])),
    priceTwin,
    ...bands,
  }
}

/**
 * Faixas de diâmetro com USD/kg próprio (Silo-bolsa), o USD/kg de cada faixa por categoria e o diâmetro (pés)
 * dos SKUs do catálogo que têm diâmetro (ativos ou não: uma carga salva pode ter um SKU desativado depois).
 */
export async function loadPriceBands(): Promise<Pick<PricingConfig, 'familyBands' | 'bandPrice' | 'skuDiameterFt'>> {
  const [bandRows, priceRows] = await Promise.all([db.select().from(schema.familyPriceBands), db.select().from(schema.familyBandPrices)])
  const familyBands = new Map<number, PriceBand[]>()
  for (const b of [...bandRows].sort((a, c) => a.sort - c.sort || a.minFt - c.minFt)) familyBands.set(b.familyId, [...(familyBands.get(b.familyId) ?? []), { key: b.key, label: b.label, minFt: b.minFt, maxFt: b.maxFt }])
  const bandPrice = new Map(priceRows.filter((p) => p.usdPerKg != null).map((p) => [bandPriceKey(p.familyId, p.categoryId, p.bandKey), p.usdPerKg!]))
  const skuDiameterFt = new Map<string, number>()
  if (familyBands.size) {
    // todos os SKUs com diâmetro (uma família relativa ao Silo-bolsa também usa a faixa do diâmetro)
    const vs = await db.select({ sku: schema.productVariants.sku, diameterFt: schema.productVariants.diameterFt, attrs: schema.productVariants.attrs, name: schema.productVariants.name }).from(schema.productVariants)
    for (const v of vs) {
      const ft = diameterFtOf(v)
      if (ft != null) skuDiameterFt.set(v.sku.toUpperCase(), ft)
    }
  }
  return { familyBands, bandPrice, skuDiameterFt }
}

/**
 * Hidrosilo / Hidroforce de 3 m → Hidrosilo de 2 m da mesma capacidade. Os 3 m entram ativos ou não (carga
 * salva com um 3 m desativado depois); referência 2 m só ativa, com a embalagem vigente.
 */
export async function loadPriceTwins() {
  const rows = await db
    .select({
      sku: schema.productVariants.sku,
      brand: schema.productVariants.brand,
      widthM: schema.productVariants.widthM,
      attrs: schema.productVariants.attrs,
      family: schema.productFamilies.name,
      netKg: schema.packagingVersions.netKg,
      upp: schema.packagingVersions.unitsPerPackage,
      vActive: schema.productVariants.active,
      pActive: schema.products.active,
      fActive: schema.productFamilies.active,
    })
    .from(schema.productVariants)
    .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
    .innerJoin(schema.productFamilies, eq(schema.productFamilies.id, schema.products.familyId))
    .leftJoin(schema.packagingVersions, and(eq(schema.packagingVersions.variantId, schema.productVariants.id), isNull(schema.packagingVersions.validTo)))
  return buildPriceTwins(
    rows
      .filter((r) => WATER_TANK_FAMILY.test(r.family))
      .map((r) => {
        const cap = (r.attrs as Record<string, unknown> | null)?.capacidade_l
        return { sku: r.sku, family: r.family, brand: r.brand, widthM: r.widthM, capacityL: typeof cap === 'number' ? cap : null, netKg: r.netKg != null ? r.netKg / Math.max(1, r.upp ?? 1) : null, active: r.vActive && r.pActive && r.fActive }
      }),
  )
}

/**
 * Produtos ATIVOS do catálogo mestre com o que o preço precisa: família e peso líquido da embalagem
 * vigente (por unidade de venda). Nada disso é copiado para as tabelas de preço.
 */
export async function catalogPricedProducts(): Promise<(PricedProduct & { name: string; family: string })[]> {
  const rows = await db
    .select({ v: schema.productVariants, familyId: schema.products.familyId, family: schema.productFamilies.name, pv: schema.packagingVersions })
    .from(schema.productVariants)
    .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
    .innerJoin(schema.productFamilies, eq(schema.productFamilies.id, schema.products.familyId))
    .leftJoin(schema.packagingVersions, eq(schema.packagingVersions.variantId, schema.productVariants.id))
    .where(eq(schema.productVariants.active, true))
  const latest = new Map<number, (typeof rows)[number]>()
  for (const r of rows) {
    const cur = latest.get(r.v.id)
    if (!cur || (r.pv?.version ?? 0) > (cur.pv?.version ?? 0)) latest.set(r.v.id, r)
  }
  return [...latest.values()].map((r) => {
    // peso líquido por UNIDADE de venda: a embalagem guarda o líquido da caixa
    const upp = r.pv?.unitsPerPackage ?? 1
    return { sku: r.v.sku, name: r.v.name, brand: r.v.brand, familyId: r.familyId, family: r.family, netKg: r.pv ? r.pv.netKg / Math.max(1, upp) : null }
  })
}

/**
 * Preço de um produto (SKU) para o país de destino — ponto de entrada das futuras Proformas:
 * país → categoria → família → regra + preço da família → peso líquido do catálogo → marca →
 * comissão do agente (se a venda for via agente; o % pode ser informado manualmente na cotização).
 */
export async function exportPriceFor(sku: string, country: string | null | undefined, o: { agentId?: number | null; commissionPct?: number | null; incoterm?: string | null } = {}) {
  const [cfg, products] = await Promise.all([loadPricingConfig(), catalogPricedProducts()])
  const p = products.find((x) => x.sku.toUpperCase() === sku.toUpperCase())
  if (!p) return { ok: false as const, reason: `produto ${sku} não encontrado no catálogo`, category: null, commission: null }
  return quotePrice(cfg, p, countryCode(country) ?? country ?? null, o)
}

/** Configuração + família/marca dos SKUs + agentes ativos, serializável para o navegador. */
export async function pricingPayload(): Promise<PricingPayload> {
  const [cfg, products, agents] = await Promise.all([loadPricingConfig(), catalogPricedProducts(), db.select().from(schema.agents).where(eq(schema.agents.active, true))])
  return {
    categories: cfg.categories,
    countryCategory: [...cfg.countryCategory],
    familyRule: [...cfg.familyRule],
    familyPrice: [...cfg.familyPrice],
    brandAdjust: [...(cfg.brandAdjust ?? [])],
    commission: [...(cfg.commission ?? [])],
    cifDefaultUsdPerKg: cfg.cifDefaultUsdPerKg ?? null,
    priceTwin: [...(cfg.priceTwin ?? [])],
    familyBands: [...(cfg.familyBands ?? [])],
    bandPrice: [...(cfg.bandPrice ?? [])],
    skuDiameterFt: [...(cfg.skuDiameterFt ?? [])],
    products: products.map((p) => ({ sku: p.sku, familyId: p.familyId, brand: p.brand ?? null })),
    agents: agents.map((a) => ({ id: a.id, name: a.name })).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
  }
}
