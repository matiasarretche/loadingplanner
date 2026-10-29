import { eq } from 'drizzle-orm'
import { db, schema } from '@/db'
import { loadGeometries, loadSummary } from '@/domain/load'
import { transportCompanyLabel } from '@/domain/transportCompany'
import { loadPlanVersion } from '@/lib/planData'
import { canAccessPlan } from '@/lib/access'
import { routeUser } from '@/lib/routeAuth'

const esc = (v: unknown) => {
  const s = v == null ? '' : typeof v === 'number' ? String(v).replace('.', ',') : String(v)
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Packing list em CSV (separador ";" e decimal "," para Excel pt-BR). Pode ir a terceiros: da parte comercial
 * só a transportadora (nunca condição de pagamento nem CFOP).
 */
export async function GET(req: Request, ctx: RouteContext<'/cargas/[id]/csv'>) {
  const u = await routeUser(undefined, { text: true })
  if (u instanceof Response) return u
  const { id } = await ctx.params
  const v = Number(new URL(req.url).searchParams.get('v')) || undefined
  if (!(await canAccessPlan(u, Number(id)))) return new Response('Não encontrado', { status: 404 })
  // Expedição: sempre a última versão aprovada
  const data = await loadPlanVersion(Number(id), v, { approvedOnly: u.role === 'WAREHOUSE_VIEWER' })
  if (!data) return new Response('Não encontrado', { status: 404 })
  const doc = data.v.document
  const s = loadSummary(doc)
  const company = data.plan.transportCompanyId ? await db.query.transportCompanies.findFirst({ where: eq(schema.transportCompanies.id, data.plan.transportCompanyId), columns: { code: true, name: true } }) : undefined
  const lines: unknown[][] = [
    ['Plano', data.plan.name, 'Versão', `V${data.v.version}`, 'Status', data.v.status],
    ['Cliente', data.customer?.name, 'País', data.shipment?.destinationCountry, 'Incoterm', data.shipment?.incoterm],
    ['Equipamento', doc.space.code, 'Peso bruto kg (c/ paletes)', s.payloadKg, 'Peso c/ equipamento kg', s.grossKg],
    ['Transportadora', company ? transportCompanyLabel(company) : ''],
    // quem gerou o arquivo (discreto, junto dos dados do plano)
    ['Gerado por', u.name, 'Em', new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })],
    [],
    ['#', 'Unidade', 'Tipo', 'SKU', 'Descrição', 'Volumes', 'Unidades', 'Líquido kg', 'Líq. c/ embalagem kg', 'x mm', 'y mm', 'z mm', 'C mm', 'L mm', 'A mm', 'Bruto unidade kg'],
  ]
  loadGeometries(doc).forEach((g, i) => {
    for (const l of g.bySku) {
      lines.push([
        i + 1,
        g.label,
        g.unit.kind === 'PALLET' ? 'Palete' : 'Volume',
        l.sku,
        l.name,
        l.packages,
        l.units,
        Number(l.netKg.toFixed(3)),
        Number(l.grossKg.toFixed(3)),
        g.box.min.x,
        g.box.min.y,
        g.box.min.z,
        g.box.size.x,
        g.box.size.y,
        g.box.size.z,
        Number(g.grossKg.toFixed(3)),
      ])
    }
  })
  const csv = '﻿' + lines.map((l) => l.map(esc).join(';')).join('\r\n')
  const name = `packing-list-${data.plan.id}-V${data.v.version}.csv`
  return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` } })
}
