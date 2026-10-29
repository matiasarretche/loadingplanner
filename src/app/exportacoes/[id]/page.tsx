import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { ReactNode } from 'react'
import { Avatar } from '@/components/Avatar'
import { Icon } from '@/components/Icons'
import { kg, m3, nf0, nf1 } from '@/components/format'
import { EXPORT_PIPELINE, EXPORT_STATUS_LABEL, EXPORT_STATUS_SHORT, fmtDate, isActiveStatus, reached, todayBR, trackingSituation } from '@/domain/exportTracking'
import { TYPE_INFO } from '@/domain/shipmentType'
import { requireUser } from '@/lib/auth'
import { flagUrl } from '@/lib/countries'
import { trackingDetail } from '@/lib/exportTracking'
import { placeLabels } from '@/lib/places'
import { canSeeExports } from '@/lib/roles'
import type { ExportDetail, TrackingValues } from '../types'
import { dias, fmtInstant, usd } from './fmt'
import { History } from './History'
import { SummaryButton } from './SummaryButton'
import { TrackingForm } from './TrackingForm'
import { UndoButton } from './UndoButton'
import { UnsavedTrackingProvider } from './UnsavedTracking'

/**
 * SEGUIMENTO DE UMA EXPORTAÇÃO (uma carga = um contêiner/caminhão com pedido confirmado).
 * Cabeçalho com etapa, alertas e links (carga, outras cargas do pedido); dados do pedido LIDOS da carga
 * (última versão aprovada — nada é copiado); formulário do seguimento; histórico de alterações.
 */

const VALUE_SOURCE: Record<NonNullable<ExportDetail['value']>['source'], string> = {
  frozen: 'congelado na aprovação',
  live: 'calculado agora com a tabela vigente',
  legacy: 'preços antigos guardados na carga',
}

