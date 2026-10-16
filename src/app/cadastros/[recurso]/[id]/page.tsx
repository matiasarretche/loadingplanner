import { asc, eq } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { db, schema } from '@/db'
import { dt } from '@/components/format'
import { ResourceForm } from '@/components/ResourceForm'
import { requireUser } from '@/lib/auth'
import { isResourceKey, RESOURCES } from '@/lib/resources'
import { can } from '@/lib/roles'
import { saveResourceAction } from '../../actions'

export default async function ResourceEdit({ params }: PageProps<'/cadastros/[recurso]/[id]'>) {
  const u = await requireUser()
  const { recurso, id } = await params
  if (!isResourceKey(recurso)) notFound()
  const r = RESOURCES[recurso]
  const table = r.table as unknown as PgTable & { id: PgColumn }
  const isNew = id === 'novo'
  let row: Record<string, unknown> | undefined
  if (!isNew) {
    const n = Number(id)
    if (!Number.isInteger(n)) notFound()
    ;[row] = (await db.select().from(table).where(eq(table.id, n))) as Record<string, unknown>[]
    if (!row) notFound()
  }
  const defaults: Record<string, unknown> = isNew ? { active: true, verification: 'UNVERIFIED', fourWay: true, overhangMaxMm: 0 } : row!
  const dynOptions = {
    constraintProfiles: (await db.select().from(schema.constraintProfiles).orderBy(asc(schema.constraintProfiles.name))).map((p) => ({
      value: String(p.id),
      label: p.name,
    })),
    agents: (await db.select().from(schema.agents).orderBy(asc(schema.agents.name))).map((a) => ({ value: String(a.id), label: `${a.name}${a.active ? '' : ' (inativo)'}` })),
  }
  const action = saveResourceAction.bind(null, recurso, isNew ? null : Number(id))
  // cliente: "código do ERP — razão social" (o código sozinho não diz quem é); demais cadastros: código ou nome
  const title = isNew ? '' : recurso === 'clientes' ? [row!.code, row!.name].filter(Boolean).map(String).join(' — ') : String(row!.code ?? row!.name)
  return (
    <>
      <div className="page-head">
        <h1>{isNew ? `Novo ${r.singular}` : `${r.title}: ${title}`}</h1>
        <Link href={`/cadastros/${recurso}`}>← Voltar</Link>
      </div>
      {!isNew && (
        <p className="muted">
          Criado em {dt(row!.createdAt as Date)} · atualizado em {dt(row!.updatedAt as Date)}. Cargas já salvas guardam uma cópia (snapshot)
          destes dados e não são alteradas por esta edição.
        </p>
      )}
      <ResourceForm fields={r.fields} defaults={defaults} action={action} readOnly={!can.editCatalog(u.role)} dynOptions={dynOptions} />
    </>
  )
}
