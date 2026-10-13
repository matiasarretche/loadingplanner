import { eq } from 'drizzle-orm'
import { db, schema } from '@/db'
import { BODY_LIMITS, fmtMB } from '@/components/intake/limits'
import { pendingWorkbook } from '@/lib/catalogImport/pendingXlsx'
import { routeUser } from '@/lib/routeAuth'

/**
 * GET /admin/manutencao/catalogo/{id}/pendentes — planilha (.xlsx) dos produtos da prévia que ficam SEM
 * caixa (motivo, caixa sugerida, unidades por caixa dos pacotes) para a equipe completar.
 */
export async function GET(_req: Request, ctx: RouteContext<'/admin/manutencao/catalogo/[id]/pendentes'>) {
  const u = await routeUser('manageUsers', { text: true, denied: 'Só o administrador principal vê as importações do catálogo.' })
  if (u instanceof Response) return u
  const id = Number((await ctx.params).id)
  const text = (status: number, msg: string) => new Response(msg, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
  if (!Number.isInteger(id) || id <= 0) return text(404, 'Importação não encontrada.')
  const row = await db.query.catalogImports.findFirst({ where: eq(schema.catalogImports.id, id), columns: { plan: true } })
  if (!row) return text(404, 'Importação não encontrada.')
  const buf = await pendingWorkbook(row.plan, id)
  if (buf.length > BODY_LIMITS.response) return text(413, `Planilha grande demais para baixar (${fmtMB(buf.length, true)}).`)
  return new Response(new Uint8Array(buf), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="pendentes-importacao-${id}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  })
}
