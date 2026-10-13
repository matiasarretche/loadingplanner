import 'server-only'
import { and, eq, isNull } from 'drizzle-orm'
import { db, schema } from '@/db'
import { diameterFtOf, quotePrice } from '@/domain/exportPricing'
import { loadPricingConfig } from './exportPricing'

/**
 * LISTA DE PREÇOS (PDF para o cliente): preço por UNIDADE de cada produto do catálogo numa categoria
 * comercial, num Incoterm e, se houver, com a comissão de um agente — o MESMO cálculo da Proforma
 * (família → regra → marca → recargo CIF → comissão → para cima ao dólar inteiro).
 */
export interface PriceListRow {
  sku: string
  name: string
  brand: string
  widthM: number | null
  lengthM: number | null
  thicknessUm: number | null
  capacityL: number | null
  box: { l: number; w: number; h: number } | null
  unitsPerPallet: number | null
  palletCode: string | null
  netKg: number | null
  /** produto + caixa (por unidade) */
  grossKg: number | null
  priceUsd: number | null
  /** por que não tem preço (ex.: família sem preço na categoria) */
  reason: string | null
}

export interface PriceListGroup {
  family: string
  /** subtítulo do grupo (ex.: largura "2 m") */
  label: string
  rows: PriceListRow[]
}

export interface PriceListData {
  category: { id: number; name: string }
  incoterm: string
  agent: { id: number; name: string } | null
  groups: PriceListGroup[]
  generatedAt: Date
}

/** item escolhível na tela da lista (mesma ordem do PDF) */
export interface PriceListItem {
  sku: string
  name: string
  family: string
  /** subgrupo na tela: largura ("2 m") ou diâmetro do silo-bolsa ("9 pés") */
  sub: string
  /** marca comercial do SKU (Pacifil, Agromai, Ecobag…): filtro por marca na tela */
  brand: string
}

/** variantes ativas de produtos e famílias ativos, com a embalagem vigente */
async function catalogRows() {
  return db
    .select({ v: schema.productVariants, family: schema.productFamilies.name, familyId: schema.products.familyId, pv: schema.packagingVersions, pallet: schema.palletTypes.code })
    .from(schema.productVariants)
    .innerJoin(schema.products, and(eq(schema.products.id, schema.productVariants.productId), eq(schema.products.active, true)))
    .innerJoin(schema.productFamilies, and(eq(schema.productFamilies.id, schema.products.familyId), eq(schema.productFamilies.active, true)))
    .leftJoin(schema.packagingVersions, and(eq(schema.packagingVersions.variantId, schema.productVariants.id), isNull(schema.packagingVersions.validTo)))
    .leftJoin(schema.palletTypes, eq(schema.palletTypes.id, schema.packagingVersions.palletTypeId))
    .where(eq(schema.productVariants.active, true))
}
type CatalogRow = Awaited<ReturnType<typeof catalogRows>>[number]

const attrsOf = (r: CatalogRow) => (r.v.attrs ?? {}) as Record<string, unknown>
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null)
/** largura para ordenar; o silo-bolsa não tem largura, usa o diâmetro (campo em pés → m; attrs.diametro_m só como legado) */
const widthKey = (r: CatalogRow) => r.v.widthM ?? (r.v.diameterFt != null ? r.v.diameterFt * 0.3048 : num(attrsOf(r).diametro_m)) ?? 0
/** largura, capacidade, comprimento, código */
const byCatalogOrder = (a: CatalogRow, b: CatalogRow) =>
  widthKey(a) - widthKey(b) || (num(attrsOf(a).capacidade_l) ?? 0) - (num(attrsOf(b).capacidade_l) ?? 0) || (a.v.lengthM ?? 0) - (b.v.lengthM ?? 0) || a.v.sku.localeCompare(b.v.sku)
const mLabel = (w: number) => `${String(w).replace('.', ',')} m`
const ftLabel = (ft: number) => `${String(ft).replace('.', ',')} pés`

/** Hidrosilo / Hydroforce: separados por largura também no PDF */
const isWaterTank = (family: string) => /hidrosilo|hidroforce|hydroforce/i.test(family)

function subLabel(r: CatalogRow): string {
  if (r.v.widthM) return mLabel(r.v.widthM)
  // silo-bolsa: diâmetro (campo do catálogo, attrs.diametro_m ou "9 pés" no nome)
  const ft = diameterFtOf(r.v)
  return ft ? ftLabel(ft) : ''
}

