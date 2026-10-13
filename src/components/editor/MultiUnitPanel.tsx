'use client'

import { useMemo } from 'react'
import { validateLoad } from '@/domain/load'
import { freeCapacity, groupsOfDoc } from '@/domain/multiUnit'
import type { LoadDoc } from '@/domain/types'
import { unitNoun } from '@/lib/units'
import { kg, nf0, pct } from '../format'

interface Props {
  docs: LoadDoc[]
  notes: string[]
  view: number
  busy: boolean
  canSave: boolean
  onView: (i: number) => void
  onApply: () => void
  onCancel: () => void
}

/**
 * Proposta de pedido em várias unidades (contêineres/veículos): resumo de cada uma, alternar o 3D
 * entre elas e gravar TODAS juntas (ou nenhuma). A 1ª substitui a versão aberta; as demais viram
 * novas cargas do mesmo pedido.
 */
export function MultiUnitPanel({ docs, notes, view, busy, canSave, onView, onApply, onCancel }: Props) {
  const rows = useMemo(
    () =>
      docs.map((d) => {
        const { issues, summary } = validateLoad(d)
        const skus = new Map<string, number>()
        for (const l of summary.bySku) skus.set(l.sku, (skus.get(l.sku) ?? 0) + l.units)
        return { s: summary, critical: issues.filter((i) => i.severity === 'CRITICAL').length, skus: [...skus].map(([k, n]) => `${k} ${nf0.format(n)} un.`).join(' · ') }
      }),
    [docs],
  )
  // o que ainda cabe na última (mesmas montagens do pedido): base para completar ou reduzir
  const free = useMemo(() => {
    const all = docs.flatMap((d) => groupsOfDoc(d).pallets)
    const seen = new Set<string>()
    const groups = all.filter((g) => !seen.has(g.key) && seen.add(g.key))
    return freeCapacity(docs[docs.length - 1], groups)
  }, [docs])
  const noun = unitNoun(docs[0].space)
  const tot = rows.reduce((a, r) => ({ pallets: a.pallets + r.s.pallets, payload: a.payload + r.s.payloadKg }), { pallets: 0, payload: 0 })
  const lastPct = rows[rows.length - 1].s.payloadPct
  return (
    <div className="panel no-print" style={{ marginBottom: 12, borderColor: 'var(--brand)', background: '#f6fbf8' }}>
      <div className="row">
        <strong>
          Proposta: pedido em {docs.length} {noun === 'Contêiner' ? 'contêineres' : noun === 'Veículo' ? 'veículos' : 'ULDs'}
        </strong>
        <small className="muted">1º o mais cheio possível, remanente no último · total {nf0.format(tot.pallets)} paletes · {kg(tot.payload)} · nada foi salvo ainda</small>
      </div>
      <table className="data compact" style={{ marginTop: 6 }}>
        <thead>
          <tr>
            <th>Unidade</th>
            <th>Equip.</th>
            <th className="num">Paletes</th>
            <th className="num">Caixas soltas</th>
            <th className="num">Payload</th>
            <th className="num">Payload %</th>
            <th className="num">Piso</th>
            <th>Produtos</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={i === view ? { background: '#e4f3ec' } : undefined}>
              <td>
                <strong>
                  {noun} {i + 1}
                </strong>
                {i === 0 && <small className="muted"> (esta carga)</small>}
                {r.critical > 0 && <span className="badge CRITICAL" style={{ marginLeft: 4 }}>{r.critical}</span>}
              </td>
              <td>{docs[i].space.code}</td>
              <td className="num">{nf0.format(r.s.pallets)}</td>
              <td className="num">{nf0.format(r.s.looseUnits)}</td>
              <td className="num">{kg(r.s.payloadKg)}</td>
              <td className="num">{pct(r.s.payloadPct)}</td>
              <td className="num">{pct(r.s.floorUtilPct)}</td>
              <td style={{ fontSize: 11 }}>{r.skus}</td>
              <td>
                <button className={`small ${i === view ? 'active' : ''}`} onClick={() => onView(i)}>
                  {i === view ? 'No 3D' : 'Ver no 3D'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 12, marginTop: 6 }}>
        <strong>
          Espaço livre no {noun.toLowerCase()} {docs.length}:
        </strong>{' '}
        {lastPct != null && `${pct(100 - lastPct)} do payload`}
        {free.payloadFreeKg != null && ` (${kg(free.payloadFreeKg)})`}
        {free.morePallets.some((m) => m.count > 0) && ` · ainda cabem ${free.morePallets.filter((m) => m.count > 0).map((m) => `${m.count} × ${m.name}`).join(' ou ')}`}
        <div className="muted">Alternativas para o cliente: completar o último com mais mercadoria, reduzir o pedido para usar menos unidades, ou enviar o último parcialmente carregado.</div>
        {notes.map((n, i) => (
          <div key={i} className="alert warn" style={{ margin: '4px 0 0', padding: '4px 8px' }}>
            {n}
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="primary" disabled={busy || !canSave} onClick={onApply} title="Grava todas as unidades juntas: se algo falhar, nada é alterado">
          {busy ? 'Gravando…' : `Aplicar e salvar as ${docs.length} unidades`}
        </button>
        <button className="danger" disabled={busy} onClick={onCancel}>
          Cancelar
        </button>
        {!canSave && <small className="muted">Só é possível numa versão em rascunho.</small>}
      </div>
    </div>
  )
}
