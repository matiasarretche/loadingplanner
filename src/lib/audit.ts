import 'server-only'
import { db, schema } from '@/db'

export async function logAudit(entity: string, entityId: number | null, action: string, userId: number, diff?: unknown) {
  await db.insert(schema.auditLog).values({ entity, entityId, action, userId, diff: diff ?? null })
}

/** Diferenças campo a campo entre dois registros (para o changelog/auditoria). */
export function diffRecords(before: Record<string, unknown> | undefined, after: Record<string, unknown>) {
  const d: Record<string, { de: unknown; para: unknown }> = {}
  for (const [k, v] of Object.entries(after)) {
    const old = before?.[k]
    if (JSON.stringify(old) !== JSON.stringify(v)) d[k] = { de: old ?? null, para: v }
  }
  return d
}
