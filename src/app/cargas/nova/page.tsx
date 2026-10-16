import { asc, desc, eq, inArray, sql } from 'drizzle-orm'
import Link from 'next/link'
import { dateBR } from '@/components/format'
import { db, schema } from '@/db'
import { requireUser } from '@/lib/auth'
import { NewPlanForm } from './NewPlanForm'
import { userAreas } from '@/lib/areas'
import type { LastLoad } from './NewPlanForm'
import { cargoVehicleWhere } from '@/lib/vehicles'
import { isService } from '@/domain/shipmentType'
import { currentPackCatalog } from '@/lib/catalog'
import { OrderIntake } from '../ia/OrderIntake'
import { formatCustomerAddress } from '@/domain/customerAddress'

export default async function NovaCargaPage({ searchParams }: PageProps<'/cargas/nova'>) {
  const u = await requireUser('editPlans')
  const sp = await searchParams
  const [customers, containers, vehicles, profiles, companies, agents] = await Promise.all([
    db.select().from(schema.customers).where(eq(schema.customers.active, true)).orderBy(asc(schema.customers.name)),
    db.select().from(schema.containerTypes).where(eq(schema.containerTypes.active, true)).orderBy(asc(schema.containerTypes.code)),
    db.select().from(schema.vehicleTypes).where(cargoVehicleWhere()).orderBy(asc(schema.vehicleTypes.code)),
    db.select().from(schema.constraintProfiles).where(eq(schema.constraintProfiles.active, true)).orderBy(asc(schema.constraintProfiles.name)),
    db.select().from(schema.transportCompanies).where(eq(schema.transportCompanies.active, true)).orderBy(asc(schema.transportCompanies.code)),
    db.select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents).where(eq(schema.agents.active, true)).orderBy(asc(schema.agents.name)),
  ])
  // última carga de cada cliente (nas áreas do usuário): preenche o formulário ao escolher o cliente
  const areas = userAreas(u)
  const recent = await db
    .select({
      customerId: schema.shipments.customerId,
      area: schema.shipments.area,
      country: schema.shipments.destinationCountry,
      incoterm: schema.shipments.incoterm,
      mode: schema.shipments.mode,
      service: schema.shipments.service,
      maxHeightMm: sql<number | null>`(${schema.loadPlanVersions.document}->'space'->>'maxLoadHeightMm')::int`,
      courierDivisor: sql<number | null>`(${schema.loadPlanVersions.document}->'space'->>'courierDivisor')::int`,
      originPlace: schema.shipments.originPlace,
      destinationPlace: schema.shipments.destinationPlace,
      customerAddress: schema.shipments.customerAddress,
      spaceKind: schema.loadPlanVersions.spaceKind,
      spaceTypeId: schema.loadPlanVersions.spaceTypeId,
      profileIds: sql<number[] | null>`(select coalesce(jsonb_agg((l->>'profileId')::int), '[]'::jsonb) from jsonb_array_elements(coalesce(${schema.loadPlanVersions.document}->'limits', '[]'::jsonb)) l where l ? 'profileId')`,
      at: schema.loadPlanVersions.createdAt,
      plan: schema.loadPlans.name,
    })
    .from(schema.loadPlanVersions)
    .innerJoin(schema.loadPlans, eq(schema.loadPlans.id, schema.loadPlanVersions.loadPlanId))
    .innerJoin(schema.shipments, eq(schema.shipments.id, schema.loadPlans.shipmentId))
    .where(inArray(schema.shipments.area, areas))
    .orderBy(desc(schema.loadPlanVersions.createdAt))
  const lastLoad: Record<string, LastLoad> = {}
  for (const r of recent) {
    const k = String(r.customerId)
    if (lastLoad[k]) continue
    lastLoad[k] = {
      area: r.area,
      country: r.country,
      incoterm: r.incoterm,
      service: r.service,
      maxHeightMm: r.maxHeightMm,
      courierDivisor: r.courierDivisor,
      originPlace: r.originPlace ?? '',
      destinationPlace: r.destinationPlace ?? '',
      customerAddress: r.customerAddress ?? '',
      equipment: r.spaceKind === 'NONE' ? null : `${r.spaceKind}:${r.spaceTypeId}`,
      profiles: (r.profileIds ?? []).map(String),
      plan: r.plan,
      date: dateBR(r.at),
    }
  }
  const fmtKg = (v: number | null) => (v == null ? '?' : v.toLocaleString('pt-BR'))
  // clientes ativos para o seletor com busca (nome, cidade, país, código do ERP) e o endereço do cadastro em uma linha
  const pickerCustomers = customers.map((c) => ({ id: c.id, name: c.name, code: c.code, city: c.city, country: c.country ?? '', address: formatCustomerAddress(c) }))
  // entrada pelo PEDIDO DO CLIENTE (texto, anexos, ditado) interpretado pela IA
  const byOrder = sp.entrada === 'pedido'
  const catalog = byOrder ? await currentPackCatalog() : []
  return (
    <>
      <div className="page-head">
        <h1>{userAreas(u).length === 1 && userAreas(u)[0] === 'DOMESTIC' ? 'Nova carga — mercado interno' : 'Nova carga'}</h1>
        <Link href="/">← Cargas</Link>
      </div>
      <div className="row" style={{ gap: 6, marginBottom: 12 }}>
        <Link className={`btn small ${byOrder ? '' : 'active'}`} href="/cargas/nova">
          ✍️ Preencher os dados
        </Link>
        <Link className={`btn small ${byOrder ? 'active' : ''}`} href="/cargas/nova?entrada=pedido" title="Anexe a ordem de compra, foto, PDF ou planilha do cliente (ou dite/escreva): a IA interpreta, você confere e a carga é montada">
          📎 A partir do pedido do cliente (IA)
        </Link>
      </div>
      {byOrder ? (
        <OrderIntake
          areas={areas}
          customers={pickerCustomers}
          equipment={[
            ...containers.map((c) => ({ value: `CONTAINER:${c.id}`, label: `${c.code} — ${c.name}`, mode: c.transportMode === 'AIR' ? 'AIR' : 'SEA' })),
            ...vehicles.map((v) => ({ value: `VEHICLE:${v.id}`, label: `${v.code} — ${v.name}`, mode: 'ROAD' })),
          ]}
          catalog={catalog.map((p) => ({ sku: p.sku, name: p.name, unitsPerPackage: p.unitsPerPackage, netKg: p.netKg }))}
        />
      ) : (
      <NewPlanForm
        areas={areas}
        lastLoad={lastLoad}
        companies={companies.map((c) => `${c.code} — ${c.name}`)}
        aiMode={sp.ia === '1'}
        initialService={isService(sp.tipo) ? sp.tipo : undefined}
        agents={agents.map((a) => ({ value: String(a.id), label: a.name }))}
        customers={customers.map((c, i) => ({ ...pickerCustomers[i], agentId: c.agentId != null ? String(c.agentId) : '' }))}
        ulds={containers.filter((c) => c.transportMode === 'AIR').map((c) => ({
          value: `CONTAINER:${c.id}`,
          label: `${c.code} — ${c.name}`,
          detail: `Útil ${c.innerLengthMm}×${c.innerWidthMm}×${c.innerHeightMm} mm · tara ${fmtKg(c.tareKg)} kg · bruto máx. ${fmtKg(c.maxGrossKg)} kg · contorno simplificado como caixa · ${c.verification === 'VERIFIED' ? 'verificado' : 'REFERÊNCIA — confirmar com a companhia aérea'}`,
        }))}
        containers={containers.filter((c) => c.transportMode !== 'AIR').map((c) => ({
          value: `CONTAINER:${c.id}`,
          label: `${c.code} — ${c.name}`,
          detail: `Interno ${c.innerLengthMm}×${c.innerWidthMm}×${c.innerHeightMm} mm · porta ${c.doorWidthMm}×${c.doorHeightMm} · tara ${fmtKg(c.tareKg)} kg · payload ${fmtKg(c.maxPayloadKg)} kg · bruto ${fmtKg(c.maxGrossKg)} kg · ${c.verification === 'VERIFIED' ? 'verificado' : 'REFERÊNCIA — confirmar com a naviera'}`,
        }))}
        vehicles={vehicles.map((v) => ({
          value: `VEHICLE:${v.id}`,
          label: `${v.code} — ${v.name}${v.carrier ? ` (${v.carrier})` : ''}`,
          detail: `Interno ${v.innerLengthMm}×${v.innerWidthMm}×${v.innerHeightMm} mm · porta ${v.doorWidthMm}×${v.doorHeightMm} · tara ${fmtKg(v.tareKg)} kg · payload ${fmtKg(v.maxPayloadKg)} kg · ${v.verification === 'VERIFIED' ? 'verificado' : 'NÃO VERIFICADO — confirmar com o transportador'}`,
        }))}
        profiles={profiles.map((p) => ({
          value: String(p.id),
          label: `${p.name} (${p.scope}${p.country ? ` · ${p.country}` : ''})`,
          defaultChecked: p.scope === 'OPERATIONAL',
        }))}
      />
      )}
    </>
  )
}
