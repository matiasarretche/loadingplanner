/**
 * Atualiza a linha Hidrosilo conforme "Capacidad_y_Embalaje_HIDROSILO_ESP.pdf":
 * mantém só as 11 capacidades do PDF (caixa e caixas/palete), cria o "Pallet doble 2,30 × 1,15"
 * e exclui (desativa) os demais SKUs Hidrosilo e suas montagens REF.
 * Uso: npx tsx --env-file=.env scripts/update-hidrosilo.ts [--dry]
 */
import { and, desc, eq, inArray, like } from 'drizzle-orm'
import { db, schema as s } from '../src/db'

const SOURCE = 'Capacidad_y_Embalaje_HIDROSILO_ESP.pdf (01/10/2026)'
type Pal = 'SIMPLE' | 'DOUBLE'
const PDF: { sku: string; name: string; litros: number; l: number; w: number; h: number; upp: number; pal: Pal }[] = [
  { sku: 'HS-500L', name: 'Hidrosilo 500 L', litros: 500, l: 600, w: 500, h: 130, upp: 60, pal: 'SIMPLE' },
  { sku: 'HS-1K', name: 'Hidrosilo 1.000 L', litros: 1000, l: 600, w: 500, h: 130, upp: 60, pal: 'SIMPLE' },
  { sku: 'HS-2K', name: 'Hidrosilo 2.000 L', litros: 2000, l: 600, w: 500, h: 130, upp: 60, pal: 'SIMPLE' },
  { sku: 'HS-5K', name: 'Hidrosilo 5.000 L', litros: 5000, l: 1140, w: 570, h: 110, upp: 36, pal: 'SIMPLE' },
  { sku: 'HS-10K', name: 'Hidrosilo 10.000 L', litros: 10000, l: 1140, w: 570, h: 150, upp: 26, pal: 'SIMPLE' },
  { sku: 'HS-15K', name: 'Hidrosilo 15.000 L', litros: 15000, l: 1140, w: 570, h: 250, upp: 16, pal: 'SIMPLE' },
  { sku: 'HS-20K', name: 'Hidrosilo 20.000 L', litros: 20000, l: 1140, w: 570, h: 250, upp: 16, pal: 'SIMPLE' },
  { sku: 'HS-25K', name: 'Hidrosilo 25.000 L', litros: 25000, l: 2250, w: 380, h: 180, upp: 33, pal: 'DOUBLE' },
  { sku: 'HS-30K', name: 'Hidrosilo 30.000 L', litros: 30000, l: 2250, w: 380, h: 260, upp: 21, pal: 'DOUBLE' },
  { sku: 'HS-40K', name: 'Hidrosilo 40.000 L', litros: 40000, l: 2250, w: 380, h: 260, upp: 21, pal: 'DOUBLE' },
  { sku: 'HS-50K', name: 'Hidrosilo 50.000 L', litros: 50000, l: 2250, w: 380, h: 310, upp: 18, pal: 'DOUBLE' },
]

