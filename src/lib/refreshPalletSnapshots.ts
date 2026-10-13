// Sem 'server-only': usado também pelo script de linha de comando.
import { and, eq, inArray } from 'drizzle-orm'
import { db, schema as s } from '@/db'
import { palletTypeSnapshot } from './snapshots'

const sorted = (v: unknown) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x))

/**
 * Atualiza a cópia (snapshot) do tipo de palete dentro das MONTAGENS ativas (modelos).
 * Cargas já salvas NÃO são alteradas: guardam o snapshot da época.
 * Montagens REF não editadas continuam reconhecidas como não editadas (updated_at = created_at).
 */
export async function refreshPalletSnapshots(palletTypeIds?: number[]): Promise<{ updated: number }> {
  const types = await db.select().from(s.palletTypes)
  const byId = new Map(types.map((t) => [t.id, t]))
  const comps = await db
    .select()
    .from(s.palletCompositions)
    .where(palletTypeIds?.length ? and(eq(s.palletCompositions.active, true), inArray(s.palletCompositions.palletTypeId, palletTypeIds)) : eq(s.palletCompositions.active, true))
  let updated = 0
  for (const c of comps) {
    const t = byId.get(c.palletTypeId)
    if (!t) continue
    const snap = palletTypeSnapshot(t)
    // compara com chaves ordenadas (o jsonb do banco reordena as chaves)
    if (sorted(snap) === sorted(c.document.palletType)) continue
    const unedited = Math.abs(c.updatedAt.getTime() - c.createdAt.getTime()) < 1000
    await db
      .update(s.palletCompositions)
      .set({ document: { ...c.document, palletType: snap }, ...(unedited ? { updatedAt: c.createdAt } : { updatedAt: new Date() }) })
      .where(eq(s.palletCompositions.id, c.id))
    updated++
  }
  return { updated }
}
