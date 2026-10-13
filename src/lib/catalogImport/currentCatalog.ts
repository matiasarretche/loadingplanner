// Sem 'server-only': também é usado pelo script de linha de comando (scripts/catalog-import-dry-run.ts).
import { createHash } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { db, schema as s } from '@/db'
import type { CurrentCatalog, CurrentPack, CurrentVariant } from '@/domain/catalogImport/types'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
/** banco ou transação aberta (a aplicação confere o catálogo dentro da própria transação) */
export type Exec = typeof db | Tx

/**
 * Catálogo atual para o motor da importação: TODAS as variantes (ativas e inativas — o código oficial pode
 * coincidir com um SKU desativado), com família, linha e a embalagem de maior versão (com o código do palete).
 * `active` = variante, linha e família ativas.
 */
export async function loadCurrentCatalog(exec: Exec = db): Promise<CurrentCatalog> {
  // uma consulta por vez: numa transação o cliente do pg não aceita consultas simultâneas
  const variantRows = await exec
    .select({ v: s.productVariants, p: { id: s.products.id, name: s.products.name, active: s.products.active }, f: { code: s.productFamilies.code, name: s.productFamilies.name, active: s.productFamilies.active } })
    .from(s.productVariants)
    .innerJoin(s.products, eq(s.products.id, s.productVariants.productId))
    .innerJoin(s.productFamilies, eq(s.productFamilies.id, s.products.familyId))
  const packRows = await exec
    .select({
      id: s.packagingVersions.id,
      variantId: s.packagingVersions.variantId,
      version: s.packagingVersions.version,
      locked: s.packagingVersions.locked,
      lengthMm: s.packagingVersions.lengthMm,
      widthMm: s.packagingVersions.widthMm,
      heightMm: s.packagingVersions.heightMm,
      netKg: s.packagingVersions.netKg,
      grossKg: s.packagingVersions.grossKg,
      unitsPerPackage: s.packagingVersions.unitsPerPackage,
      unitsPerPallet: s.packagingVersions.unitsPerPallet,
      verification: s.packagingVersions.verification,
      palletTypeCode: s.palletTypes.code,
    })
    .from(s.packagingVersions)
    .leftJoin(s.palletTypes, eq(s.palletTypes.id, s.packagingVersions.palletTypeId))
  const families = await exec.select({ id: s.productFamilies.id, code: s.productFamilies.code, name: s.productFamilies.name, active: s.productFamilies.active, sort: s.productFamilies.sort }).from(s.productFamilies)
  const lines = await exec.select({ id: s.products.id, familyId: s.products.familyId, name: s.products.name, active: s.products.active }).from(s.products)
  const palletTypes = await exec
    .select({
      id: s.palletTypes.id,
      code: s.palletTypes.code,
      lengthMm: s.palletTypes.lengthMm,
      widthMm: s.palletTypes.widthMm,
      heightMm: s.palletTypes.heightMm,
      overhangAllowed: s.palletTypes.overhangAllowed,
      overhangMaxMm: s.palletTypes.overhangMaxMm,
      active: s.palletTypes.active,
    })
    .from(s.palletTypes)

  // embalagem vigente = maior versão de cada variante
  const packs = new Map<number, CurrentPack>()
  for (const r of packRows) {
    const cur = packs.get(r.variantId)
    if (cur && cur.version >= r.version) continue
    packs.set(r.variantId, {
      packagingVersionId: r.id,
      version: r.version,
      locked: r.locked,
      lengthMm: r.lengthMm,
      widthMm: r.widthMm,
      heightMm: r.heightMm,
      netKg: r.netKg,
      grossKg: r.grossKg,
      unitsPerPackage: r.unitsPerPackage,
      unitsPerPallet: r.unitsPerPallet,
      palletTypeCode: r.palletTypeCode ?? null,
      verification: r.verification,
    })
  }

  const variants: CurrentVariant[] = variantRows
    .map(({ v, p, f }) => ({
      variantId: v.id,
      productId: p.id,
      sku: v.sku,
      name: v.name,
      familyCode: f.code,
      familyName: f.name,
      line: p.name,
      brand: v.brand,
      active: v.active && p.active && f.active,
      thicknessUm: v.thicknessUm,
      diameterFt: v.diameterFt,
      widthM: v.widthM,
      lengthM: v.lengthM,
      lengthFt: v.lengthFt,
      attrs: v.attrs ?? {},
      ean: v.ean,
      pack: packs.get(v.id) ?? null,
    }))
    .sort((a, b) => a.variantId - b.variantId)

  return { variants, families: families.sort((a, b) => a.id - b.id), lines: lines.sort((a, b) => a.id - b.id), palletTypes: palletTypes.sort((a, b) => a.id - b.id) }
}

/**
 * "Impressão digital" do catálogo: muda com qualquer produto/embalagem criado, alterado ou excluído, e com
 * linhas, famílias e paletes novos ou (des)ativados. A prévia guarda a de quando foi gerada; aplicar
 * exige a mesma (senão o plano pode estar desatualizado).
 */
export async function catalogFingerprint(exec: Exec = db): Promise<string> {
  const r = await exec.execute<{ v: string; pv: string; p: string; f: string; pt: string }>(sql`
    SELECT
      (SELECT count(*) || '|' || coalesce(max(id), 0) || '|' || coalesce(max(updated_at)::text, '') FROM product_variant) AS v,
      (SELECT count(*) || '|' || coalesce(max(id), 0) || '|' || coalesce(max(updated_at)::text, '') FROM packaging_version) AS pv,
      (SELECT count(*) || '|' || count(*) FILTER (WHERE active) || '|' || coalesce(max(updated_at)::text, '') FROM product) AS p,
      (SELECT count(*) || '|' || count(*) FILTER (WHERE active) || '|' || coalesce(sum(sort), 0) FROM product_family) AS f,
      (SELECT count(*) || '|' || count(*) FILTER (WHERE active) || '|' || coalesce(max(updated_at)::text, '') FROM pallet_type) AS pt
  `)
  const row = r.rows[0]
  return createHash('sha256').update([row.v, row.pv, row.p, row.f, row.pt].join('#')).digest('hex').slice(0, 32)
}
