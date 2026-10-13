import 'server-only'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { asc, gt, sql } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'
import { db, schema as s } from '@/db'
import { BACKUP_KIND, BACKUP_VERSION, backupFileName, type LoadCounts, photoMeta, stripBinaryBlocks, truncateLongStrings } from './backupFormat'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
export type Exec = typeof db | Tx

/** Quantidades das tabelas que "Excluir todas as cargas e proformas" apaga. */
export async function loadCounts(exec: Exec = db): Promise<LoadCounts> {
  const r = await exec.execute<Record<string, string | number>>(sql`
    SELECT
      (SELECT count(*) FROM shipment) AS shipments,
      (SELECT count(*) FROM load_plan) AS load_plans,
      (SELECT count(*) FROM load_plan_version) AS load_plan_versions,
      (SELECT count(*) FROM load_plan_version WHERE status = 'APPROVED') AS approved_versions,
      (SELECT count(*) FROM load_plan_version WHERE status <> 'APPROVED') AS draft_versions,
      (SELECT count(*) FROM load_photo) AS photos,
      (SELECT count(*) FROM price_quote) AS price_quotes,
      (SELECT count(*) FROM export_operation) AS export_operations,
      (SELECT count(*) FROM export_event) AS export_events,
      (SELECT count(*) FROM ai_conversation) AS ai_conversations,
      (SELECT count(*) FROM ai_message) AS ai_messages,
      (SELECT count(*) FROM ai_tool_call) AS ai_tool_calls
  `)
  const x = r.rows[0]
  const n = (k: string) => Number(x[k] ?? 0)
  return {
    shipments: n('shipments'),
    loadPlans: n('load_plans'),
    loadPlanVersions: n('load_plan_versions'),
    approvedVersions: n('approved_versions'),
    draftVersions: n('draft_versions'),
    photos: n('photos'),
    priceQuotes: n('price_quotes'),
    exportOperations: n('export_operations'),
    exportEvents: n('export_events'),
    aiConversations: n('ai_conversations'),
    aiMessages: n('ai_messages'),
    aiToolCalls: n('ai_tool_calls'),
  }
}

/**
 * IMPRESSÃO DIGITAL DO CONTEÚDO das tabelas que a exclusão apaga: as quantidades não mudam com edições no
 * lugar (salvar o rascunho reescreve load_plan_version.document; renomear pedido/carga, frete, seguro,
 * condições de pagamento, agente, enviar para revisão / voltar para rascunho, reemitir proforma, legenda de
 * foto…). Um md5 por linha (o documento inteiro, em JSON), agregados por tabela em ordem de id. Fora:
 * o bloqueio de edição da carga (edit_lock_*: abrir uma carga não exige outro backup) e os bytes das fotos.
 * As mensagens e chamadas de ferramenta da IA só crescem (append-only): quantidade e maior id bastam.
 */
export async function loadContentFingerprint(exec: Exec = db): Promise<string> {
  const r = await exec.execute<{ fp: string }>(sql`
    SELECT md5(concat_ws('#',
      (SELECT coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY t.id), '') FROM shipment t),
      (SELECT coalesce(string_agg(md5((to_jsonb(t) - 'edit_lock_by' - 'edit_lock_at')::text), '' ORDER BY t.id), '') FROM load_plan t),
      (SELECT coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY t.id), '') FROM load_plan_version t),
      (SELECT coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY t.id), '') FROM price_quote t),
      (SELECT coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY t.id), '') FROM export_operation t),
      (SELECT coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY t.id), '') FROM export_event t),
      (SELECT coalesce(string_agg(md5(concat_ws('|', t.id, t.load_plan_id, t.load_plan_version_id, t.mime, t.size_bytes, t.caption, t.taken_at)), '' ORDER BY t.id), '') FROM load_photo t),
      (SELECT coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY t.id), '') FROM ai_conversation t),
      (SELECT count(*) || ':' || coalesce(max(id), 0) FROM ai_message),
      (SELECT count(*) || ':' || coalesce(max(id), 0) FROM ai_tool_call)
    )) AS fp
  `)
  return String(r.rows[0]?.fp ?? '')
}

/** lê uma tabela inteira em lotes pelo id (documentos grandes não ficam todos de uma vez na memória do driver) */
async function readAll<T extends { id: number }, R>(tx: Tx, table: PgTable, idCol: PgColumn, map: (row: T) => R, batch = 200): Promise<R[]> {
  const out: R[] = []
  let last = 0
  for (;;) {
    const rows = (await tx.select().from(table).where(gt(idCol, last)).orderBy(asc(idCol)).limit(batch)) as unknown as T[]
    for (const r of rows) out.push(map(r))
    if (rows.length < batch) break
    last = rows[rows.length - 1].id
  }
  return out
}

