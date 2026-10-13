/**
 * Libera todas as orientações (política "Livre") nas embalagens vigentes que ainda estão no padrão
 * antigo "só em pé". Versões já usadas em cargas salvas ganham NOVA versão (histórico preservado);
 * as demais são atualizadas. Só SKUs listados (ou todos os ativos com --all).
 * Uso: npx tsx --env-file=.env scripts/free-orientations.ts SKU1,SKU2,… | --all  [--dry]
 */
import { eq } from 'drizzle-orm'
import { db, schema as s } from '../src/db'
import { ORIENTATIONS } from '../src/domain/geometry'
import { syncCompositionsWithCatalog } from '../src/lib/refreshCompositions'

async function main() {
  const dry = process.argv.includes('--dry')
  const all = process.argv.includes('--all')
  const list = new Set((process.argv[2] ?? '').split(',').map((x) => x.trim().toUpperCase()).filter((x) => x && !x.startsWith('--')))
  const rows = await db.select({ pv: s.packagingVersions, v: s.productVariants }).from(s.packagingVersions).innerJoin(s.productVariants, eq(s.productVariants.id, s.packagingVersions.variantId))
  const latest = new Map<number, (typeof rows)[number]>()
  for (const r of rows) if (!latest.get(r.v.id) || r.pv.version > latest.get(r.v.id)!.pv.version) latest.set(r.v.id, r)
  const today = new Date().toISOString().slice(0, 10)
  const done: string[] = []
  for (const { pv, v } of latest.values()) {
    if (!v.active || (!all && !list.has(v.sku.toUpperCase()))) continue
    const a = pv.allowedOrientations
    if (!(a.length === 2 && a.includes('LWH') && a.includes('WLH'))) continue
    if (!dry) {
      if (pv.locked) {
        await db.update(s.packagingVersions).set({ validTo: today }).where(eq(s.packagingVersions.id, pv.id))
        const copy: Partial<typeof pv> = { ...pv }
        for (const k of ['id', 'createdAt', 'updatedAt', 'locked', 'validFrom', 'validTo'] as const) delete copy[k]
        await db.insert(s.packagingVersions).values({ ...(copy as typeof s.packagingVersions.$inferInsert), allowedOrientations: [...ORIENTATIONS], version: pv.version + 1, validFrom: today })
      } else await db.update(s.packagingVersions).set({ allowedOrientations: [...ORIENTATIONS], updatedAt: new Date() }).where(eq(s.packagingVersions.id, pv.id))
    }
    done.push(`${v.sku}${pv.locked ? ` → v${pv.version + 1}` : ''}`)
  }
  if (!dry && done.length) {
    await db.insert(s.auditLog).values({ entity: 'packaging_version', entityId: null, action: 'free_orientations', diff: { skus: done } })
    await syncCompositionsWithCatalog(null)
  }
  console.log(`${dry ? '[SIMULAÇÃO] ' : ''}${done.length} embalagem(ns) com orientação livre: ${done.join(', ')}`)
  process.exit(0)
}
main()
