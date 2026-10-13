import Link from 'next/link'
import { COMPANY, instagramUrl } from '@/lib/pdf/i18n'
import { notFound } from 'next/navigation'
import { dt, kg, m3, mm, nf0, pct, STATUS_LABEL } from '@/components/format'
import { PrintButton } from '@/components/PrintButton'
import { SEVERITY_LABEL, sortIssues } from '@/domain/issues'
import { loadGeometries, roadAxles, validateLoad } from '@/domain/load'
import { AXLE_GROUP_LABEL } from '@/domain/axles'
import { requireUser } from '@/lib/auth'
import { serviceOf, TYPE_INFO } from '@/domain/shipmentType'
import { loadPlanVersion } from '@/lib/planData'
import { canAccessPlan } from '@/lib/access'
import { productRank, rankOf } from '@/lib/catalog'
import { orderRefLabel } from '@/lib/orderRef'
import { palletTareBySku } from '@/domain/weights'
import { unitItems } from '@/domain/expedition'

export default async function ResumoPage({ params, searchParams }: PageProps<'/cargas/[id]/resumo'>) {
  const u = await requireUser()
  const { id } = await params
  const sp = await searchParams
  if (!(await canAccessPlan(u, Number(id)))) notFound()
  // Expedição: sempre a última versão aprovada
  const data = await loadPlanVersion(Number(id), Number(sp.v) || undefined, { approvedOnly: u.role === 'WAREHOUSE_VIEWER' })
  if (!data) notFound()
  const { plan, v, shipment, customer } = data
  const doc = v.document
  const { issues, summary: s } = validateLoad(doc)
  const axles = roadAxles(doc)
  // produtos na ordem única do catálogo
  const rank = await productRank()
  const tareBySku = palletTareBySku(doc)
  const bySku = [...s.bySku].sort((a, b) => rankOf(rank, a.sku) - rankOf(rank, b.sku))
  const geoms = loadGeometries(doc).sort((a, b) => a.box.min.x - b.box.min.x || a.box.min.y - b.box.min.y || a.box.min.z - b.box.min.z)
  const L = s.limits
  return (
    <>
      <div className="row no-print" style={{ marginBottom: 12 }}>
        <Link href={`/cargas/${plan.id}?v=${v.version}`}>← Voltar ao editor</Link>
        <span className="spacer" />
        <PrintButton />
      </div>
      <div className="panel">
        <h1 style={{ marginBottom: 4 }}>
          Export Summary — {plan.name} · V{v.version} <span className={`badge ${v.status}`}>{STATUS_LABEL[v.status]}</span>
        </h1>
        <p className="muted" style={{ marginTop: 0 }}>
          Cliente {customer?.name} · {shipment?.destinationCountry} · Incoterm {shipment?.incoterm} · {TYPE_INFO[serviceOf(shipment)].label}
          {shipment?.orderRef && ` · ${orderRefLabel(shipment.orderRef, shipment.area)}`} · gerado em {dt(new Date())} por {u.name}
        </p>
        <h2>Equipamento</h2>
        <table className="data compact">
          <tbody>
            <tr>
              <td>Equipamento</td>
              <td>
                {doc.space.code} — {doc.space.name} {doc.space.verification !== 'VERIFIED' && <span className="badge ESTIMATED">referência</span>}
              </td>
              <td>Interno (C×L×A)</td>
              <td className="num">
                {doc.space.inner.l} × {doc.space.inner.w} × {doc.space.inner.h} mm
              </td>
              <td>Porta</td>
              <td className="num">
                {doc.space.door.w} × {doc.space.door.h} mm
              </td>
            </tr>
            <tr>
              <td>Payload efetivo</td>
              <td>
                {kg(L.payloadKg.value)} <small className="muted">({L.payloadKg.source})</small>
              </td>
              <td>Bruto máx.</td>
              <td className="num">{kg(L.grossKg.value)}</td>
              <td>Tara equipamento</td>
              <td className="num">{kg(doc.space.tareKg)}</td>
            </tr>
          </tbody>
        </table>
        <h2>Totais</h2>
        <table className="data compact">
          <tbody>
            <tr>
              <td>Paletes</td>
              <td className="num">{s.pallets}</td>
              <td>Volumes</td>
              <td className="num">{s.packages}</td>
              <td>Unidades</td>
              <td className="num">{nf0.format(s.units)}</td>
            </tr>
            <tr>
              <td>Peso líquido</td>
              <td className="num">{kg(s.netKg)}</td>
              <td>Tara paletes</td>
              <td className="num">{kg(s.palletTareKg)}</td>
              <td>Peso bruto (c/ paletes)</td>
              <td className="num">
                {kg(s.payloadKg)} ({pct(s.payloadPct)})
              </td>
            </tr>
            <tr>
              <td>Peso c/ equipamento</td>
              <td className="num">{kg(s.grossKg)}</td>
              <td>CBM bultos</td>
              <td className="num">{m3(s.cbmUnits)}</td>
              <td>Ocupação volume / piso</td>
              <td className="num">
                {pct(s.volumeUtilPct)} / {pct(s.floorUtilPct)}
              </td>
            </tr>
            <tr>
              <td>Comprimento usado / livre</td>
              <td className="num">
                {mm(s.usedLengthMm)} / {mm(s.freeLengthMm)}
              </td>
              <td>CG longitudinal</td>
              <td className="num">{s.cg ? `${mm(s.cg.x)} (${pct(s.cgLongDevPct)})` : '—'}</td>
              <td>CG lateral / altura</td>
              <td className="num">{s.cg ? `${pct(s.cgLatDevPct)} / ${mm(s.cg.z)}` : '—'}</td>
            </tr>
          </tbody>
        </table>
        {axles && doc.road && (
          <>
            <h2>Carga por eixo</h2>
            <p className="muted" style={{ margin: '0 0 4px' }}>
              {[doc.road.tractor && `${doc.road.tractor.code} — ${doc.road.tractor.name}`, `${doc.road.carrier.code} — ${doc.road.carrier.name}`, doc.road.profile.name].filter(Boolean).join(' · ')}
            </p>
            <table className="data compact">
              <thead>
                <tr>
                  <th>Conjunto</th>
                  <th>Tipo</th>
                  <th className="num">Peso</th>
                  <th className="num">Limite</th>
                  <th className="num">%</th>
                </tr>
              </thead>
              <tbody>
                {axles.groups.map((g) => (
                  <tr key={g.key}>
                    <td>{g.label}</td>
                    <td>{AXLE_GROUP_LABEL[g.type]}</td>
                    <td className="num">{kg(g.kg)}</td>
                    <td className="num">{kg(g.limitKg)}</td>
                    <td className="num" style={{ color: g.status === 'over' ? '#d62728' : g.status === 'warn' ? '#b35f00' : undefined }}>{pct(g.pct)}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={2}>
                    <strong>PBTC</strong> (carga + taras)
                  </td>
                  <td className="num">{kg(axles.grossKg)}</td>
                  <td className="num">{kg(axles.grossLimitKg)}</td>
                  <td className="num" style={{ color: axles.grossStatus === 'over' ? '#d62728' : axles.grossStatus === 'warn' ? '#b35f00' : undefined }}>{pct(axles.grossPct)}</td>
                </tr>
              </tbody>
            </table>
          </>
        )}
        <h2>Packing list por SKU</h2>
        <table className="data compact">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Descrição</th>
              <th className="num">Volumes</th>
              <th className="num">Unidades</th>
              <th className="num">Líquido</th>
              <th className="num">Líq. c/ embalagem</th>
              <th className="num">Bruto (c/ palete)</th>
            </tr>
          </thead>
          <tbody>
            {bySku.map((l) => (
              <tr key={l.sku}>
                <td>{l.sku}</td>
                <td>{l.name}</td>
                <td className="num">{l.packages}</td>
                <td className="num">{nf0.format(l.units)}</td>
                <td className="num">{kg(l.netKg)}</td>
                <td className="num">{kg(l.grossKg)}</td>
                <td className="num">{kg(l.grossKg + (tareBySku.get(l.sku) ?? 0))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h2>Instrução de carregamento (ordem da frente para a porta)</h2>
        <table className="data compact">
          <thead>
            <tr>
              <th>#</th>
              <th>Unidade</th>
              <th>Conteúdo</th>
              <th className="num">x / y / z (mm)</th>
              <th className="num">C × L × A (mm)</th>
              <th className="num">Bruto</th>
            </tr>
          </thead>
          <tbody>
            {geoms.map((g, i) => (
              <tr key={g.unit.id}>
                <td>{i + 1}</td>
                <td>
                  {g.label}
                  {g.unit.kind === 'PALLET' && g.unit.yaw && <small className="muted"> (girado)</small>}
                </td>
                {/* kits em caixas coletivas: kits e o tipo de caixa (como na expedição), nunca só o nº de caixas */}
                <td>{unitItems(doc, g).map((l) => (l.box ? `${l.sku} × ${l.units} kits (${l.boxes} × ${l.box})` : `${l.sku} × ${l.boxes}`)).join(', ')}</td>
                <td className="num">
                  {g.box.min.x} / {g.box.min.y} / {g.box.min.z}
                </td>
                <td className="num">
                  {g.box.size.x} × {g.box.size.y} × {g.box.size.z}
                </td>
                <td className="num">{kg(g.grossKg)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h2>Alertas</h2>
        {issues.length === 0 ? (
          <p>Sem alertas.</p>
        ) : (
          <ul className="issues" style={{ maxHeight: 'none' }}>
            {sortIssues(issues).map((i, k) => (
              <li key={k}>
                <span className={`badge ${i.severity}`}>{SEVERITY_LABEL[i.severity]}</span> {i.message}
              </li>
            ))}
          </ul>
        )}
        {v.changelog && (
          <>
            <h2>Changelog</h2>
            <p style={{ whiteSpace: 'pre-line' }}>{v.changelog}</p>
          </>
        )}
        {/* redes sociais (discreto, no fim da página impressa) */}
        <p className="muted" style={{ marginTop: 24, fontSize: 11, textAlign: 'center' }}>
          Siga a Pacifil no Instagram:{' '}
          {COMPANY.instagram.map((h, k) => (
            <span key={h}>
              {k > 0 && ' · '}
              <a href={instagramUrl(h)} target="_blank" rel="noopener noreferrer">
                @{h}
              </a>
            </span>
          ))}
        </p>
      </div>
    </>
  )
}
