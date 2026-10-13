/**
 * Cadastra a linha HYDROFORCE (lista "LISTA DE PRECIOS HIDROFORCE D0 FCA 2026.pdf", 15/09/2026) e o
 * KIT HYDROFORCE (acompanhante obrigatório: 1 por Hydroforce).
 *  - HF-2K/5K/10K: mesma caixa, pesos, caixas/palete, palete e orientações do Hidrosilo equivalente;
 *    muda só o preço (válvulas). Regra no cadastro: acessorio_sku = KIT-HF, acessorio_qtd = 1.
 *  - KIT-HF: mangueira + camlock + torneira, caixa 200 × 200 × 200 mm, 2 kg; preço incluído no Hydroforce.
 *    Viaja SEMPRE por cima de um palete com Hydroforce (regra em domain/companions).
 * Idempotente (pode rodar de novo). Uso: npx tsx --env-file=.env scripts/add-hydroforce.ts [--dry]
 */
import { desc, eq } from 'drizzle-orm'
import { db, schema as s } from '../src/db'
import { ORIENTATIONS } from '../src/domain/geometry'
import { syncCompositionsWithCatalog } from '../src/lib/refreshCompositions'

const SOURCE = 'LISTA DE PRECIOS HIDROFORCE D0 FCA 2026.pdf (15/09/2026)'
const HF = [
  { sku: 'HF-2K', base: 'HS-2K', litros: 2000, price: 77, largura: 2, comprimento: 3 },
  { sku: 'HF-5K', base: 'HS-5K', litros: 5000, price: 115, largura: 2, comprimento: 5.5 },
  { sku: 'HF-10K', base: 'HS-10K', litros: 10000, price: 186, largura: 2, comprimento: 10 },
]
const KIT = { sku: 'KIT-HF', name: 'Kit Hydroforce (mangueira + camlock + torneira)', l: 200, w: 200, h: 200, kg: 2 }

