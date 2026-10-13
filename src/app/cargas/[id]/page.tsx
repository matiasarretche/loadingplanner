import { asc, desc, eq, inArray } from 'drizzle-orm'
import { SubmitButton } from '@/components/SubmitButton'
import { isNoEquipment, serviceOf, TYPE_INFO } from '@/domain/shipmentType'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { db, schema } from '@/db'
import { dateBR, dt, kg, m3, pct, STATUS_LABEL } from '@/components/format'
import { LoadEditor } from '@/components/editor/LoadEditor'
import { requireUser } from '@/lib/auth'
import { currentPackCatalog, palletingData, productRank, sortCompositions } from '@/lib/catalog'
import { resolveLogistics } from '@/domain/logisticsRules'
import { can, canConfirmExports, canSeeExports } from '@/lib/roles'
import { containerSpace, limitSnapshot, vehicleSpace } from '@/lib/snapshots'
import { approveAction, newVersionAction, returnToDraftAction, saveMultiUnitAction, saveVersionAction, submitForReviewAction } from '../actions'
import { unitNoun } from '@/lib/units'
import { operationIdsByPlan } from '@/lib/exportTracking'
import { EXPORT_STATUS_LABEL, EXPORT_STATUS_SHORT } from '@/domain/exportTracking'
import { ConfirmOrderButton } from './ConfirmOrderButton'
import { DeleteUnitButton } from './DeleteUnitButton'
import { OrderRefField } from './OrderRefField'
import { ValuePanel } from './ValuePanel'
import { ProformaPanel } from './ProformaPanel'
import { PhotosPanel } from './PhotosPanel'
import { issuedQuotesView, planValue } from '@/lib/loadPricing'
import { QuoteRow } from '@/components/quotes/QuoteView'
import { orderRefLabel } from '@/lib/orderRef'
import { canAccessPlan } from '@/lib/access'
import { AREA_LABEL } from '@/lib/areas'
import { cargoVehicleWhere, roadOptions } from '@/lib/vehicles'

// as server actions desta página chamam a IA (Assistente, interpretar pedido): tempo máximo do plano Hobby da Vercel
export const maxDuration = 300

type UnitRow ={ id: number; n: number; name: string; v: (typeof schema.loadPlanVersions.$inferSelect) | undefined; allDraft: boolean }

/**
 * Navegação entre as unidades (contêineres/veículos) do mesmo pedido, com peso, ocupação e paletes
 * de cada uma, total do pedido e o espaço livre na última (para completar, reduzir ou mandar parcial).
 */
function UnitTabs({ units, current, orderRef, area, canDelete }: { units: UnitRow[]; current: number; orderRef: string | null; area: string | null; canDelete: boolean }) {
  const tot = units.reduce((a, x) => ({ pallets: a.pallets + (x.v?.summary?.pallets ?? 0), gross: a.gross + (x.v?.summary?.grossKg ?? 0), payload: a.payload + (x.v?.summary?.payloadKg ?? 0) }), { pallets: 0, gross: 0, payload: 0 })
  const last = units[units.length - 1]
  const lastPct = last.v?.summary?.payloadPct ?? null
  const cur = units.find((x) => x.id === current)
  const noun = (x: UnitRow) => (x.v ? unitNoun(x.v.document.space) : 'Unidade')
  return (
    <div className="unit-tabs no-print">
      <div className="row" style={{ marginBottom: 6 }}>
        <strong>{orderRef ? orderRefLabel(orderRef, area) : area === 'EXPORT' ? 'Proforma' : 'Pedido'} em {units.length} unidades</strong>
        <span className="muted">
          Total: {tot.pallets} paletes · payload {kg(tot.payload)} · bruto {kg(tot.gross)}
          {lastPct != null && lastPct < 100 && ` · ${noun(last)} ${last.n} com ${pct(lastPct)} do payload (livre ~${pct(100 - lastPct)}: completar, reduzir o pedido ou enviar parcial)`}
        </span>
        <span className="spacer" />
        {canDelete && cur && cur.allDraft && <DeleteUnitButton planId={cur.id} label={`${noun(cur)} ${cur.n}`} />}
      </div>
      <div className="row" style={{ gap: 6 }}>
        {units.map((x) => (
          <Link key={x.id} href={`/cargas/${x.id}`} className={`unit-tab ${x.id === current ? 'active' : ''}`} title={x.name}>
            <strong>
              {noun(x)} {x.n}
            </strong>
            <small>
              {x.v?.document.space.code} · {x.v?.summary?.pallets ?? 0} pal. · {kg(x.v?.summary?.payloadKg)} · {pct(x.v?.summary?.payloadPct)}
              {x.v && x.v.criticalCount > 0 && ` · ⚠ ${x.v.criticalCount}`}
            </small>
          </Link>
        ))}
      </div>
    </div>
  )
}

