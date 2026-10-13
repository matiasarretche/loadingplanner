import { asc, eq } from 'drizzle-orm'
import { familyTech } from '@/domain/technology'
import { db, schema as s } from '@/db'
import { requireUser } from '@/lib/auth'
import { can } from '@/lib/roles'
import { productSpec, technicalAttrs, technicalDetails } from '@/domain/productSpec'
import { requiredFields, sortProducts } from '@/domain/productOrder'
import { CatalogClient, CatalogFamily, CatalogRow } from './CatalogClient'

// salvar/excluir produto agenda (after) a atualização das montagens de palete padrão; as Server Actions
// rodam na função desta página, então o prazo dela vale para esse recálculo (Vercel Hobby: máx. 300 s)
export const maxDuration = 300

export default async function CatalogoPage() {
  const u = await requireUser()
  // Expedição (sem can.viewPrices) não recebe preços: nem na tela nem no payload enviado ao navegador
  const showPrices = can.viewPrices(u.role)
  const [families, products, variants, packs, pallets] = await Promise.all([
    db.select().from(s.productFamilies).where(eq(s.productFamilies.active, true)).orderBy(asc(s.productFamilies.sort), asc(s.productFamilies.name)),
    db.select().from(s.products),
    db.select().from(s.productVariants).where(eq(s.productVariants.active, true)).orderBy(asc(s.productVariants.sku)),
    db.select().from(s.packagingVersions),
    db.select().from(s.palletTypes).orderBy(asc(s.palletTypes.code)),
  ])
  const current = new Map<number, (typeof packs)[number]>()
  for (const p of packs) {
    const c = current.get(p.variantId)
    if (!c || p.version > c.version) current.set(p.variantId, p)
  }
  const productById = new Map(products.map((p) => [p.id, p]))
  const palletCode = new Map(pallets.map((p) => [p.id, p.code]))

  const rows: CatalogRow[] = variants.flatMap((v) => {
    const prod = productById.get(v.productId)
    if (!prod) return []
    const pk = current.get(v.id)
    return [
      {
        variantId: v.id,
        familyId: prod.familyId,
        line: prod.name,
        sku: v.sku,
        name: v.name,
        brand: v.brand,
        spec: productSpec(technicalAttrs(v.attrs, v), v.thicknessUm),
        tech: technicalDetails(technicalAttrs(v.attrs, v), v.thicknessUm),
        thicknessUm: v.thicknessUm,
        diameterFt: v.diameterFt,
        widthM: v.widthM,
        lengthM: v.lengthM,
        lengthFt: v.lengthFt,
        required: requiredFields(families.find((f) => f.id === prod.familyId)?.name),
        notes: v.notes ?? '',
        price: showPrices ? v.price : null,
        priceCurrency: showPrices ? v.priceCurrency : '',
        priceUnit: showPrices ? v.priceUnit : '',
        pack: pk
          ? {
              version: pk.version,
              locked: pk.locked,
              packageType: pk.packageType,
              lengthMm: pk.lengthMm,
              widthMm: pk.widthMm,
              heightMm: pk.heightMm,
              netKg: pk.netKg,
              grossKg: pk.grossKg,
              unitsPerPallet: pk.unitsPerPallet,
              unitsPerPackage: pk.unitsPerPackage,
              palletTypeId: pk.palletTypeId,
              palletCode: pk.palletTypeId ? palletCode.get(pk.palletTypeId) ?? null : null,
              verification: pk.verification,
              stackable: pk.stackable,
              allowedOrientations: pk.allowedOrientations,
            }
          : null,
      },
    ]
  })
  // ordem única da plataforma (domain/productOrder): dentro da família, medidas numéricas de menor a maior
  const variantById = new Map(variants.map((v) => [v.id, v]))
  const famById = new Map(families.map((f) => [f.id, f]))
  const sorted = sortProducts(rows, (r) => {
    const v = variantById.get(r.variantId)
    const f = famById.get(r.familyId)
    return { familySort: f?.sort, familyName: f?.name, attrs: v ? technicalAttrs(v.attrs, v) : null, thicknessUm: v?.thicknessUm, sku: r.sku, brand: r.brand }
  })
  rows.splice(0, rows.length, ...sorted)
  const fams: CatalogFamily[] = families.map((f) => ({
    id: f.id,
    code: f.code,
    name: f.name,
    tech: familyTech(f),
    lines: [...new Set(products.filter((p) => p.familyId === f.id).map((p) => p.name))].sort(),
  }))
  return (
    <CatalogClient
      families={fams}
      rows={rows.filter((r) => fams.some((f) => f.id === r.familyId))}
      pallets={pallets.filter((p) => p.active).map((p) => ({ id: p.id, label: `${p.code} — ${p.lengthMm}×${p.widthMm}` }))}
      editable={can.editCatalog(u.role)}
      showPrices={showPrices}
    />
  )
}