export default async function ExportacaoPage({ params }: PageProps<'/exportacoes/[id]'>) {
  const u = await requireUser()
  if (!canSeeExports(u))
    return (
      <div className="panel">
        <h1>Exportações em curso</h1>
        <p className="muted">Disponível só para usuários da área de Exportação.</p>
      </div>
    )
  const { id } = await params
  const opId = Number(id)
  if (!Number.isInteger(opId) || opId <= 0) notFound()
  const d = await trackingDetail(opId, u)
  if (!d) notFound()

  const today = todayBR()
  const sit = trackingSituation(d, today)
  // eventos: mais recente primeiro → a confirmação é a última 'confirm' da lista
  const confirmEvent = d.events.findLast((e) => e.kind === 'confirm')
  const confirmedBy = confirmEvent?.userName ?? null
  const flag = flagUrl(d.country)
  const placeMode = TYPE_INFO[d.service].placeMode
  // remonta o formulário só quando os DADOS mudam: o resumo gerado/enviado entra no histórico (e o botão dá
  // router.refresh) sem descartar o que foi digitado e não salvo
  const lastDataEvent = d.events.find((e) => e.kind !== 'summary' && e.kind !== 'summary_sent')
  const formVersion = `${d.updatedAt}|${lastDataEvent?.id ?? 0}|${d.originPlace ?? ''}|${d.destinationPlace ?? ''}`
  const initial: TrackingValues = {
    status: d.status,
    delayed: d.delayed,
    incident: d.incident,
    confirmedAt: d.confirmedAt,
    paymentReceivedAt: d.paymentReceivedAt,
    responsibleUserId: d.responsibleUserId,
    carrier: d.carrier,
    forwarder: d.forwarder,
    bookingNumber: d.bookingNumber,
    containerNumber: d.containerNumber,
    sealNumber: d.sealNumber,
    blNumber: d.blNumber,
    vessel: d.vessel,
    voyage: d.voyage,
    plannedLoadingDate: d.plannedLoadingDate,
    actualLoadingDate: d.actualLoadingDate,
    etd: d.etd,
    atd: d.atd,
    transitDays: d.transitDays,
    eta: d.eta,
    ata: d.ata,
    deliveredAt: d.deliveredAt,
    currentLocation: d.currentLocation,
    trackingStatus: d.trackingStatus,
    notes: d.notes,
    originPlace: d.originPlace,
    destinationPlace: d.destinationPlace,
  }

  return (
    <UnsavedTrackingProvider>
      <div className="row no-print" style={{ marginBottom: 8 }}>
        <Link href="/exportacoes">← Exportações</Link>
        <span className="spacer" />
        <Link className="btn small" href={`/cargas/${d.loadPlanId}`}>
          Ver carga
        </Link>
        <SummaryButton operationId={d.id} country={d.country} orderRef={d.orderRef} siblingOps={d.siblings.filter((s) => s.operationId != null).length} />
        {d.canUndo && <UndoButton id={d.id} />}
      </div>

      {/* cabeçalho: pedido, cliente, etapa e alertas */}
      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <h1 style={{ margin: 0, overflowWrap: 'anywhere' }}>{d.orderRef ?? d.planName}</h1>
            <div className="muted" style={{ marginTop: 2 }}>
              {d.orderRef ? d.planName : 'sem proforma'}
              {d.unitIndex != null && ` · unidade ${d.unitIndex}/${d.unitCount}`}
            </div>
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <strong>{d.customer}</strong>
              <span className="dash-country">
                {flag ? <span className="flag" style={{ backgroundImage: `url(${flag})` }} aria-hidden /> : <Icon name="globe" size={14} />}
                {d.country}
              </span>
              <span className={`pill exp-${d.status}`}>{EXPORT_STATUS_LABEL[d.status]}</span>
              {sit.late && <span className="pill exp-late">Atrasado</span>}
              {d.incident && (
                <span className="pill exp-incident" title={d.incident}>
                  Incidência
                </span>
              )}
            </div>
          </div>
          <div style={{ flex: '0 1 auto', fontSize: 13 }}>
            <div className="row" style={{ gap: 6 }}>
              <small>Responsável:</small>
              {d.responsibleName ? (
                <span className="dash-user">
                  <Avatar avatar={d.responsibleAvatar} name={d.responsibleName} size={22} />
                  {d.responsibleName}
                </span>
              ) : (
                <span className="muted">—</span>
              )}
            </div>
            <div className="muted" style={{ marginTop: 4 }}>
              Atualizado {d.updatedByName ? `por ${d.updatedByName} ` : ''}em {fmtInstant(d.updatedAt)}
            </div>
          </div>
        </div>

        {(sit.alerts.length > 0 || sit.soonToLoad || sit.soonToArrive) && (
          <ul style={{ margin: '10px 0 0', paddingLeft: 18 }}>
            {sit.alerts.map((a) => (
              <li key={a.kind} className="exp-alert">
                {a.text}
              </li>
            ))}
            {sit.soonToLoad && sit.daysToLoading != null && <li className="exp-soon">Próxima a carregar ({sit.daysToLoading === 0 ? 'hoje' : `em ${dias(sit.daysToLoading)}`})</li>}
            {sit.soonToArrive && sit.daysToArrival != null && <li className="exp-soon">Próxima a chegar ({sit.daysToArrival === 0 ? 'hoje' : `em ${dias(sit.daysToArrival)}`})</li>}
          </ul>
        )}
        {d.incident && (
          <div style={{ marginTop: 8, fontSize: 13, whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>
            <strong style={{ color: '#9a3412' }}>Incidência:</strong> {d.incident}
          </div>
        )}
        <div className="muted" style={{ marginTop: 8, fontSize: 13 }}>
          Pedido confirmado em {fmtDate(d.confirmedAt)}
          {confirmedBy && ` por ${confirmedBy}`} ·{' '}
          {d.paymentReceivedAt ? `pagamento recebido em ${fmtDate(d.paymentReceivedAt)}` : <span style={{ fontStyle: 'italic' }}>Pagamento não informado</span>}
        </div>

        {d.status === 'CANCELLED' ? (
          <div className="muted" style={{ marginTop: 10, background: '#f3f4f6', borderRadius: 6, padding: '8px 10px' }}>
            Operação cancelada{d.closedAt ? ` em ${fmtInstant(d.closedAt)}` : ''} — fora da sequência de etapas (está no Histórico).
            {d.canEdit && ' Para reabrir, escolha outra etapa em “Status” e salve.'}
          </div>
        ) : (
          <div className="exp-steps" aria-label="Etapas" style={{ marginTop: 10 }}>
            {EXPORT_PIPELINE.map((s, i) => {
              const current = s === d.status
              const done = !current && reached(d.status, s)
              return (
                <div key={s} className={`exp-step${current ? ' current' : done ? ' done' : ''}`} title={EXPORT_STATUS_LABEL[s]} aria-current={current ? 'step' : undefined}>
                  {done ? '✓ ' : `${i + 1}. `}
                  {EXPORT_STATUS_SHORT[s]}
                </div>
              )
            })}
          </div>
        )}

        {d.siblings.length > 0 && (
          <div className="row no-print" style={{ gap: 6, marginTop: 10 }}>
            <small>Outras cargas do pedido:</small>
            {d.siblings.map((s) =>
              s.operationId != null ? (
                <Link key={s.loadPlanId} className="btn small" href={`/exportacoes/${s.operationId}`} title={`${s.planName} — seguimento`}>
                  Unidade {s.unitIndex}
                  {s.status && <span className={`pill exp-${s.status}`}>{EXPORT_STATUS_SHORT[s.status]}</span>}
                </Link>
              ) : (
                <Link key={s.loadPlanId} className="btn small" href={`/cargas/${s.loadPlanId}`} title={`${s.planName} — abrir a carga`}>
                  Unidade {s.unitIndex}
                  <span className="muted">{s.hasApproved ? 'não confirmada' : 'sem versão aprovada'}</span>
                </Link>
              ),
            )}
          </div>
        )}
      </div>

      {d.newerApprovedThanConfirmed && (
        <div className="alert warn">
          A carga tem uma versão aprovada mais nova que a confirmada; os dados abaixo já mostram a versão vigente.
          {d.confirmedVersion != null && d.approvedVersion && ` (Confirmada na V${d.confirmedVersion}; vigente: V${d.approvedVersion.version}.)`}
        </div>
      )}

      <OrderPanel d={d} confirmedBy={confirmedBy} />

      <section className="panel" style={{ marginBottom: 12 }}>
        <h2 style={{ marginTop: 0 }}>Seguimento</h2>
        <TrackingForm
          id={d.id}
          version={formVersion}
          today={today}
          canEdit={d.canEdit}
          initial={initial}
          fieldSources={d.fieldSources}
          users={d.users}
          responsibleName={d.responsibleName}
          siblingsWithOps={d.siblings.filter((s) => s.operationId != null && s.status != null && isActiveStatus(s.status)).length}
          closedSiblings={d.siblings.filter((s) => s.operationId != null && s.status != null && !isActiveStatus(s.status)).length}
          multiUnit={d.unitCount > 1}
          transportCompany={d.transportCompany}
          places={placeLabels(placeMode)}
          tracking={{ lastUpdate: d.lastTrackingUpdate, provider: d.trackingProvider, ref: d.trackingRef }}
        />
      </section>

      <section className="panel">
        <h2 style={{ marginTop: 0 }}>Histórico</h2>
        <History events={d.events} />
      </section>
    </UnsavedTrackingProvider>
  )
}

/** Dados do pedido, somente leitura: vêm da carga e da última versão aprovada (nada é copiado). */
function OrderPanel({ d, confirmedBy }: { d: ExportDetail; confirmedBy: string | null }) {
  const sum = d.products.reduce((a, p) => ({ boxes: a.boxes + p.boxes, units: a.units + p.units, netKg: a.netKg + p.netKg, grossKg: a.grossKg + p.grossKg }), { boxes: 0, units: 0, netKg: 0, grossKg: 0 })
  const flag = flagUrl(d.country)
  return (
    <section className="panel" style={{ marginBottom: 12 }}>
      <div className="row" style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }}>Pedido</h2>
        <small>
          dados da carga (somente leitura) — para alterar, abra a <Link href={`/cargas/${d.loadPlanId}`}>carga</Link>
        </small>
      </div>
      <div className="form-grid">
        <Info k="Cliente">{d.customer}</Info>
        <Info k="País">
          <span className="dash-country">
            {flag ? <span className="flag" style={{ backgroundImage: `url(${flag})` }} aria-hidden /> : <Icon name="globe" size={14} />}
            {d.country}
          </span>
        </Info>
        <Info k="Proforma">{d.orderRef ?? '—'}</Info>
        <Info k="Incoterm">{d.incoterm || '—'}</Info>
        <Info k="CFOP">{d.cfop ?? <span className="muted">não informado</span>}</Info>
        <Info k="Condição de pagamento">{d.paymentTerms ?? <span className="muted">não informada</span>}</Info>
        <Info k="Transporte / serviço">{TYPE_INFO[d.service].label}</Info>
        <Info k="Equipamento">{d.equipment ? (d.equipment.name && d.equipment.name !== d.equipment.code ? `${d.equipment.code} — ${d.equipment.name}` : d.equipment.code) : '—'}</Info>
        <Info k="Transportadora (ERP)">{d.transportCompany ?? <span className="muted">a definir</span>}</Info>
        <Info k="Agente">{d.agentName ?? '—'}</Info>
        <Info k="Carga criada por">{d.loadCreatedByName ?? '—'}</Info>
        <Info k="Confirmado em">
          {fmtDate(d.confirmedAt)}
          {confirmedBy && <span className="muted"> por {confirmedBy}</span>}
        </Info>
        <Info k="Versão aprovada">
          {d.approvedVersion ? (
            <>
              <Link href={`/cargas/${d.loadPlanId}?v=${d.approvedVersion.version}`}>V{d.approvedVersion.version}</Link>
              <span className="muted">
                {d.approvedVersion.approvedByName && ` · ${d.approvedVersion.approvedByName}`}
                {d.approvedVersion.approvedAt && ` · ${fmtInstant(d.approvedVersion.approvedAt)}`}
              </span>
            </>
          ) : (
            'sem versão aprovada'
          )}
        </Info>
      </div>

      {d.value && (
        <>
          <h3>
            Valor <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>· {VALUE_SOURCE[d.value.source]}</span>
          </h3>
          <div className="kpis">
            <Kpi k="Mercadoria" v={usd(d.value.goodsUsd)} />
            <Kpi k="Frete" v={d.value.freightUsd ? usd(d.value.freightUsd) : '—'} />
            <Kpi k="Seguro" v={d.value.insuranceUsd ? usd(d.value.insuranceUsd) : '—'} />
            <Kpi k={`Total (${d.incoterm || 'USD'})`} v={usd(d.value.totalUsd)} />
          </div>
        </>
      )}

      <h3>Produtos</h3>
      {d.products.length ? (
        <table className="data">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Descrição</th>
              <th className="num">Caixas</th>
              <th className="num">Unidades</th>
              <th className="num">Líquido (kg)</th>
              <th className="num">Bruto (kg)</th>
            </tr>
          </thead>
          <tbody>
            {d.products.map((p) => (
              <tr key={p.sku}>
                <td style={{ whiteSpace: 'nowrap' }}>{p.sku}</td>
                <td>{p.name}</td>
                <td className="num">{nf0.format(p.boxes)}</td>
                <td className="num">{nf0.format(p.units)}</td>
                <td className="num">{nf1.format(p.netKg)}</td>
                <td className="num">{nf1.format(p.grossKg)}</td>
              </tr>
            ))}
          </tbody>
          {d.products.length > 1 && (
            <tfoot>
              <tr style={{ fontWeight: 600 }}>
                <td colSpan={2}>Total</td>
                <td className="num">{nf0.format(sum.boxes)}</td>
                <td className="num">{nf0.format(sum.units)}</td>
                <td className="num">{nf1.format(sum.netKg)}</td>
                <td className="num">{nf1.format(sum.grossKg)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      ) : (
        <p className="muted">{d.approvedVersion ? 'Nenhum produto na versão aprovada.' : 'A carga não tem versão aprovada.'}</p>
      )}

      {d.totals && (
        <div className="kpis" style={{ marginTop: 12 }}>
          <Kpi k="Paletes" v={nf0.format(d.totals.pallets)} />
          <Kpi k="Volumes" v={nf0.format(d.totals.packages)} />
          <Kpi k="Peso líquido" v={kg(d.totals.netKg)} />
          <Kpi k="Peso bruto" v={kg(d.totals.payloadKg)} s="com paletes" />
          {d.totals.grossKg > d.totals.payloadKg && <Kpi k="Bruto c/ equipamento" v={kg(d.totals.grossKg)} s="tara incluída" />}
          <Kpi k="Volume" v={m3(d.totals.cbm)} />
        </div>
      )}
    </section>
  )
}

function Info({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <small style={{ display: 'block', fontSize: 12 }}>{k}</small>
      <div style={{ overflowWrap: 'anywhere' }}>{children}</div>
    </div>
  )
}

function Kpi({ k, v, s }: { k: string; v: string; s?: string }) {
  return (
    <div className="kpi">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {s && <div className="s">{s}</div>}
    </div>
  )
}