async function main() {
  const dry = process.argv.includes('--dry')
  const log: string[] = []
  const fam = await db.query.productFamilies.findFirst({ where: eq(s.productFamilies.code, 'HIDROSILO') })
  if (!fam) throw new Error('Família HIDROSILO não encontrada')
  const simple = await db.query.palletTypes.findFirst({ where: eq(s.palletTypes.code, 'PCF-1150') })
  if (!simple) throw new Error('Palete PCF-1150 não encontrado')

  await db.transaction(async (tx) => {
    // Palete duplo (2 × 1,15 × 1,15)
    let double = await tx.query.palletTypes.findFirst({ where: eq(s.palletTypes.code, 'PCF-1150-DUPLO') })
    if (!double) {
      if (!dry)
        [double] = await tx
          .insert(s.palletTypes)
          .values({
            code: 'PCF-1150-DUPLO',
            name: 'Pallet doble 2,30 × 1,15',
            lengthMm: 2300,
            widthMm: 1150,
            heightMm: 150,
            material: 'Madeira',
            verification: 'ESTIMATED',
            source: SOURCE,
            notes: '2 × pallet 1,15 × 1,15 lado a lado (usado nas caixas de 2,25 m do Hidrosilo). Completar tara e capacidade.',
          })
          .returning()
      log.push('Palete criado: PCF-1150-DUPLO (2.300 × 1.150 × 150 mm)')
    }

    let product = await tx.query.products.findFirst({ where: and(eq(s.products.familyId, fam.id), eq(s.products.name, 'Hidrosilo')) })
    if (!product && !dry) [product] = await tx.insert(s.products).values({ familyId: fam.id, name: 'Hidrosilo' }).returning()

    const today = new Date().toISOString().slice(0, 10)
    for (const it of PDF) {
      const palletTypeId = it.pal === 'SIMPLE' ? simple.id : double?.id ?? null
      const note = `Fonte: ${SOURCE} — caixa ${it.l}×${it.w}×${it.h} mm, ${it.upp} caixas/palete, ${it.pal === 'SIMPLE' ? 'pallet simples 1,15×1,15' : 'pallet duplo 2,30×1,15'}. Peso líquido não informado no PDF.`
      let v = await tx.query.productVariants.findFirst({ where: eq(s.productVariants.sku, it.sku) })
      if (!v) {
        if (!dry) [v] = await tx.insert(s.productVariants).values({ productId: product!.id, sku: it.sku, name: it.name, attrs: { capacidade_l: it.litros } }).returning()
        log.push(`SKU criado: ${it.sku}`)
      } else if (!dry) {
        await tx.update(s.productVariants).set({ name: it.name, active: true, attrs: { capacidade_l: it.litros } }).where(eq(s.productVariants.id, v.id))
      }
      if (!v) continue
      const [cur] = await tx.select().from(s.packagingVersions).where(eq(s.packagingVersions.variantId, v.id)).orderBy(desc(s.packagingVersions.version)).limit(1)
      const pack = { lengthMm: it.l, widthMm: it.w, heightMm: it.h, unitsPerPallet: it.upp, palletTypeId, notes: note, verification: 'ESTIMATED' as const }
      if (!cur) {
        if (!dry) await tx.insert(s.packagingVersions).values({ ...pack, variantId: v.id, version: 1, validFrom: today, packageType: 'Caixa', netKg: 0, grossKg: 0, allowedOrientations: ['LWH', 'WLH'] })
        log.push(`${it.sku}: embalagem v1 criada (peso pendente)`)
        continue
      }
      const diff = (['lengthMm', 'widthMm', 'heightMm', 'unitsPerPallet', 'palletTypeId'] as const).filter((k) => cur[k] !== pack[k])
      if (!diff.length && cur.notes === note) {
        log.push(`${it.sku}: já conforme o PDF`)
        continue
      }
      if (cur.locked && diff.some((k) => k !== 'palletTypeId')) {
        if (!dry) {
          await tx.update(s.packagingVersions).set({ validTo: today }).where(eq(s.packagingVersions.id, cur.id))
          const copy: Partial<typeof cur> = { ...cur }
          for (const k of ['id', 'createdAt', 'updatedAt', 'locked', 'validFrom', 'validTo'] as const) delete copy[k]
          await tx.insert(s.packagingVersions).values({ ...(copy as typeof s.packagingVersions.$inferInsert), ...pack, version: cur.version + 1, validFrom: today })
        }
        log.push(`${it.sku}: nova versão v${cur.version + 1} (${diff.join(', ')})`)
      } else {
        if (!dry) await tx.update(s.packagingVersions).set({ ...pack, updatedAt: new Date() }).where(eq(s.packagingVersions.id, cur.id))
        log.push(`${it.sku}: atualizado${diff.length ? ` (${diff.map((k) => `${k} ${cur[k]}→${pack[k]}`).join(', ')})` : ' (observação)'}`)
      }
    }

    // Excluir (desativar) os demais Hidrosilo
    const keep = new Set(PDF.map((p) => p.sku))
    const others = (
      await tx
        .select({ id: s.productVariants.id, sku: s.productVariants.sku, active: s.productVariants.active })
        .from(s.productVariants)
        .innerJoin(s.products, eq(s.products.id, s.productVariants.productId))
        .where(eq(s.products.familyId, fam.id))
    ).filter((x) => !keep.has(x.sku) && x.active)
    if (others.length) {
      if (!dry) await tx.update(s.productVariants).set({ active: false, updatedAt: new Date() }).where(inArray(s.productVariants.id, others.map((o) => o.id)))
      log.push(`SKUs excluídos: ${others.map((o) => o.sku).join(', ')}`)
      // montagens REF desses SKUs
      const refs = (await tx.select().from(s.palletCompositions).where(and(eq(s.palletCompositions.active, true), like(s.palletCompositions.name, 'REF · HS-%')))).filter((c) =>
        others.some((o) => c.name.startsWith(`REF · ${o.sku} · `)),
      )
      if (refs.length) {
        if (!dry) await tx.update(s.palletCompositions).set({ active: false }).where(inArray(s.palletCompositions.id, refs.map((c) => c.id)))
        log.push(`Montagens REF arquivadas: ${refs.map((c) => c.name).join(', ')}`)
      }
    }
    if (!dry) await tx.insert(s.auditLog).values({ entity: 'product_family', entityId: fam.id, action: 'update_hidrosilo_pdf', diff: { source: SOURCE, log } })
  })
  console.log((dry ? '[SIMULAÇÃO]\n' : '') + log.join('\n'))
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
