import { asc } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { db } from '@/db'
import { formatCell, nf0, VERIFICATION_LABEL } from '@/components/format'
import { requireUser } from '@/lib/auth'
import { isResourceKey, listRows, RESOURCES } from '@/lib/resources'
import { can } from '@/lib/roles'

/** a partir de quantos registros a lista mostra a busca (transportadoras do ERP: centenas) */
const SEARCH_FROM = 30

export default async function ResourceList({ params, searchParams }: PageProps<'/cadastros/[recurso]'>) {
  const u = await requireUser()
  const { recurso } = await params
  const sp = await searchParams
  if (!isResourceKey(recurso)) notFound()
  const r = RESOURCES[recurso]
  const table = r.table as unknown as PgTable & Record<string, PgColumn>
  const all = (await db.select().from(table).orderBy(asc(table[r.orderBy]))) as Record<string, unknown>[]
  const q = typeof sp.q === 'string' ? sp.q.trim().slice(0, 100) : ''
  const rows = listRows(all, { fields: r.fields, orderBy: r.orderBy, numericOrder: 'numericOrder' in r && r.numericOrder, q })
  const cols = r.fields.filter((f) => f.list)
  const editable = can.editCatalog(u.role)
  return (
    <>
      <div className="page-head">
        <h1>{r.title}</h1>
        <Link href="/cadastros">← Cadastros</Link>
        {editable && (
          <Link className="btn primary" href={`/cadastros/${recurso}/novo`}>
            Novo {r.singular}
          </Link>
        )}
      </div>
      {sp.salvo && <div className="alert ok">Salvo.</div>}
      {(all.length >= SEARCH_FROM || q) && (
        <form className="row" style={{ marginBottom: 10, gap: 8 }} role="search">
          <input type="search" name="q" defaultValue={q} placeholder={`Buscar por ${cols.filter((f) => f.type !== 'bool').map((f) => f.label.toLowerCase()).slice(0, 3).join(', ')}…`} aria-label={`Buscar em ${r.title}`} style={{ flex: '1 1 260px', maxWidth: 420 }} />
          <button>Buscar</button>
          {q && <Link href={`/cadastros/${recurso}`}>Limpar</Link>}
          <small className="muted">{q ? `${nf0.format(rows.length)} de ${nf0.format(all.length)}` : `${nf0.format(all.length)} registros`}</small>
        </form>
      )}
      <table className="data">
        <thead>
          <tr>
            {cols.map((f) => (
              <th key={f.name} className={f.type === 'int' || f.type === 'decimal' ? 'num' : ''}>
                {f.label}
              </th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)} style={row.active === false ? { opacity: 0.5 } : undefined}>
              {cols.map((f) => (
                <td key={f.name} className={f.type === 'int' || f.type === 'decimal' ? 'num' : ''}>
                  {f.name === 'verification' ? (
                    <span className={`badge ${row.verification}`}>{VERIFICATION_LABEL[String(row.verification)]}</span>
                  ) : (
                    formatCell(f, row[f.name])
                  )}
                </td>
              ))}
              <td>
                <Link href={`/cadastros/${recurso}/${row.id}`}>{editable ? 'Editar' : 'Ver'}</Link>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={cols.length + 1} className="muted">
                {q ? `Nenhum registro com “${q}”.` : 'Nenhum registro.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  )
}