/** todos os itens do catálogo para escolher na tela (a tela mostra só os das famílias com preço próprio) */
export async function priceListItems(): Promise<PriceListItem[]> {
  const rows = (await catalogRows()).sort((a, b) => a.family.localeCompare(b.family, 'pt-BR') || byCatalogOrder(a, b))
  return rows.map((r) => ({ sku: r.v.sku, name: r.v.name, family: r.family, sub: subLabel(r), brand: r.v.brand }))
}

/**
 * families vazio = todas as famílias com preço próprio (as "incluídas", ex.: KIT-HF, ficam de fora);
 * skus = só esses itens (dentro das famílias escolhidas); null/ausente = todos os itens das famílias.
 */
export async function priceListData(o: { families: string[]; skus?: string[] | null; categoryId: number; incoterm: string; agentId?: number | null; groupByWidth?: boolean }): Promise<PriceListData> {
  const cfg = await loadPricingConfig()
  const cat = cfg.categories.find((c) => c.id === o.categoryId)
  if (!cat) throw new Error('Categoria não encontrada.')
  // o cálculo é por país: qualquer país da categoria dá o mesmo preço
  const country = [...cfg.countryCategory.entries()].find(([, id]) => id === o.categoryId)?.[0] ?? null
  const agent = o.agentId ? (await db.query.agents.findFirst({ where: eq(schema.agents.id, o.agentId) })) ?? null : null
  const skuSet = o.skus ? new Set(o.skus) : null
  const wanted = (await catalogRows())
    .filter((r) => (o.families.length ? o.families.some((f) => f.toLowerCase() === r.family.toLowerCase()) : true) && cfg.familyRule.get(r.familyId)?.method !== 'INCLUDED' && (!skuSet || skuSet.has(r.v.sku)))
    .sort(byCatalogOrder)
  const groups = new Map<string, PriceListGroup>()
  for (const r of wanted) {
    const v = r.v
    const upp = Math.max(1, r.pv?.unitsPerPackage ?? 1)
    const netKg = r.pv ? r.pv.netKg / upp : null
    const q = country ? quotePrice(cfg, { sku: v.sku, familyId: r.familyId, brand: v.brand, netKg }, country, { agentId: agent?.id ?? null, incoterm: o.incoterm }) : null
    const priceUsd = q && q.ok && !(q.commission && q.commission.pct == null) ? q.unitUsd : null
    const reason = !country ? 'categoria sem país' : q && !q.ok ? q.reason : q?.commission && q.commission.pct == null ? (q.commission.warning ?? 'sem % de comissão') : null
    const row: PriceListRow = {
      sku: v.sku,
      name: v.name,
      brand: v.brand,
      widthM: v.widthM,
      lengthM: v.lengthM,
      thicknessUm: v.thicknessUm,
      capacityL: num(attrsOf(r).capacidade_l),
      box: r.pv ? { l: r.pv.lengthMm, w: r.pv.widthMm, h: r.pv.heightMm } : null,
      unitsPerPallet: r.pv?.unitsPerPallet ?? null,
      palletCode: r.pallet ?? null,
      netKg,
      grossKg: r.pv ? r.pv.grossKg / upp : null,
      priceUsd,
      reason,
    }
    // separado por largura só Hidrosilo / Hydroforce (lonas e demais: um grupo por família, ordenado por largura)
    const label = o.groupByWidth && v.widthM && isWaterTank(r.family) ? mLabel(v.widthM) : ''
    const key = `${r.family}|${label}`
    if (!groups.has(key)) groups.set(key, { family: r.family, label, rows: [] })
    groups.get(key)!.rows.push(row)
  }
  // ordem: família, largura (as linhas já vêm na ordem do catálogo: largura, capacidade, comprimento)
  const list = [...groups.values()].sort((a, b) => a.family.localeCompare(b.family, 'pt-BR') || parseFloat(a.label.replace(',', '.') || '0') - parseFloat(b.label.replace(',', '.') || '0'))
  return { category: { id: cat.id, name: cat.name }, incoterm: o.incoterm, agent: agent ? { id: agent.id, name: agent.name } : null, groups: list, generatedAt: new Date() }
}
