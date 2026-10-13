/**
 * Atualiza pesos (líquido/bruto por unidade) e preço de venda FCA da linha Hidrosilo conforme
 * "HYDROSILO – Price List – D0 FCA.pdf" (emitida em 15/09/2026). O PDF está em galões e libras:
 * converte para litros (identifica o SKU) e kg (1 lb = 0,45359237 kg, arredondado a 0,01 kg).
 * Embalagens já usadas em cargas salvas (locked) ganham nova versão; as montagens ativas passam
 * a usar a versão nova com os pesos/preço novos (cargas salvas mantêm seus snapshots).
 * Uso: npx tsx --env-file=.env scripts/update-hidrosilo-precos.ts [--dry]
 */
import { desc, eq } from 'drizzle-orm'
import { db, schema as s } from '../src/db'
import type { PalletDoc } from '../src/domain/types'
import { packSnapshot } from '../src/lib/snapshots'

const SOURCE = 'HYDROSILO – Price List – D0 FCA.pdf (15/09/2026)'
const LB = 0.45359237
const kg = (lb: number) => Math.round(lb * LB * 100) / 100
// galões → SKU; preço FCA USD por unidade; pesos em lb por unidade
const LIST: { gal: number; sku: string; price: number; netLb: number; grossLb: number; upp: number }[] = [
  { gal: 132, sku: 'HS-500L', price: 36, netLb: 7.4, grossLb: 13.36, upp: 60 },
  { gal: 528, sku: 'HS-2K', price: 52, netLb: 14.79, grossLb: 21.45, upp: 60 },
  { gal: 1321, sku: 'HS-5K', price: 78, netLb: 27.12, grossLb: 37.83, upp: 36 },
  { gal: 2642, sku: 'HS-10K', price: 126, netLb: 49.31, grossLb: 61.77, upp: 26 },
  { gal: 3963, sku: 'HS-15K', price: 178, netLb: 73.97, grossLb: 90.72, upp: 16 },
  { gal: 5283, sku: 'HS-20K', price: 231, netLb: 98.63, grossLb: 117.69, upp: 16 },
  { gal: 6604, sku: 'HS-25K', price: 283, netLb: 123.28, grossLb: 147.77, upp: 33 },
  { gal: 7925, sku: 'HS-30K', price: 336, netLb: 147.94, grossLb: 176.5, upp: 21 },
  { gal: 10567, sku: 'HS-40K', price: 441, netLb: 197.25, grossLb: 230.44, upp: 21 },
  { gal: 13209, sku: 'HS-50K', price: 546, netLb: 246.56, grossLb: 285.7, upp: 18 },
]

