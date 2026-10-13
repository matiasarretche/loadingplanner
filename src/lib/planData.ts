import 'server-only'
import { desc, eq } from 'drizzle-orm'
import { db, schema } from '@/db'

/**
 * Carrega plano + versão (pelo número ?v=, ou a mais recente) + embarque + cliente.
 * approvedOnly (Expedição): sempre a última versão APROVADA, ignorando ?v=.
 */
export async function loadPlanVersion(planId: number, version?: number, o: { approvedOnly?: boolean } = {}) {
  const plan = await db.query.loadPlans.findFirst({ where: eq(schema.loadPlans.id, planId) })
  if (!plan) return null
  const versions = await db.select().from(schema.loadPlanVersions).where(eq(schema.loadPlanVersions.loadPlanId, planId)).orderBy(desc(schema.loadPlanVersions.version))
  const v = o.approvedOnly ? versions.find((x) => x.status === 'APPROVED') : versions.find((x) => x.version === version) ?? versions[0]
  if (!v) return null
  const shipment = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, plan.shipmentId) })
  const customer = shipment ? await db.query.customers.findFirst({ where: eq(schema.customers.id, shipment.customerId) }) : undefined
  return { plan, v, shipment, customer }
}
