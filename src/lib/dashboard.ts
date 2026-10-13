import 'server-only'
import { desc, eq, inArray, sql } from 'drizzle-orm'
import { db, schema } from '@/db'
import type { DashRow } from '@/app/DashboardClient'
import { userAreas } from './areas'
import { avatarRef } from './avatar'
import type { CurrentUser } from './auth'
import { operationIdsByPlan } from './exportTracking'
import { canSeeExports } from './roles'

/** Dias sem alteração para um rascunho/revisão ser considerado "parado". */
export const STALE_DAYS = 7
/** Ocupação (máx. entre volume e payload) abaixo da qual a carga aparece como "baixa ocupação". */
export const LOW_OCCUPANCY_PCT = 70

/**
 * Linhas da página principal: só as cargas das áreas do usuário (ADMIN: todas), com criador,
 * último editor e os sinais de acompanhamento (parada, baixa ocupação, minha).
 */
export async function dashboardRows(u: CurrentUser): Promise<DashRow[]> {
  const areas = userAreas(u)
  if (!areas.length) return []
  const rows = await db
    .select({ plan: schema.loadPlans, shipment: schema.shipments, customer: schema.customers })
    .from(schema.loadPlans)
    .innerJoin(schema.shipments, eq(schema.shipments.id, schema.loadPlans.shipmentId))
    .innerJoin(schema.customers, eq(schema.customers.id, schema.shipments.customerId))
    .where(inArray(schema.shipments.area, areas))
  if (!rows.length) return []
  // só as colunas usadas (sem o documento inteiro, os alertas e os preços congelados)
  const versions = (
    await db
      .select({
        id: schema.loadPlanVersions.id,
        loadPlanId: schema.loadPlanVersions.loadPlanId,
        version: schema.loadPlanVersions.version,
        status: schema.loadPlanVersions.status,
        summary: schema.loadPlanVersions.summary,
        criticalCount: schema.loadPlanVersions.criticalCount,
        warningCount: schema.loadPlanVersions.warningCount,
        updatedAt: schema.loadPlanVersions.updatedAt,
        updatedBy: schema.loadPlanVersions.updatedBy,
        spaceCode: sql<string>`${schema.loadPlanVersions.document}->'space'->>'code'`,
        spaceKind: schema.loadPlanVersions.spaceKind,
      })
      .from(schema.loadPlanVersions)
      .where(inArray(schema.loadPlanVersions.loadPlanId, rows.map((r) => r.plan.id)))
      .orderBy(desc(schema.loadPlanVersions.version))
  ).map((v) => ({ ...v, document: { space: { code: v.spaceCode, kind: v.spaceKind } } }))
  // Exportações em curso: operação de seguimento das cargas de exportação (pedido confirmado), só para quem vê o módulo
  const [userRows, exportOps] = await Promise.all([
    db.select({ id: schema.users.id, name: schema.users.name, avatar: schema.users.avatar }).from(schema.users),
    canSeeExports(u) ? operationIdsByPlan(rows.filter((r) => r.shipment.area === 'EXPORT').map((r) => r.plan.id)) : null,
  ])
  const companies = new Map((await db.select({ id: schema.transportCompanies.id, code: schema.transportCompanies.code, name: schema.transportCompanies.name }).from(schema.transportCompanies)).map((c) => [c.id, `${c.code} — ${c.name}`]))
  const users = new Map(userRows.map((x) => [x.id, x.name]))
  const avatars = new Map(userRows.map((x) => [x.id, avatarRef(x.id, x.avatar)]))
  const latest = new Map<number, (typeof versions)[number]>()
  const approved = new Map<number, (typeof versions)[number]>()
  for (const v of versions) {
    if (!latest.has(v.loadPlanId)) latest.set(v.loadPlanId, v)
    if (v.status === 'APPROVED' && !approved.has(v.loadPlanId)) approved.set(v.loadPlanId, v)
  }
  // unidades do mesmo pedido (contêiner 1, 2…)
  const unitsOfShipment = new Map<number, number[]>()
  for (const { plan } of [...rows].sort((a, b) => a.plan.id - b.plan.id)) unitsOfShipment.set(plan.shipmentId, [...(unitsOfShipment.get(plan.shipmentId) ?? []), plan.id])
  const now = Date.now()

  const data: DashRow[] = rows.flatMap(({ plan, shipment, customer }) => {
    const v = latest.get(plan.id)
    if (!v) return []
    const a = approved.get(plan.id)
    const s = v.summary
    const units = unitsOfShipment.get(plan.shipmentId) ?? [plan.id]
    const open = v.status === 'DRAFT' || v.status === 'IN_REVIEW'
    const loaded = (s?.pallets ?? 0) + (s?.packages ?? 0) > 0
    const occ = Math.max(s?.volumeUtilPct ?? 0, s?.payloadPct ?? 0)
    return [
      {
        id: plan.id,
        name: plan.name,
        customer: customer.name,
        country: shipment.destinationCountry,
        orderRef: shipment.orderRef,
        transportCompany: plan.transportCompanyId ? companies.get(plan.transportCompanyId) ?? null : null,
        incoterm: shipment.incoterm,
        mode: shipment.service,
        area: shipment.area,
        equipment: v.document.space.code,
        versionId: v.id,
        version: v.version,
        status: v.status,
        approvedVersion: a && a.id !== v.id ? a.version : null,
        pallets: s?.pallets ?? 0,
        packages: s?.packages ?? 0,
        units: s?.units ?? 0,
        netKg: s?.netKg ?? 0,
        grossKg: s?.grossKg ?? 0,
        payloadPct: s?.payloadPct ?? null,
        cbm: s?.cbmUnits ?? 0,
        volumePct: s?.volumeUtilPct ?? 0,
        floorPct: s?.floorUtilPct ?? 0,
        critical: v.criticalCount,
        warnings: v.warningCount,
        createdAt: plan.createdAt.toISOString(),
        createdBy: plan.createdBy != null ? users.get(plan.createdBy) ?? '—' : '—',
        createdById: plan.createdBy,
        createdByAvatar: plan.createdBy != null ? avatars.get(plan.createdBy) ?? null : null,
        updatedAt: v.updatedAt.toISOString(),
        updatedBy: v.updatedBy != null ? users.get(v.updatedBy) ?? '—' : '—',
        stale: open && now - v.updatedAt.getTime() > STALE_DAYS * 86_400_000,
        // sem equipamento: não há ocupação a medir
        lowOccupancy: open && loaded && v.document.space.kind !== 'NONE' && occ < LOW_OCCUPANCY_PCT,
        unitIndex: units.length > 1 ? units.indexOf(plan.id) + 1 : null,
        unitCount: units.length,
        exportOpId: exportOps?.get(plan.id)?.id ?? null,
        exportStatus: exportOps?.get(plan.id)?.status ?? null,
      },
    ]
  })
  return data.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}
