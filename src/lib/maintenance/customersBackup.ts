import 'server-only'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm'
import { db, schema as s } from '@/db'
import { CUSTOMERS_BACKUP_KIND, CUSTOMERS_BACKUP_VERSION, type CustomerCounts, sameCustomerCounts } from '@/domain/customerImport'
import { BACKUP_VALID_MINUTES, backupFileName } from './backupFormat'
import { MaintenanceError } from './deleteAllLoads'
import type { Exec } from './loadsBackup'

/** ação da auditoria que registra o backup dos clientes (o sha256 é conferido antes de aplicar a planilha) */
export const CUSTOMERS_BACKUP_ACTION = 'backup_customers'

/** Quantidades da tabela de clientes. */
export async function customerCounts(exec: Exec = db): Promise<CustomerCounts> {
  const r = await exec.execute<Record<string, string | number>>(sql`
    SELECT
      count(*) AS customers,
      count(*) FILTER (WHERE code IS NOT NULL) AS with_code,
      count(*) FILTER (WHERE agent_id IS NOT NULL) AS with_agent,
      count(*) FILTER (WHERE NOT active) AS inactive
    FROM customer
  `)
  const x = r.rows[0] ?? {}
  const n = (k: string) => Number(x[k] ?? 0)
  return { customers: n('customers'), withCode: n('with_code'), withAgent: n('with_agent'), inactive: n('inactive') }
}

/**
 * IMPRESSÃO DIGITAL dos clientes: um md5 por linha (a linha inteira em JSON, inclusive updated_at),
 * agregados em ordem de id. Qualquer edição, criação (ex.: "— novo cliente —" em Nova carga) ou exclusão
 * depois do backup muda o valor.
 */
export async function customerFingerprint(exec: Exec = db): Promise<string> {
  const r = await exec.execute<{ fp: string }>(sql`
    SELECT md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY t.id), '')) AS fp FROM customer t
  `)
  return String(r.rows[0]?.fp ?? '')
}

/** "backup-clientes-AAAA-MM-DDTHH-MM.json.gz" na hora de Brasília (mesmo carimbo do backup das cargas) */
export const customersBackupFileName = (date: Date) => backupFileName(date).replace(/^backup-cargas-/, 'backup-clientes-')

export interface CustomersBackup {
  gz: Buffer
  sha256: string
  bytes: number
  counts: CustomerCounts
  fingerprint: string
  fileName: string
}

/**
 * BACKUP dos clientes atuais em JSON compactado (gzip), numa leitura consistente (REPEATABLE READ, só
 * leitura): as linhas COMPLETAS da tabela customer (código, endereço, ID fiscal, contato — nome, e-mail e
 * telefone —, agente, ativo, observações, datas e autores; colunas novas entram sozinhas: select() sem lista) + os agentes citados (id, nome, país, ativo) e os usuários (id, nome) dos autores.
 */
export async function buildCustomersBackup(user: { id: number; email: string; name: string }, now = new Date()): Promise<CustomersBackup> {
  const data = await db.transaction(
    async (tx) => {
      const counts = await customerCounts(tx)
      const fingerprint = await customerFingerprint(tx)
      const customer = await tx.select().from(s.customers).orderBy(asc(s.customers.id))
      const agents = await tx.select({ id: s.agents.id, name: s.agents.name, country: s.agents.country, active: s.agents.active }).from(s.agents).orderBy(asc(s.agents.id))
      const users = await tx.select({ id: s.users.id, name: s.users.name }).from(s.users).orderBy(asc(s.users.id))
      return { counts, fingerprint, tables: { customer }, references: { agents, users } }
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
  const doc = {
    kind: CUSTOMERS_BACKUP_KIND,
    version: CUSTOMERS_BACKUP_VERSION,
    generatedAt: now.toISOString(),
    generatedBy: { id: user.id, email: user.email, name: user.name },
    counts: data.counts,
    fingerprint: data.fingerprint,
    tables: data.tables,
    references: data.references,
  }
  const gz = gzipSync(Buffer.from(JSON.stringify(doc), 'utf8'), { level: 9 })
  return { gz, sha256: createHash('sha256').update(gz).digest('hex'), bytes: gz.length, counts: data.counts, fingerprint: data.fingerprint, fileName: customersBackupFileName(now) }
}

/**
 * Exige um backup dos clientes baixado por ESTE usuário nos últimos 60 min, com este sha256, e nada alterado
 * na tabela depois dele (mesmas quantidades e mesma impressão digital). Chamar DENTRO da transação, depois do
 * LOCK TABLE. Devolve as quantidades de agora.
 */
export async function assertCustomersBackup(tx: Exec, userId: number, backupSha256: string): Promise<CustomerCounts> {
  const counts = await customerCounts(tx)
  const [backup] = await tx
    .select({ diff: s.auditLog.diff })
    .from(s.auditLog)
    .where(
      and(
        eq(s.auditLog.entity, 'maintenance'),
        eq(s.auditLog.action, CUSTOMERS_BACKUP_ACTION),
        eq(s.auditLog.userId, userId),
        gt(s.auditLog.at, sql`now() - make_interval(mins => ${BACKUP_VALID_MINUTES})`),
        sql`${s.auditLog.diff}->>'sha256' = ${backupSha256}`,
      ),
    )
    .orderBy(desc(s.auditLog.at))
    .limit(1)
  if (!backup) throw new MaintenanceError(`Backup dos clientes não encontrado: baixe o backup com este usuário e aplique em até ${BACKUP_VALID_MINUTES} minutos.`)
  const diff = backup.diff as { counts?: Partial<CustomerCounts>; fingerprint?: string } | null
  const changed = !sameCustomerCounts(diff?.counts, counts) || !diff?.fingerprint || diff.fingerprint !== (await customerFingerprint(tx))
  if (changed) throw new MaintenanceError('Houve alterações nos clientes desde o backup. Baixe o backup de novo.')
  return counts
}