const READONLY_TEXT: Record<string, string> = {
  IN_REVIEW: 'Esta versão está em revisão',
  APPROVED: 'Esta versão está aprovada',
  SUPERSEDED: 'Esta versão foi substituída por outra aprovação',
}

export default async function CargaPage({ params, searchParams }: PageProps<'/cargas/[id]'>) {
  const u = await requireUser()
  const { id } = await params
  const sp = await searchParams
  const planId = Number(id)
  if (!Number.isInteger(planId)) notFound()
  // área do pedido: quem não trabalha nela não vê a carga (ADMIN vê todas)
  if (!(await canAccessPlan(u, planId))) notFound()
  // Expedição: a vista de depósito, sempre com a última versão APROVADA (nunca um rascunho)
  if (u.role === 'WAREHOUSE_VIEWER') redirect(`/cargas/${planId}/expedicao`)
  const plan = await db.query.loadPlans.findFirst({ where: eq(schema.loadPlans.id, planId) })
  if (!plan) notFound()
  const shipment = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, plan.shipmentId) })
  const customer = shipment && (await db.query.customers.findFirst({ where: eq(schema.customers.id, shipment.customerId) }))
  const versions = await db.select().from(schema.loadPlanVersions).where(eq(schema.loadPlanVersions.loadPlanId, planId)).orderBy(desc(schema.loadPlanVersions.version))
  const wanted = Number(sp.v)
  const v = versions.find((x) => x.version === wanted) ?? versions[0]
  if (!v) notFound()
  const userIds = [...new Set([plan.createdBy, ...versions.flatMap((x) => [x.createdBy, x.updatedBy, x.approvedBy])].filter((x): x is number => x != null))]
  const users = userIds.length ? await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, userIds)) : []
  const uname = (id: number | null) => users.find((x) => x.id === id)?.name ?? '—'

  // unidades do mesmo pedido (envio): Contêiner 1, 2, 3… na ordem de criação, com a última versão de cada
  const siblings = await db.select().from(schema.loadPlans).where(eq(schema.loadPlans.shipmentId, plan.shipmentId)).orderBy(asc(schema.loadPlans.id))
  const sibVersions = siblings.length > 1 ? await db.select().from(schema.loadPlanVersions).where(inArray(schema.loadPlanVersions.loadPlanId, siblings.map((x) => x.id))) : []
  const units = siblings.map((p, i) => {
    const vs = sibVersions.filter((x) => x.loadPlanId === p.id)
    const cur = p.id === planId ? v : vs.reduce<(typeof vs)[number] | undefined>((a, b) => (!a || b.version > a.version ? b : a), undefined)
    return { id: p.id, n: i + 1, name: p.name, v: cur, allDraft: (p.id === planId ? versions : vs).every((x) => x.status === 'DRAFT') }
  })

  // Exportações em curso: operação de seguimento desta carga (→ "Ver seguimento") ou "Confirmar pedido"
  // (exige versão APROVADA); no diálogo, as outras unidades do pedido aprovadas e ainda sem operação
  const exportOps = shipment?.area === 'EXPORT' && canSeeExports(u) ? await operationIdsByPlan(units.map((x) => x.id)) : null
  const exportOp = exportOps?.get(planId) ?? null
  const approvedPlans = new Set([...versions, ...sibVersions].filter((x) => x.status === 'APPROVED').map((x) => x.loadPlanId))
  const canConfirm = !exportOp && shipment?.area === 'EXPORT' && canConfirmExports(u) && approvedPlans.has(planId)
  const confirmSiblings = canConfirm
    ? units.filter((x) => x.id !== planId && approvedPlans.has(x.id) && !exportOps?.has(x.id)).map((x) => ({ loadPlanId: x.id, label: `${x.v ? unitNoun(x.v.document.space) : 'Unidade'} ${x.n} — ${x.name}` }))
    : []

  const editable = v.status === 'DRAFT' && can.editPlans(u.role)
  const [catalog, comps, containers, vehicles, profiles] = editable
    ? await Promise.all([
        currentPackCatalog(),
        db.select().from(schema.palletCompositions).where(eq(schema.palletCompositions.active, true)).orderBy(asc(schema.palletCompositions.name)),
        db.select().from(schema.containerTypes).where(eq(schema.containerTypes.active, true)).orderBy(asc(schema.containerTypes.code)),
        db.select().from(schema.vehicleTypes).where(cargoVehicleWhere()).orderBy(asc(schema.vehicleTypes.code)),
        db.select().from(schema.constraintProfiles).where(eq(schema.constraintProfiles.active, true)).orderBy(asc(schema.constraintProfiles.name)),
      ])
    : [[], [], [], [], []]
  const mode = shipment?.mode
  const service = serviceOf(shipment)
  const noEq = isNoEquipment(service)
  // montagens na ordem única de produtos (mesma do catálogo e dos demais seletores)
  const rank = editable ? await productRank() : new Map<string, number>()
  const mixed = editable ? await palletingData() : null
  // distribuição por eixo: rodoviário e contêiner marítimo (sobre chassi); não se aplica ao aéreo
  const road = editable && mode !== 'AIR' && !noEq ? await roadOptions() : undefined
  const spaces = noEq ? [] : [
    ...containers.filter((c) => (mode === 'AIR' ? c.transportMode === 'AIR' : mode === 'SEA' ? c.transportMode !== 'AIR' : mode !== 'ROAD')).map(containerSpace),
    ...(mode === 'ROAD' || !mode ? vehicles.map(vehicleSpace) : []),
  ]
  // mantém o snapshot atual como opção mesmo se o cadastro mudou/foi desativado
  const curKey = `${v.document.space.kind}:${v.document.space.typeId}`
  const spaceOpts = [v.document.space, ...spaces.filter((s) => `${s.kind}:${s.typeId}` !== curKey)]
  const profileOpts = [...v.document.limits, ...profiles.map(limitSnapshot).filter((p) => !v.document.limits.some((l) => l.profileId === p.profileId))]

  const title = (
    <>
      {plan.name}{' '}
      <small>
        · V{v.version} <span className={`badge ${v.status}`}>{STATUS_LABEL[v.status]}</span>
      </small>
    </>
  )

  return (
    <>
      <div className="row no-print load-head" style={{ marginBottom: 8 }}>
        <Link href="/">← Cargas</Link>
        <span className="muted">
          {shipment && <span className={`pill area-${shipment.area}`} style={{ marginRight: 6 }}>{AREA_LABEL[shipment.area]}</span>}
          {customer?.name} · {shipment?.destinationCountry} · {shipment?.incoterm} · {TYPE_INFO[service].label} ·{' '}
          {shipment && <OrderRefField planId={planId} area={shipment.area} value={shipment.orderRef} editable={can.editPlans(u.role)} />}{' '}
          {(shipment?.originPlace || shipment?.destinationPlace) && `· ${shipment?.originPlace || '?'} → ${shipment?.destinationPlace || '?'} `}· criada por {uname(plan.createdBy)} em {dt(plan.createdAt)} · última alteração: {uname(v.updatedBy)}, {dt(v.updatedAt)}
        </span>
        <span className="spacer" />
        <Link className="btn small" href={`/cargas/${planId}/resumo?v=${v.version}`}>
          Resumo / impressão
        </Link>
        <a className="btn small" href={`/cargas/${planId}/csv?v=${v.version}`}>
          Packing list CSV
        </a>
        {can.editPlans(u.role) && (
          <form action={newVersionAction.bind(null, v.id)}>
            <SubmitButton className="small" pendingText="Criando…">Nova versão a partir da V{v.version}</SubmitButton>
          </form>
        )}
        {v.status === 'DRAFT' && can.editPlans(u.role) && (
          <form action={submitForReviewAction.bind(null, v.id)}>
            <SubmitButton className="small" pendingText="Enviando…">Enviar para revisão</SubmitButton>
          </form>
        )}
        {v.status === 'IN_REVIEW' && can.approve(u.role) && (
          <form action={returnToDraftAction.bind(null, v.id)}>
            <SubmitButton className="small" pendingText="Devolvendo…">Devolver para rascunho</SubmitButton>
          </form>
        )}
        {(v.status === 'DRAFT' || v.status === 'IN_REVIEW') && can.approve(u.role) && (
          <form action={approveAction.bind(null, v.id)}>
            <SubmitButton className="small primary" pendingText="Aprovando…" disabled={v.criticalCount > 0} title={v.criticalCount > 0 ? 'Resolva os alertas críticos e salve antes de aprovar' : ''}>
              Aprovar V{v.version}
            </SubmitButton>
          </form>
        )}
        {exportOp ? (
          <>
            <Link className="btn small" href={`/exportacoes/${exportOp.id}`} title="Exportações em curso: datas, booking, contêiner, chegada…">
              Ver seguimento
            </Link>
            <span className={`pill exp-${exportOp.status}`} title={`Exportação: ${EXPORT_STATUS_LABEL[exportOp.status]}`}>
              {EXPORT_STATUS_SHORT[exportOp.status]}
            </span>
          </>
        ) : (
          canConfirm && <ConfirmOrderButton planId={planId} siblings={confirmSiblings} />
        )}
      </div>
      {units.length > 1 && <UnitTabs units={units} current={planId} orderRef={shipment?.orderRef ?? null} area={shipment?.area ?? null} canDelete={can.editPlans(u.role)} />}
      {sp.erro === 'excluir' && <div className="alert error">Não é possível excluir esta unidade: ela é a única do pedido ou tem versão em revisão/aprovada.</div>}
      {sp.erro === 'seguimento' && (
        <div className="alert error">
          Não é possível excluir esta carga: o pedido foi confirmado e ela está em Exportações em curso. Desfaça a confirmação no seguimento (possível enquanto o status for “Pedido confirmado”) e tente de novo.
        </div>
      )}
      {sp.erro === 'fora' && <div className="alert error">Não é possível enviar para revisão: há unidades fora da carga (pendentes de ubicação). Reposicione-as dentro do equipamento ou retire-as e salve.</div>}
      {sp.erro === 'critico' && <div className="alert error">Não é possível aprovar: a versão salva tem alertas críticos.</div>}
      {sp.erro === 'emedicao' && <div className="alert error">Não é possível enviar para revisão nem aprovar: a carga está sendo editada por outro usuário agora. Tente quando ele terminar.</div>}
      {sp.erro === 'vazia' && <div className="alert error">Não é possível aprovar uma carga vazia.</div>}
      {sp.erro === 'sempreco' && (
        <div className="alert error">
          Não é possível aprovar: produto(s) sem preço de exportação — <strong>{String(sp.skus ?? '').split(',').join(', ')}</strong>. Cadastre o preço da família/categoria em Preços exportação (ou confira o país/categoria do cliente) e aprove de novo.
        </div>
      )}
      {v.status !== 'DRAFT' && (
        <div className="alert warn">
          {READONLY_TEXT[v.status]} — somente leitura. {v.status === 'APPROVED' && `Aprovada por ${uname(v.approvedBy)} em ${dt(v.approvedAt)}. `}Para alterar, crie uma
          nova versão.
        </div>
      )}
      {editable && v.criticalCount > 0 && <div className="alert warn">A última gravação desta versão tem {v.criticalCount} alerta(s) crítico(s).</div>}

      {/* ordem: proforma e transporte → valor do pedido (interno) → cotações emitidas; as fotos do carregamento vão no fim da página */}
      {await (async () => {
        const seePrices = can.viewPrices(u.role)
        const pv = shipment?.area === 'EXPORT' && seePrices ? await planValue({ v, shipment, plan }) : null
        const companies = await db.select({ id: schema.transportCompanies.id, code: schema.transportCompanies.code, name: schema.transportCompanies.name, active: schema.transportCompanies.active }).from(schema.transportCompanies).orderBy(asc(schema.transportCompanies.code))
        return (
          <>
            {seePrices && <ProformaPanel
              planId={planId}
              exportArea={shipment?.area === 'EXPORT'}
              editable={can.editPlans(u.role)}
              goodsUsd={pv?.value.totals.USD ?? null}
              incoterm={shipment?.incoterm ?? null}
              companies={companies}
              agents={await db.select({ id: schema.agents.id, name: schema.agents.name, active: schema.agents.active }).from(schema.agents).orderBy(asc(schema.agents.name))}
              value={{ agentId: plan.agentId, transportCompanyId: plan.transportCompanyId, freightUsd: plan.freightUsd, insuranceUsd: plan.insuranceUsd, paymentTerms: plan.paymentTerms }}
            />}
            {pv && <ValuePanel pv={pv} />}
          </>
        )
      })()}
      {/* cotações emitidas: o preço enviado ao cliente e como foi calculado (categoria, comissão, USD/kg) */}
      {shipment?.area === 'EXPORT' && can.viewPrices(u.role) && <QuoteHistory quotes={await issuedQuotesView({ loadPlanId: planId, limit: 50 })} />}

      <LoadEditor
        key={`${v.id}-${v.status}`}
        userName={u.name}
        initial={v.document}
        compositions={sortCompositions(comps, rank).map((c) => ({ key: `c${c.id}r${c.updatedAt.getTime()}`, id: c.id, name: c.name, doc: c.document }))}
        catalog={catalog}
        spaces={spaceOpts}
        profiles={profileOpts}
        editable={editable}
        title={title}
        save={saveVersionAction.bind(null, v.id)}
        saveMulti={editable && !noEq ? saveMultiUnitAction.bind(null, v.id) : undefined}
        assistantVersionId={editable ? v.id : undefined}
        assistantAutoRun={editable && sp.ia === '1'}
        versionUpdatedAt={v.updatedAt.toISOString()}
        pdfUrl={can.viewPrices(u.role) ? `/cargas/${planId}/pdf?v=${v.version}` : undefined}
        mixed={mixed ? { ...mixed, defaultMode: TYPE_INFO[service].plannerMode, lockMode: noEq, autoOpen: noEq && sp.montar === '1', destination: shipment?.destinationCountry ?? null } : undefined}
        logistics={shipment?.mode ? resolveLogistics({ mode: shipment.mode, destination: shipment.destinationCountry }) : null}
        road={road}
        area={shipment?.area ?? null}
        planId={planId}
        mobileActions={
          (v.status === 'DRAFT' || v.status === 'IN_REVIEW') && can.approve(u.role) ? (
            <form action={approveAction.bind(null, v.id)}>
              <SubmitButton className="primary" pendingText="Aprovando…" disabled={v.criticalCount > 0} title={v.criticalCount > 0 ? 'Resolva os alertas críticos e salve antes de aprovar' : ''}>
                Aprovar V{v.version}
              </SubmitButton>
            </form>
          ) : v.status === 'DRAFT' && can.editPlans(u.role) ? (
            <form action={submitForReviewAction.bind(null, v.id)}>
              <SubmitButton pendingText="Enviando…">Enviar p/ revisão</SubmitButton>
            </form>
          ) : exportOp ? (
            // carga aprovada e pedido confirmado: o seguimento à mão no celular (confirmar fica no cabeçalho)
            <Link className="btn" href={`/exportacoes/${exportOp.id}`}>
              🚢 Seguimento
            </Link>
          ) : undefined
        }
        photoCount={(await db.select({ id: schema.loadPhotos.id }).from(schema.loadPhotos).where(eq(schema.loadPhotos.loadPlanId, planId))).length}
        expedition={{ version: v.version, status: v.status, mode: TYPE_INFO[service].label, transportCompany: plan.transportCompanyId ? await db.query.transportCompanies.findFirst({ where: eq(schema.transportCompanies.id, plan.transportCompanyId) }).then((c) => (c ? `${c.code} — ${c.name}` : null)) : null }}
        videoInfo={{ name: plan.name, customer: customer?.name ?? null, orderRef: shipment?.orderRef ? orderRefLabel(shipment.orderRef, shipment.area) : null, destination: shipment?.destinationCountry ?? null }}
      />

      <h2>Versões</h2>
      <table className="data">
        <thead>
          <tr>
            <th>Versão</th>
            <th>Status</th>
            <th>Equipamento</th>
            <th className="num">Paletes</th>
            <th className="num">Volumes</th>
            <th className="num">Unidades</th>
            <th className="num">Payload</th>
            <th className="num">Payload %</th>
            <th className="num">Bruto</th>
            <th className="num">CBM</th>
            <th className="num">Ocup. vol.</th>
            <th>Alertas</th>
            <th>Criada / editada</th>
            <th>Changelog</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((x) => (
            <tr key={x.id} style={x.id === v.id ? { background: '#f0f8f4' } : undefined}>
              <td>
                <Link href={`/cargas/${planId}?v=${x.version}`}>V{x.version}</Link>
              </td>
              <td>
                <span className={`badge ${x.status}`}>{STATUS_LABEL[x.status]}</span>
              </td>
              <td>{x.document.space.code}</td>
              <td className="num">{x.summary?.pallets ?? '—'}</td>
              <td className="num">{x.summary?.packages ?? '—'}</td>
              <td className="num">{x.summary?.units ?? '—'}</td>
              <td className="num">{kg(x.summary?.payloadKg)}</td>
              <td className="num">{pct(x.summary?.payloadPct)}</td>
              <td className="num">{kg(x.summary?.grossKg)}</td>
              <td className="num">{m3(x.summary?.cbmUnits)}</td>
              <td className="num">{pct(x.summary?.volumeUtilPct)}</td>
              <td>
                {x.criticalCount > 0 && <span className="badge CRITICAL">{x.criticalCount}</span>} {x.warningCount > 0 && <span className="badge WARNING">{x.warningCount}</span>}
              </td>
              <td>
                <small>
                  {uname(x.createdBy)} {dt(x.createdAt)}
                  <br />
                  {uname(x.updatedBy)} {dt(x.updatedAt)}
                </small>
              </td>
              <td style={{ whiteSpace: 'pre-line', fontSize: 12 }}>{x.changelog}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* fotos do carregamento: no fim — são registradas depois que o pedido foi faturado e enviado */}
      <div style={{ marginTop: 16 }}>
        <PhotosPanel
          planId={planId}
          approved={versions.some((x) => x.status === 'APPROVED')}
          editable={can.editPlans(u.role)}
          canUpload={can.uploadPhotos(u.role)}
          photos={(
            await db
              .select({ id: schema.loadPhotos.id, caption: schema.loadPhotos.caption, takenAt: schema.loadPhotos.takenAt, createdAt: schema.loadPhotos.createdAt, createdBy: schema.loadPhotos.createdBy, width: schema.loadPhotos.width, height: schema.loadPhotos.height, sizeBytes: schema.loadPhotos.sizeBytes })
              .from(schema.loadPhotos)
              .where(eq(schema.loadPhotos.loadPlanId, planId))
              .orderBy(asc(schema.loadPhotos.createdAt))
          ).map((p) => ({ ...p, takenAt: p.takenAt?.toISOString() ?? null, createdAt: p.createdAt.toISOString(), createdBy: p.createdBy != null ? uname(p.createdBy) : null }))}
        />
      </div>
    </>
  )
}

/** Cotações emitidas desta carga (cada PDF gerado registra o preço e os fatores usados). */
function QuoteHistory({ quotes }: { quotes: Awaited<ReturnType<typeof issuedQuotesView>> }) {
  return (
    <details className="panel no-print" style={{ marginBottom: 8 }}>
      <summary style={{ cursor: 'pointer' }}>
        <strong>Cotações emitidas</strong>{' '}
        <span className="muted">
          {quotes.length
            ? `(${quotes.length}) · última em ${dateBR(quotes[0].lastIssuedAt)} · USD ${(quotes[0].grandTotalUsd ?? quotes[0].totalUsd) != null ? (quotes[0].grandTotalUsd ?? quotes[0].totalUsd)!.toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '—'} · ${quotes[0].category ?? 'sem categoria'}`
            : '· nenhuma ainda — cada PDF do pedido gerado fica registrado aqui com o preço usado'}
        </span>
      </summary>
      {quotes.map((q) => (
        <QuoteRow key={q.id} q={q} />
      ))}
    </details>
  )
}
