import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { db, schema } from '@/db'
import { dt } from '@/components/format'
import { expeditionTransportLabel } from '@/components/editor/expeditionExport'
import { serviceOf, TYPE_INFO } from '@/domain/shipmentType'
import { canAccessPlan } from '@/lib/access'
import { requireUser } from '@/lib/auth'
import { orderRefLabel } from '@/lib/orderRef'
import { can } from '@/lib/roles'
import { PhotosPanel } from '../PhotosPanel'
import { ExpeditionView } from './ExpeditionView'

/**
 * VISTA DE EXPEDIÇÃO (depósito, pensada para o celular): sempre a última versão APROVADA — o que
 * carregar e em que ordem, o PDF de expedição, o 3D e as fotos do carregamento (o depósito anexa).
 */
export default async function ExpedicaoPage({ params }: PageProps<'/cargas/[id]/expedicao'>) {
  const u = await requireUser()
  const planId = Number((await params).id)
  if (!Number.isInteger(planId) || !(await canAccessPlan(u, planId))) notFound()
  const plan = await db.query.loadPlans.findFirst({ where: eq(schema.loadPlans.id, planId) })
  if (!plan) notFound()
  // outras unidades do mesmo pedido: só as aprovadas abrem para a Expedição
  const sibs = await db.select({ id: schema.loadPlans.id }).from(schema.loadPlans).where(eq(schema.loadPlans.shipmentId, plan.shipmentId)).orderBy(asc(schema.loadPlans.id))
  const approvedIds =
    sibs.length > 1
      ? new Set((await db.selectDistinct({ id: schema.loadPlanVersions.loadPlanId }).from(schema.loadPlanVersions).where(and(inArray(schema.loadPlanVersions.loadPlanId, sibs.map((x) => x.id)), eq(schema.loadPlanVersions.status, 'APPROVED')))).map((x) => x.id))
      : new Set<number>()
  const v = await db.query.loadPlanVersions.findFirst({ where: and(eq(schema.loadPlanVersions.loadPlanId, planId), eq(schema.loadPlanVersions.status, 'APPROVED')), orderBy: desc(schema.loadPlanVersions.version) })
  const shipment = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, plan.shipmentId) })
  const customer = shipment ? await db.query.customers.findFirst({ where: eq(schema.customers.id, shipment.customerId) }) : undefined
  // transportadora (sem condição de pagamento nem CFOP: a Expedição não vê dados comerciais/fiscais)
  const company = plan.transportCompanyId ? await db.query.transportCompanies.findFirst({ where: eq(schema.transportCompanies.id, plan.transportCompanyId), columns: { code: true, name: true } }) : undefined
  const transportCompany = expeditionTransportLabel(company)
  const orderRef = shipment?.orderRef ? orderRefLabel(shipment.orderRef, shipment.area) : null
  const service = serviceOf(shipment)
  const approver = v?.approvedBy ? await db.query.users.findFirst({ where: eq(schema.users.id, v.approvedBy), columns: { name: true } }) : undefined
  const photos = await db
    .select({ id: schema.loadPhotos.id, caption: schema.loadPhotos.caption, takenAt: schema.loadPhotos.takenAt, createdAt: schema.loadPhotos.createdAt, createdBy: schema.loadPhotos.createdBy, width: schema.loadPhotos.width, height: schema.loadPhotos.height, sizeBytes: schema.loadPhotos.sizeBytes })
    .from(schema.loadPhotos)
    .where(eq(schema.loadPhotos.loadPlanId, planId))
    .orderBy(asc(schema.loadPhotos.createdAt))
  const names = new Map((await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users)).map((x) => [x.id, x.name]))

  return (
    <div className="expedition-page">
      <div className="row no-print" style={{ marginBottom: 8 }}>
        <Link href="/">← Cargas</Link>
        <span className="spacer" />
        {can.editPlans(u.role) && <Link href={`/cargas/${planId}`}>Abrir no editor</Link>}
      </div>
      <h1>
        Expedição · {plan.name}{' '}
        {v && (
          <small>
            · V{v.version} <span className="badge APPROVED">Aprovada</span>
          </small>
        )}
      </h1>
      <div className="expedition-info">
        {orderRef && (
          <div>
            <span className="muted">Pedido</span> <strong>{orderRef}</strong>
          </div>
        )}
        <div>
          <span className="muted">Cliente</span> <strong>{customer?.name ?? '—'}</strong>
        </div>
        <div>
          <span className="muted">Destino</span> <strong>{shipment?.destinationCountry ?? '—'}</strong>
        </div>
        <div>
          <span className="muted">Envio</span> <strong>{TYPE_INFO[service].label}</strong>
          {v && v.document.space.kind !== 'NONE' && <> · {v.document.space.code}</>}
        </div>
        <div>
          <span className="muted">Transportadora</span> <strong>{transportCompany ?? 'A definir'}</strong>
        </div>
        {v?.approvedAt && (
          <div className="muted">
            Aprovada {approver?.name ? `por ${approver.name} ` : ''}em {dt(v.approvedAt)}
          </div>
        )}
      </div>
      {sibs.length > 1 && (
        <div className="unit-tabs no-print">
          <strong>
            Unidade {sibs.findIndex((x) => x.id === planId) + 1} de {sibs.length} do pedido
          </strong>
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            {sibs.map((x, i) =>
              approvedIds.has(x.id) ? (
                <Link key={x.id} href={`/cargas/${x.id}/expedicao`} className={`unit-tab ${x.id === planId ? 'active' : ''}`}>
                  <strong>Unidade {i + 1}</strong>
                </Link>
              ) : (
                <span key={x.id} className="unit-tab muted" title="Ainda não aprovada">
                  Unidade {i + 1} · não aprovada
                </span>
              ),
            )}
          </div>
        </div>
      )}
      {v ? (
        <ExpeditionView
          doc={v.document}
          info={{ planName: plan.name, version: v.version, status: v.status, customer: customer?.name ?? null, orderRef, destination: shipment?.destinationCountry ?? null, mode: TYPE_INFO[service].label, transportCompany, generatedBy: u.name }}
        />
      ) : (
        <div className="alert warn">Esta carga ainda não tem versão aprovada: a expedição só vê cargas aprovadas.</div>
      )}
      <div style={{ marginTop: 16 }}>
        <PhotosPanel
          planId={planId}
          approved={Boolean(v)}
          editable={can.editPlans(u.role)}
          canUpload={can.uploadPhotos(u.role)}
          open
          photos={photos.map((p) => ({ ...p, takenAt: p.takenAt?.toISOString() ?? null, createdAt: p.createdAt.toISOString(), createdBy: p.createdBy != null ? names.get(p.createdBy) ?? null : null }))}
        />
      </div>
    </div>
  )
}
