'use client'

import { useState } from 'react'
import { analyzeSpread, SpreadAnalysis } from '@/domain/spread'
import type { LoadDoc } from '@/domain/types'
import { kg, mm, nf0, nf1 } from '../format'

/**
 * "Ocupar espaço disponível": mesma mercadoria em mais paletes (menos caixas por palete), sem mudar
 * produtos, quantidades nem equipamento. Mostra as alternativas; a escolhida aparece no 3D como
 * prévia e só muda a carga ao aplicar.
 */
export function SpreadPanel({ doc, onPreview, onApply }: { doc: LoadDoc; onPreview: (d: LoadDoc | null) => void; onApply: (d: LoadDoc) => void }) {
  const [busy, setBusy] = useState(false)
  const [a, setA] = useState<SpreadAnalysis | null>(null)
  const [sel, setSel] = useState<number | null>(null)

  function run() {
    setBusy(true)
    // deixa a tela mostrar "calculando" antes do cálculo (síncrono)
    setTimeout(() => {
      const r = analyzeSpread(doc)
      setA(r)
      setSel(r.best)
      onPreview(r.best != null ? r.options[r.best].doc : null)
      setBusy(false)
    }, 30)
  }
  function close() {
    setA(null)
    setSel(null)
    onPreview(null)
  }

  if (!a)
    return (
      <>
        <button onClick={run} disabled={busy} style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} title="Mesma mercadoria em mais paletes com menos caixas cada um, para ocupar o piso livre (quando a carga está limitada por peso). Produtos, quantidades e equipamento não mudam.">
          {busy ? 'Calculando…' : '↔ Ocupar espaço disponível'}
        </button>
      </>
    )

  const o = sel != null ? a.options[sel] : null
  return (
    <div className="panel" style={{ marginTop: 8, borderColor: 'var(--brand)', background: '#f7faf8' }}>
      <strong>Ocupar espaço disponível</strong>
      <div className="muted" style={{ fontSize: 12, margin: '2px 0 6px' }}>
        Hoje: {a.current.pallets} paletes · piso {nf1.format(a.current.floorPct)}% · altura até {mm(a.current.maxHeightMm)}
      </div>
      {a.reason ? (
        <div className="alert warn" style={{ margin: 0 }}>{a.reason}</div>
      ) : (
        <table className="data compact" style={{ fontSize: 12, width: "100%" }}>
          <thead>
            <tr>
              <th />
              <th className="num">Pal.</th>
              <th className="num">Piso</th>
              <th className="num" title="altura máxima dos paletes">Alt.</th>
              <th className="num">Tara +</th>
            </tr>
          </thead>
          <tbody>
            {a.options.map((x, i) => (
              <tr key={x.pallets} style={{ cursor: 'pointer', background: sel === i ? '#e4f3ec' : undefined }} onClick={() => (setSel(i), onPreview(x.doc))}>
                <td>
                  <input type="radio" checked={sel === i} readOnly title={i === a.best ? "recomendada" : undefined} />{i === a.best && <span style={{ color: '#2a7d4f' }}> ★</span>}
                </td>
                <td className="num">{x.pallets}</td>
                <td className="num">{nf1.format(x.floorPct)}%</td>
                <td className="num">{nf1.format(x.maxHeightMm / 1000)} m</td>
                <td className="num">{kg(x.extraTareKg)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {o && (
        <div style={{ fontSize: 12, marginTop: 6 }}>
          {o.perProduct.map((p) => (
            <div key={p.sku}>
              • <strong>{p.sku}</strong>: {p.pallets} paletes de {p.boxesPerPallet} caixas
            </div>
          ))}
          <div className="muted" style={{ marginTop: 4 }}>
            Payload {kg(o.payloadKg)}
            {o.payloadPct != null && ` (${nf1.format(o.payloadPct)}%)`} — a tara dos {nf0.format(o.pallets - a.current.pallets)} paletes a mais já está somada. {o.quadrantsOk ? 'Distribuição de peso dentro da regra.' : '⚠ Distribuição de peso fora da regra nesta alternativa.'}
          </div>
        </div>
      )}
      <small className="muted" style={{ display: 'block', marginTop: 6 }}>
        ★ = recomendada (o máximo de paletes que cabe no piso). Só paletes de um produto (com seus acompanhantes, ex.: KIT-HF); camadas inteiras; tudo no piso. {a.mixedKept > 0 && `${a.mixedKept} palete(s) misto(s) ficam como estão. `}Nunca mistura produtos. A prévia aparece no 3D.
      </small>
      <div className="row" style={{ marginTop: 8, gap: 6 }}>
        {o && (
          <button
            className="primary"
            onClick={() => {
              onApply(o.doc)
              setA(null)
              setSel(null)
            }}
          >
            ✔ Aplicar {o.pallets} paletes
          </button>
        )}
        <button onClick={close}>{o ? 'Cancelar' : 'Fechar'}</button>
      </div>
    </div>
  )
}
