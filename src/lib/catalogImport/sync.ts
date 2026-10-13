// Sem 'server-only': segue o padrão de refreshCompositions/referencePallets (também usados por scripts).
import { and, eq, inArray, lt, or, sql } from 'drizzle-orm'
import { db, schema as s } from '@/db'
import type { SyncReport } from '@/domain/catalogImport/types'
import { generateReferencePallets } from '@/lib/referencePallets'
import { refreshCompositions } from '@/lib/refreshCompositions'

/** linhas do relatório guardadas na importação */
const MAX_LINES = 300
/** uma atualização "presa" (função encerrada no meio) pode ser refeita depois disso (a função dura no máx. 300 s) */
const STALE_MINUTES = 6

/**
 * Depois de APLICAR a importação: atualiza as MONTAGENS DE PALETE com o catálogo novo (as de referência dos
 * SKUs desativados são arquivadas; as dos novos são geradas). Fora da transação da importação (pode levar
 * mais tempo); se falhar, a importação continua aplicada e o botão "Atualizar de novo" repete.
 * Só uma execução por vez: o status passa a SYNCING de forma atômica. Devolve null se já está rodando ou
 * se a importação não está aplicada. Erro: grava SYNC_FAILED e relança.
 */
export async function syncCatalogImportCompositions(id: number, userId: number): Promise<SyncReport | null> {
  const [claimed] = await db
    .update(s.catalogImports)
    .set({ status: 'SYNCING', error: null, syncedAt: new Date() })
    .where(
      and(
        eq(s.catalogImports.id, id),
        or(
          inArray(s.catalogImports.status, ['APPLIED', 'SYNC_FAILED']),
          and(eq(s.catalogImports.status, 'SYNCING'), lt(s.catalogImports.syncedAt, sql`now() - make_interval(mins => ${STALE_MINUTES})`)),
        ),
      ),
    )
    .returning({ id: s.catalogImports.id })
  if (!claimed) return null
  const t0 = Date.now()
  try {
    const r = await refreshCompositions()
    const g = await generateReferencePallets(userId)
    // mesma auditoria de syncCompositionsWithCatalog (edições do catálogo)
    if (r.updated || r.regenerated || r.archived || g.created) {
      await db.insert(s.auditLog).values({
        entity: 'pallet_composition',
        entityId: null,
        action: 'sync_catalog',
        userId,
        diff: { atualizadas: r.updated, recalculadas: r.regenerated, arquivadas: r.archived, revisar: r.review, criadas: g.created, log: [...r.lines, ...g.lines], importacao: id },
      })
    }
    const all = [...r.lines, ...g.lines]
    const report: SyncReport = {
      updated: r.updated,
      regenerated: r.regenerated,
      archived: r.archived,
      review: r.review,
      created: g.created,
      lines: all.length > MAX_LINES ? [...all.slice(0, MAX_LINES - 1), `… e mais ${all.length - MAX_LINES + 1} linha(s) (ver a auditoria)`] : all,
      durationMs: Date.now() - t0,
    }
    await db.update(s.catalogImports).set({ status: 'SYNCED', syncReport: report, syncedAt: new Date(), error: null }).where(eq(s.catalogImports.id, id))
    return report
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await db
      .update(s.catalogImports)
      .set({ status: 'SYNC_FAILED', error: `Falha ao atualizar as montagens de palete: ${msg}`.slice(0, 2000), syncedAt: new Date() })
      .where(eq(s.catalogImports.id, id))
    throw e
  }
}
