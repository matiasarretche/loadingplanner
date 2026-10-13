import 'server-only'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '@/db'
import { Area, canAccessArea, AreaUser } from './areas'

/**
 * Controle de acesso por ÁREA no servidor (páginas, rotas, ações e assistente IA): uma carga só é
 * acessível a quem trabalha na área do pedido dela (ADMIN: todas). Use sempre antes de ler/alterar.
 */
export async function areaOfPlan(planId: number): Promise<Area | null> {
  const [r] = await db
    .select({ area: schema.shipments.area })
    .from(schema.loadPlans)
    .innerJoin(schema.shipments, eq(schema.shipments.id, schema.loadPlans.shipmentId))
    .where(eq(schema.loadPlans.id, planId))
    .limit(1)
  return r?.area ?? null
}

export async function areaOfVersion(versionId: number): Promise<Area | null> {
  const [r] = await db
    .select({ area: schema.shipments.area })
    .from(schema.loadPlanVersions)
    .innerJoin(schema.loadPlans, eq(schema.loadPlans.id, schema.loadPlanVersions.loadPlanId))
    .innerJoin(schema.shipments, eq(schema.shipments.id, schema.loadPlans.shipmentId))
    .where(eq(schema.loadPlanVersions.id, versionId))
    .limit(1)
  return r?.area ?? null
}

/** true se o usuário pode acessar a carga (plano). */
export async function canAccessPlan(u: AreaUser, planId: number): Promise<boolean> {
  const a = await areaOfPlan(planId)
  if (a == null || !canAccessArea(u, a)) return false
  // Expedição: só cargas aprovadas
  return u.role !== 'WAREHOUSE_VIEWER' || (await hasApproved(planId))
}

async function hasApproved(planId: number) {
  const v = await db.query.loadPlanVersions.findFirst({ where: and(eq(schema.loadPlanVersions.loadPlanId, planId), eq(schema.loadPlanVersions.status, 'APPROVED')) })
  return Boolean(v)
}

/** true se o usuário pode acessar a versão de carga. */
export async function canAccessVersion(u: AreaUser, versionId: number): Promise<boolean> {
  const a = await areaOfVersion(versionId)
  if (a == null || !canAccessArea(u, a)) return false
  if (u.role !== 'WAREHOUSE_VIEWER') return true
  const v = await db.query.loadPlanVersions.findFirst({ where: eq(schema.loadPlanVersions.id, versionId) })
  return v?.status === 'APPROVED'
}