export interface LoadsBackup {
  gz: Buffer
  sha256: string
  bytes: number
  counts: LoadCounts
  /** impressão digital do conteúdo (loadContentFingerprint) na mesma leitura do backup */
  fingerprint: string
  fileName: string
}

/**
 * BACKUP de tudo o que a exclusão apaga, em JSON compactado (gzip), numa leitura consistente (uma transação
 * REPEATABLE READ, só leitura): pedidos, cargas, versões (documento, resumo, problemas, preços congelados),
 * fotos (só os dados, sem as imagens), cotações/proformas emitidas, exportações em curso e o histórico
 * delas, conversas do assistente (sem os anexos em base64) e as chamadas de ferramentas (textos longos
 * cortados). Mais os nomes dos cadastros citados (clientes, agentes, transportadoras, usuários).
 */
export async function buildLoadsBackup(user: { id: number; email: string; name: string }, now = new Date()): Promise<LoadsBackup> {
  const data = await db.transaction(
    async (tx) => {
      const counts = await loadCounts(tx)
      const fingerprint = await loadContentFingerprint(tx)
      const id = <T>(r: T) => r
      const tables = {
        shipment: await readAll(tx, s.shipments, s.shipments.id, id),
        load_plan: await readAll(tx, s.loadPlans, s.loadPlans.id, id),
        load_plan_version: await readAll(tx, s.loadPlanVersions, s.loadPlanVersions.id, id, 50),
        // sem data/thumb/medium (bytes): só as colunas de dados
        load_photo: (
          await tx
            .select({
              id: s.loadPhotos.id,
              loadPlanId: s.loadPhotos.loadPlanId,
              loadPlanVersionId: s.loadPhotos.loadPlanVersionId,
              mime: s.loadPhotos.mime,
              width: s.loadPhotos.width,
              height: s.loadPhotos.height,
              sizeBytes: s.loadPhotos.sizeBytes,
              caption: s.loadPhotos.caption,
              takenAt: s.loadPhotos.takenAt,
              createdAt: s.loadPhotos.createdAt,
              createdBy: s.loadPhotos.createdBy,
            })
            .from(s.loadPhotos)
            .orderBy(asc(s.loadPhotos.id))
        ).map(photoMeta),
        price_quote: await readAll(tx, s.priceQuotes, s.priceQuotes.id, id),
        export_operation: await readAll(tx, s.exportOperations, s.exportOperations.id, id),
        export_event: await readAll(tx, s.exportEvents, s.exportEvents.id, id),
        ai_conversation: await readAll(tx, s.aiConversations, s.aiConversations.id, id, 50),
        ai_message: await readAll(tx, s.aiMessages, s.aiMessages.id, (m: typeof s.aiMessages.$inferSelect) => ({ ...m, content: stripBinaryBlocks(m.content) }), 50),
        // só os textos são cortados (a data "at" e os números ficam como estão)
        ai_tool_call: await readAll(tx, s.aiToolCalls, s.aiToolCalls.id, (c: typeof s.aiToolCalls.$inferSelect) => ({ ...c, input: truncateLongStrings(c.input), output: truncateLongStrings(c.output), error: truncateLongStrings(c.error) as string | null }), 100),
      }
      const references = {
        customers: await tx.select({ id: s.customers.id, name: s.customers.name, country: s.customers.country }).from(s.customers).orderBy(asc(s.customers.id)),
        agents: await tx.select({ id: s.agents.id, name: s.agents.name }).from(s.agents).orderBy(asc(s.agents.id)),
        transport_companies: await tx.select({ id: s.transportCompanies.id, code: s.transportCompanies.code, name: s.transportCompanies.name }).from(s.transportCompanies).orderBy(asc(s.transportCompanies.id)),
        users: await tx.select({ id: s.users.id, name: s.users.name, email: s.users.email }).from(s.users).orderBy(asc(s.users.id)),
      }
      return { counts, fingerprint, tables, references }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
  const doc = {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    generatedAt: now.toISOString(),
    generatedBy: { id: user.id, email: user.email, name: user.name },
    counts: data.counts,
    fingerprint: data.fingerprint,
    tables: data.tables,
    references: data.references,
  }
  const gz = gzipSync(Buffer.from(JSON.stringify(doc), 'utf8'), { level: 9 })
  return { gz, sha256: createHash('sha256').update(gz).digest('hex'), bytes: gz.length, counts: data.counts, fingerprint: data.fingerprint, fileName: backupFileName(now) }
}
