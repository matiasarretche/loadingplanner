import { desc, eq, sql } from 'drizzle-orm'
import { db, schema } from '@/db'
import { requireUser } from '@/lib/auth'
import { transportCompanyCounts } from '@/lib/maintenance/carrierImport'
import { customerCounts } from '@/lib/maintenance/customersBackup'
import { loadCounts } from '@/lib/maintenance/loadsBackup'
import { CarrierImportCard } from './CarrierImportCard'
import { CatalogUploadCard, type RecentImport } from './CatalogUploadCard'
import { CustomerImportCard } from './CustomerImportCard'
import { DeleteLoadsCard } from './DeleteLoadsCard'
import css from './manutencao.module.css'

/** as ações desta página (excluir todas as cargas) podem levar mais que o padrão */
export const maxDuration = 300

/**
 * MANUTENÇÃO (só o administrador principal): importação do catálogo oficial pelas planilhas, exclusão de
 * todas as cargas e proformas e substituição/atualização dos clientes de exportação pela planilha do ERP
 * (as duas últimas com backup obrigatório antes) e atualização das transportadoras pela planilha do ERP.
 */
export default async function ManutencaoPage() {
  await requireUser('manageUsers')
  const [counts, customers, carriers, imports] = await Promise.all([
    loadCounts(),
    customerCounts(),
    transportCompanyCounts(),
    db
      .select({
        id: schema.catalogImports.id,
        status: schema.catalogImports.status,
        createdAt: schema.catalogImports.createdAt,
        user: schema.users.name,
        productsFile: schema.catalogImports.productsFile,
        planned: sql<number | null>`(${schema.catalogImports.summary}->>'planned')::int`,
        pending: sql<number | null>`(${schema.catalogImports.summary}->>'pending')::int`,
      })
      .from(schema.catalogImports)
      .leftJoin(schema.users, eq(schema.users.id, schema.catalogImports.createdBy))
      .orderBy(desc(schema.catalogImports.createdAt))
      .limit(10),
  ])
  const recent: RecentImport[] = imports.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), user: r.user ?? '—' }))
  return (
    <>
      <h1>Manutenção</h1>
      <div className={css.grid}>
        <CatalogUploadCard recent={recent} />
        <DeleteLoadsCard counts={counts} />
        <CustomerImportCard current={customers} shipments={counts.shipments} />
        <CarrierImportCard current={carriers} />
      </div>
    </>
  )
}