async function main() {
  const dry = process.argv.includes('--dry')
  const log: string[] = []
  const today = new Date().toISOString().slice(0, 10)
  const famHF = await db.query.productFamilies.findFirst({ where: eq(s.productFamilies.code, 'HYDROFORCE') })
  const famAcc = await db.query.productFamilies.findFirst({ where: eq(s.productFamilies.code, 'ACCESSORY') })
  if (!famHF || !famAcc) throw new Error('Famílias HYDROFORCE / ACCESSORY não encontradas')

  const lineOf = async (familyId: number, name: string) => {
    const cur = (await db.select().from(s.products).where(eq(s.products.familyId, familyId))).find((p) => p.name === name)
    if (cur) return cur.id
    if (dry) return -1
    const [p] = await db.insert(s.products).values({ familyId, name }).returning()
    log.push(`linha criada: ${name}`)
    return p.id
  }

  const upsert = async (v: { sku: string; name: string; productId: number; attrs: Record<string, string | number | null>; widthM?: number | null; lengthM?: number | null; thicknessUm?: number | null; price: number; notes: string }, pack: Omit<typeof s.packagingVersions.$inferInsert, 'variantId' | 'version' | 'validFrom'>) => {
    let cur = await db.query.productVariants.findFirst({ where: eq(s.productVariants.sku, v.sku) })
    if (!cur) {
      if (!dry) [cur] = await db.insert(s.productVariants).values({ ...v, brand: 'Pacifil', priceCurrency: 'USD', priceUnit: 'UNIT', priceUpdatedAt: new Date() }).returning()
      log.push(`criado ${v.sku} — ${v.name} · USD ${v.price}`)
    } else {
      if (!dry) await db.update(s.productVariants).set({ ...v, active: true, updatedAt: new Date(), ...(cur.price !== v.price ? { priceUpdatedAt: new Date() } : {}) }).where(eq(s.productVariants.id, cur.id))
      log.push(`atualizado ${v.sku}`)
    }
    if (!cur) return
    const [pv] = await db.select().from(s.packagingVersions).where(eq(s.packagingVersions.variantId, cur.id)).orderBy(desc(s.packagingVersions.version)).limit(1)
    if (!pv) {
      if (!dry) await db.insert(s.packagingVersions).values({ ...pack, variantId: cur.id, version: 1, validFrom: today })
      log.push(`  embalagem v1: ${pack.lengthMm}×${pack.widthMm}×${pack.heightMm} mm · ${pack.grossKg} kg`)
    } else {
      const changed = (['lengthMm', 'widthMm', 'heightMm', 'netKg', 'grossKg', 'unitsPerPallet', 'palletTypeId'] as const).some((k) => pv[k] !== (pack[k] ?? null))
      if (!changed) return
      if (pv.locked) {
        // já usada em carga salva: nova versão (histórico preservado)
        if (!dry) {
          await db.update(s.packagingVersions).set({ validTo: today }).where(eq(s.packagingVersions.id, pv.id))
          await db.insert(s.packagingVersions).values({ ...pack, variantId: cur.id, version: pv.version + 1, validFrom: today })
        }
        log.push(`  embalagem v${pv.version + 1}: ${pack.lengthMm}×${pack.widthMm}×${pack.heightMm} mm (v${pv.version} usada em carga)`)
      } else {
        if (!dry) await db.update(s.packagingVersions).set({ ...pack, updatedAt: new Date() }).where(eq(s.packagingVersions.id, pv.id))
        log.push(`  embalagem atualizada: ${pack.lengthMm}×${pack.widthMm}×${pack.heightMm} mm`)
      }
    }
  }

  // Kit
  const kitLine = await lineOf(famAcc.id, 'Kit Hydroforce')
  await upsert(
    { sku: KIT.sku, name: KIT.name, productId: kitLine, attrs: {}, price: 0, notes: 'Acompanha cada Hydroforce (1 por unidade); preço incluído no Hydroforce. Vai em caixa separada.' },
    { packageType: 'Caixa', lengthMm: KIT.l, widthMm: KIT.w, heightMm: KIT.h, netKg: KIT.kg, grossKg: KIT.kg, unitsPerPackage: 1, unitsPerPallet: null, palletTypeId: null, allowedOrientations: [...ORIENTATIONS], verification: 'ESTIMATED', notes: 'Peso informado: 2 kg (total).' },
  )
  // Hydroforce
  const hfLine = await lineOf(famHF.id, 'Hydroforce')
  for (const h of HF) {
    const baseV = await db.query.productVariants.findFirst({ where: eq(s.productVariants.sku, h.base) })
    if (!baseV) throw new Error(`Base ${h.base} não encontrada`)
    const [bp] = await db.select().from(s.packagingVersions).where(eq(s.packagingVersions.variantId, baseV.id)).orderBy(desc(s.packagingVersions.version)).limit(1)
    await upsert(
      {
        sku: h.sku,
        name: `Hydroforce ${h.litros.toLocaleString('pt-BR')} L`,
        productId: hfLine,
        attrs: { ...baseV.attrs, capacidade_l: h.litros, acessorio_sku: KIT.sku, acessorio_qtd: 1 },
        thicknessUm: baseV.thicknessUm,
        widthM: h.largura,
        lengthM: h.comprimento,
        price: h.price,
        notes: `Fonte: ${SOURCE}. Igual ao ${h.base} (caixa, pesos, paletização); muda a válvula. Acompanha 1 ${KIT.sku} por unidade.`,
      },
      {
        packageType: bp.packageType,
        lengthMm: bp.lengthMm,
        widthMm: bp.widthMm,
        heightMm: bp.heightMm,
        netKg: bp.netKg,
        grossKg: bp.grossKg,
        unitsPerPackage: bp.unitsPerPackage,
        unitsPerPallet: bp.unitsPerPallet,
        palletTypeId: bp.palletTypeId,
        allowedOrientations: bp.allowedOrientations,
        stackable: bp.stackable,
        verification: bp.verification,
        notes: `Copiado de ${h.base} v${bp.version}.`,
      },
    )
  }
  if (!dry) {
    await db.insert(s.auditLog).values({ entity: 'product_family', entityId: famHF.id, action: 'add_hydroforce', diff: { source: SOURCE, log } })
    await syncCompositionsWithCatalog(null)
  }
  console.log((dry ? '[SIMULAÇÃO]\n' : '') + log.join('\n'))
  process.exit(0)
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
