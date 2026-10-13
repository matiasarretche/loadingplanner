import 'server-only'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '@/db'
import { compareProducts, ProductOrderInput } from '@/domain/productOrder'
import { FamilyTech, familyTech } from '@/domain/technology'
import { technicalAttrs } from '@/domain/productSpec'
import type { PackSnapshot, PalletDoc, PalletTypeSnapshot } from '@/domain/types'
import { packSnapshot, palletTypeSnapshot } from './snapshots'

/**
 * Ordem única dos produtos (domain/productOrder): família (ordem cadastrada) e, dentro dela, medidas
 * numéricas. Devolve o ranking por SKU (maiúsculas) para ordenar qualquer lista (seletores, PDFs…).
 */
export async function productRank(): Promise<Map<string, number>> {
  const rows = await db
    .select({ v: schema.productVariants, f: schema.productFamilies })
    .from(schema.productVariants)
    .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
    .innerJoin(schema.productFamilies, eq(schema.productFamilies.id, schema.products.familyId))
  const items: ProductOrderInput[] = rows.map(({ v, f }) => ({ familySort: f.sort, familyName: f.name, attrs: technicalAttrs(v.attrs, v), thicknessUm: v.thicknessUm, sku: v.sku, brand: v.brand }))
  items.sort(compareProducts)
  return new Map(items.map((x, i) => [x.sku.toUpperCase(), i]))
}

/**
 * Tecnologia comercial (PACIFIL NXT: menção ou selo) de cada SKU, herdada da família no Catálogo. Chave = SKU em
 * maiúsculas; SKUs de famílias sem tecnologia não entram. Inclui SKUs inativos (cargas antigas).
 */
export async function productTechBySku(): Promise<Map<string, FamilyTech>> {
  const rows = await db
    .select({ sku: schema.productVariants.sku, technology: schema.productFamilies.technology, technologyDisplay: schema.productFamilies.technologyDisplay })
    .from(schema.productVariants)
    .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
    .innerJoin(schema.productFamilies, eq(schema.productFamilies.id, schema.products.familyId))
  const m = new Map<string, FamilyTech>()
  for (const r of rows) {
    const t = familyTech(r)
    if (t) m.set(r.sku.toUpperCase(), t)
  }
  return m
}

/** Posição de um SKU no ranking (desconhecidos vão ao fim, em ordem natural de código). */
export const rankOf = (rank: Map<string, number>, sku: string) => rank.get(sku.toUpperCase()) ?? Number.MAX_SAFE_INTEGER

/** Ordena montagens de palete pelo produto principal (o de mais caixas) na ordem única. */
export function sortCompositions<T extends { name: string; document: PalletDoc }>(list: T[], rank: Map<string, number>): T[] {
  const main = (d: PalletDoc) => {
    const n = new Map<string, number>()
    for (const it of d.items) {
      const sku = d.packs[it.packId]?.sku
      if (sku) n.set(sku, (n.get(sku) ?? 0) + 1)
    }
    return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
  }
  return [...list].sort((a, b) => rankOf(rank, main(a.document)) - rankOf(rank, main(b.document)) || a.name.localeCompare(b.name, 'pt-BR', { numeric: true }))
}

/** Embalagens vigentes (maior versão por variante ativa) prontas para uso nos editores. */
export async function currentPackCatalog(): Promise<PackSnapshot[]> {
  const rows = await db
    .select({ pv: schema.packagingVersions, v: schema.productVariants })
    .from(schema.packagingVersions)
    .innerJoin(schema.productVariants, and(eq(schema.productVariants.id, schema.packagingVersions.variantId), eq(schema.productVariants.active, true)))
    // produto e família desativados também saem dos editores
    .innerJoin(schema.products, and(eq(schema.products.id, schema.productVariants.productId), eq(schema.products.active, true)))
    .innerJoin(schema.productFamilies, and(eq(schema.productFamilies.id, schema.products.familyId), eq(schema.productFamilies.active, true)))
  const latest = new Map<number, (typeof rows)[number]>()
  for (const r of rows) {
    const cur = latest.get(r.v.id)
    if (!cur || r.pv.version > cur.pv.version) latest.set(r.v.id, r)
  }
  const rank = await productRank()
  return [...latest.values()].map((r) => packSnapshot(r.pv, r.v)).sort((a, b) => rankOf(rank, a.sku) - rankOf(rank, b.sku) || a.sku.localeCompare(b.sku, 'pt-BR', { numeric: true }))
}

/** Tipos de palete ativos + palete padrão de cada embalagem vigente (para o otimizador de paletes mistos). */
export async function palletingData(): Promise<{ palletTypes: PalletTypeSnapshot[]; stdPallet: Record<string, number> }> {
  const [types, rows] = await Promise.all([
    db.select().from(schema.palletTypes).where(eq(schema.palletTypes.active, true)),
    db.select({ id: schema.packagingVersions.id, variantId: schema.packagingVersions.variantId, version: schema.packagingVersions.version, palletTypeId: schema.packagingVersions.palletTypeId }).from(schema.packagingVersions),
  ])
  const latest = new Map<number, (typeof rows)[number]>()
  for (const r of rows) if (!latest.get(r.variantId) || r.version > latest.get(r.variantId)!.version) latest.set(r.variantId, r)
  const stdPallet: Record<string, number> = {}
  for (const r of latest.values()) if (r.palletTypeId != null) stdPallet[`pv${r.id}`] = r.palletTypeId
  return { palletTypes: types.map(palletTypeSnapshot).sort((a, b) => a.code.localeCompare(b.code)), stdPallet }
}

/** Marca versões de embalagem como usadas (bloqueia edição; exige nova versão). */
export async function lockPackagingVersions(ids: number[]) {
  const unique = [...new Set(ids)]
  for (const id of unique) {
    await db.update(schema.packagingVersions).set({ locked: true }).where(eq(schema.packagingVersions.id, id))
  }
}
