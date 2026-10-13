/**
 * Mantém só os 3 tipos de palete padrão (1,00×1,20 · 1,15×1,15 · 1,10×1,30) e exclui os demais.
 * - Embalagens que usavam um palete excluído ficam sem palete padrão (com observação).
 * - Montagens REF (geradas automaticamente) nesses paletes são excluídas (podem ser regeneradas).
 * - Montagens manuais são movidas para o palete padrão de medida mais próxima.
 * Uso: npx tsx --env-file=.env scripts/cleanup-pallets.ts [--dry]
 */
import { eq, inArray, notInArray } from 'drizzle-orm'
import { db, schema as s } from '../src/db'
import { palletTypeSnapshot } from '../src/lib/snapshots'

const KEEP: Record<string, string> = {
  'PBR-1': 'PBR 1,00 × 1,20',
  'PCF-1150': 'Pallet exportação 1,15 × 1,15',
  'PCF-1100x1300': 'Pallet exportação 1,10 × 1,30',
}

async function main() {
  const dry = process.argv.includes('--dry')
  const all = await db.select().from(s.palletTypes)
  const keep = all.filter((p) => p.code in KEEP)
  const drop = all.filter((p) => !(p.code in KEEP))
  if (keep.length !== 3) throw new Error(`Esperava 3 paletes padrão, encontrei ${keep.map((p) => p.code).join(', ')}`)
  const dropIds = drop.map((p) => p.id)
  console.log(`Manter: ${keep.map((p) => p.code).join(', ')}\nExcluir: ${drop.map((p) => p.code).join(', ') || '—'}`)
  if (!dropIds.length) return

  const closest = (l: number, w: number) =>
    keep.reduce((a, b) => (Math.abs(b.lengthMm - l) + Math.abs(b.widthMm - w) < Math.abs(a.lengthMm - l) + Math.abs(a.widthMm - w) ? b : a))

  const packs = await db.select().from(s.packagingVersions).where(inArray(s.packagingVersions.palletTypeId, dropIds))
  const comps = await db.select().from(s.palletCompositions).where(inArray(s.palletCompositions.palletTypeId, dropIds))
  const refs = comps.filter((c) => c.name.startsWith('REF · '))
  const manual = comps.filter((c) => !c.name.startsWith('REF · '))
  console.log(`Embalagens sem palete padrão: ${packs.length} · montagens REF excluídas: ${refs.length} · montagens manuais movidas: ${manual.length}`)
  if (dry) return

  await db.transaction(async (tx) => {
    for (const p of packs) {
      const old = drop.find((d) => d.id === p.palletTypeId)!
      const note = `Palete padrão ${old.code} (${old.lengthMm}×${old.widthMm}) foi excluído: só existem 1,00×1,20, 1,15×1,15 e 1,10×1,30. Definir o palete.`
      // ajuste de cadastro (não muda medidas/pesos): edita a versão mesmo se bloqueada
      await tx.update(s.packagingVersions).set({ palletTypeId: null, notes: [p.notes, note].filter(Boolean).join('\n') }).where(eq(s.packagingVersions.id, p.id))
    }
    if (refs.length) await tx.delete(s.palletCompositions).where(inArray(s.palletCompositions.id, refs.map((c) => c.id)))
    for (const c of manual) {
      const target = closest(c.document.palletType.dims.l, c.document.palletType.dims.w)
      await tx
        .update(s.palletCompositions)
        .set({ palletTypeId: target.id, document: { ...c.document, palletType: palletTypeSnapshot(target) } })
        .where(eq(s.palletCompositions.id, c.id))
      console.log(`  montagem "${c.name}": ${c.document.palletType.code} → ${target.code}`)
    }
    await tx.delete(s.palletTypes).where(notInArray(s.palletTypes.id, keep.map((p) => p.id)))
    for (const p of keep) await tx.update(s.palletTypes).set({ name: KEEP[p.code] }).where(eq(s.palletTypes.id, p.id))
    await tx.insert(s.auditLog).values({ entity: 'pallet_type', action: 'cleanup_keep_3', diff: { excluidos: drop.map((d) => d.code), embalagens: packs.length, refs: refs.length, movidas: manual.length } })
  })
  console.log('Concluído.')
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
