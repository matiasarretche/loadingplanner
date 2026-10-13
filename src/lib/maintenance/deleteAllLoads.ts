import 'server-only'
import { and, desc, eq, gt, sql } from 'drizzle-orm'
import { db, schema as s } from '@/db'
import { BACKUP_VALID_MINUTES, type LoadCounts, sameCounts } from './backupFormat'
import { loadContentFingerprint, loadCounts } from './loadsBackup'

/** Erro com mensagem pronta para o usuário (pt-BR). */
export class MaintenanceError extends Error {}

/** sentinela para desfazer a transação da simulação levando as quantidades */
class Rollback extends Error {
  constructor(readonly counts: LoadCounts) {
    super('rollback')
  }
}

/**
 * EXCLUI TODAS AS CARGAS E PROFORMAS, numa transação só:
 *  - trava as tabelas apagadas (ninguém cria/edita carga enquanto isso);
 *  - exige um backup baixado por ESTE usuário nos últimos 60 min, com o mesmo sha256, as mesmas
 *    quantidades e a mesma impressão digital do conteúdo de agora (loadContentFingerprint: pega também as
 *    edições no lugar, como salvar um rascunho) — se algo mudou depois do backup, é preciso baixar de novo;
 *  - apaga, na ordem das chaves estrangeiras: chamadas/mensagens/conversas do assistente (todas: cada
 *    conversa pertence a uma versão de carga), histórico e operações de exportação, fotos, cotações/
 *    proformas emitidas, versões, cargas e pedidos.
 * Ficam: clientes, agentes, usuários, preços, catálogo, montagens de palete, transportadoras, veículos,
 * configurações, auditoria e importações do catálogo. Os contadores de id não voltam a 1.
 * `dryRun` (testes no banco local): faz tudo e desfaz no fim.
 */
export async function deleteAllLoads(userId: number, backupSha256: string, o: { dryRun?: boolean } = {}): Promise<LoadCounts> {
  try {
    return await deleteInTransaction(userId, backupSha256, Boolean(o.dryRun))
  } catch (e) {
    if (e instanceof Rollback) return e.counts
    throw e
  }
}

function deleteInTransaction(userId: number, backupSha256: string, dryRun: boolean): Promise<LoadCounts> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`LOCK TABLE shipment, load_plan, load_plan_version, price_quote, export_operation, export_event, load_photo, ai_conversation, ai_message, ai_tool_call IN SHARE ROW EXCLUSIVE MODE`,
    )
    const counts = await loadCounts(tx)
    const [backup] = await tx
      .select({ diff: s.auditLog.diff, at: s.auditLog.at })
      .from(s.auditLog)
      .where(
        and(
          eq(s.auditLog.entity, 'maintenance'),
          eq(s.auditLog.action, 'backup_loads'),
          eq(s.auditLog.userId, userId),
          gt(s.auditLog.at, sql`now() - make_interval(mins => ${BACKUP_VALID_MINUTES})`),
          sql`${s.auditLog.diff}->>'sha256' = ${backupSha256}`,
        ),
      )
      .orderBy(desc(s.auditLog.at))
      .limit(1)
    if (!backup) throw new MaintenanceError(`Backup não encontrado: baixe o backup (passo 1) com este usuário e exclua em até ${BACKUP_VALID_MINUTES} minutos.`)
    const diff = backup.diff as { counts?: Partial<LoadCounts>; fingerprint?: string } | null
    // backup sem impressão digital (versão anterior) também conta como desatualizado
    const changed = !sameCounts(diff?.counts, counts) || !diff?.fingerprint || diff.fingerprint !== (await loadContentFingerprint(tx))
    if (changed) throw new MaintenanceError('Houve alterações nas cargas desde o backup. Baixe o backup de novo.')

    await tx.delete(s.aiToolCalls)
    await tx.delete(s.aiMessages)
    await tx.delete(s.aiConversations)
    await tx.delete(s.exportEvents)
    await tx.delete(s.exportOperations)
    await tx.delete(s.loadPhotos)
    await tx.delete(s.priceQuotes)
    await tx.delete(s.loadPlanVersions)
    await tx.delete(s.loadPlans)
    await tx.delete(s.shipments)

    await tx.insert(s.auditLog).values({ entity: 'maintenance', entityId: null, action: 'delete_all_loads', userId, diff: { counts, backupSha256 } })
    if (dryRun) throw new Rollback(counts)
    return counts
  })
}