async function main() {
  const dry = process.argv.includes('--dry')
  const log: string[] = []
  const today = new Date().toISOString().slice(0, 10)
  /** pv antigo → pv novo (quando foi preciso versionar) */
  const remap = new Map<number, number>()
  const touchedVariants = new Set<number>()

  await db.transaction(async (tx) => {
    for (const it of LIST) {
      const v = await tx.query.productVariants.findFirst({ where: eq(s.productVariants.sku, it.sku) })
      if (!v) {
        log.push(`${it.sku}: SKU não encontrado — ignorado`)
        continue
      }
      touchedVariants.add(v.id)
      const netKg = kg(it.netLb), grossKg = kg(it.grossLb)
      if (v.price !== it.price || v.priceCurrency !== 'USD' || v.priceUnit !== 'UNIT') {
        log.push(`${it.sku}: preço ${v.price ?? '—'} ${v.priceCurrency} → ${it.price} USD/un.`)
        if (!dry) await tx.update(s.productVariants).set({ price: it.price, priceCurrency: 'USD', priceUnit: 'UNIT', priceUpdatedAt: new Date(), updatedAt: new Date() }).where(eq(s.productVariants.id, v.id))
      }
      const [cur] = await tx.select().from(s.packagingVersions).where(eq(s.packagingVersions.variantId, v.id)).orderBy(desc(s.packagingVersions.version)).limit(1)
      if (!cur) {
        log.push(`${it.sku}: sem embalagem cadastrada — pesos não aplicados`)
        continue
      }
      if (cur.unitsPerPallet !== it.upp) log.push(`${it.sku}: ⚠ un./palete no cadastro ${cur.unitsPerPallet} × lista ${it.upp} (não alterado)`)
      if (cur.netKg === netKg && cur.grossKg === grossKg) {
        log.push(`${it.sku}: pesos já conformes (${netKg} / ${grossKg} kg)`)
        continue
      }
      const notes = `${cur.notes ? cur.notes.replace(/ ?Peso líquido não informado no PDF\./, '') + ' ' : ''}Pesos: ${SOURCE} (${it.netLb} / ${it.grossLb} lb).`
      const change = `líquido ${cur.netKg} → ${netKg} kg, bruto ${cur.grossKg} → ${grossKg} kg`
      if (cur.locked) {
        if (!dry) {
          await tx.update(s.packagingVersions).set({ validTo: today }).where(eq(s.packagingVersions.id, cur.id))
          const copy: Partial<typeof cur> = { ...cur }
          for (const k of ['id', 'createdAt', 'updatedAt', 'locked', 'validFrom', 'validTo'] as const) delete copy[k]
          const [nv] = await tx
            .insert(s.packagingVersions)
            .values({ ...(copy as typeof s.packagingVersions.$inferInsert), netKg, grossKg, notes, version: cur.version + 1, validFrom: today })
            .returning()
          remap.set(cur.id, nv.id)
        }
        log.push(`${it.sku}: nova versão v${cur.version + 1} (v${cur.version} já usada em carga salva) — ${change}`)
      } else {
        if (!dry) await tx.update(s.packagingVersions).set({ netKg, grossKg, notes, updatedAt: new Date() }).where(eq(s.packagingVersions.id, cur.id))
        log.push(`${it.sku}: ${change}`)
      }
    }

    // Montagens ativas: troca os snapshots das embalagens Hidrosilo pelos dados novos (peso + preço)
    if (!dry) {
      const latest = new Map<number, { pv: typeof s.packagingVersions.$inferSelect; v: typeof s.productVariants.$inferSelect }>()
      for (const vid of touchedVariants) {
        const v = (await tx.query.productVariants.findFirst({ where: eq(s.productVariants.id, vid) }))!
        const [pv] = await tx.select().from(s.packagingVersions).where(eq(s.packagingVersions.variantId, vid)).orderBy(desc(s.packagingVersions.version)).limit(1)
        if (pv) latest.set(vid, { pv, v })
      }
      const byPv = new Map<number, (typeof latest extends Map<number, infer X> ? X : never)>()
      for (const x of latest.values()) byPv.set(x.pv.id, x)
      for (const [oldId, newId] of remap) byPv.set(oldId, byPv.get(newId)!)
      let updated = 0
      for (const c of await tx.select().from(s.palletCompositions).where(eq(s.palletCompositions.active, true))) {
        const doc = c.document as PalletDoc
        let changed = false
        const packs: PalletDoc['packs'] = {}
        const rename = new Map<string, string>()
        for (const [key, p] of Object.entries(doc.packs)) {
          const x = byPv.get(p.packagingVersionId)
          if (!x) {
            packs[key] = p
            continue
          }
          const nk = `pv${x.pv.id}`
          packs[nk] = packSnapshot(x.pv, x.v)
          if (nk !== key) rename.set(key, nk)
          changed = true
        }
        if (!changed) continue
        const items = doc.items.map((i) => (rename.has(i.packId) ? { ...i, packId: rename.get(i.packId)! } : i))
        await tx.update(s.palletCompositions).set({ document: { ...doc, packs, items }, updatedAt: c.updatedAt }).where(eq(s.palletCompositions.id, c.id))
        updated++
      }
      log.push(`Montagens atualizadas com os pesos/preços novos: ${updated}`)
      await tx.insert(s.auditLog).values({ entity: 'product_family', entityId: 0, action: 'update_hidrosilo_price_list', diff: { source: SOURCE, log } })
    }
  })
  console.log((dry ? '[SIMULAÇÃO]\n' : '') + log.join('\n'))
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
