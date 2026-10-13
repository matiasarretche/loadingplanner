'use client'

import { DEFAULT_QUADRANT_RULES, Quadrant, QuadrantEvaluation } from '@/domain/quadrants'
import { kg, nf1 } from '../format'

/** Escala do medidor: % do peso total na metade TRASEIRA. */
const MIN = 45, MAX = 55
const pos = (v: number) => `${((Math.min(MAX, Math.max(MIN, v)) - MIN) / (MAX - MIN)) * 100}%`

export const ZONE_TEXT = {
  ideal: { icon: '✓', text: 'Dentro do recomendado: 1–2 p.p. a mais na traseira.', color: '#2a7d4f' },
  ok: { icon: '✓', text: 'Equilibrada. Ideal: até 1 p.p. a mais na traseira.', color: '#2a7d4f' },
  front: { icon: '⚠', text: 'Mais peso na FRENTE (norte, cabine). Use “Distribuir peso”.', color: '#d62728' },
  rear: { icon: '⚠', text: 'Traseira acima do recomendado (máx. 51%).', color: '#b35f00' },
} as const

/**
 * Distribuição de peso: FRENTE (norte, cabine) × TRASEIRA (sul, sobre os eixos traseiros) num medidor
 * com a faixa recomendada (traseira 50,5–51%), o equilíbrio lateral (oeste × leste) e os quadrantes.
 */
export function WeightBalance({ e, kgs }: { e: QuadrantEvaluation; kgs: Record<Quadrant, number> }) {
  const R = DEFAULT_QUADRANT_RULES
  const p = e.shares.pct
  const west = p.NO + p.SO, east = p.NE + p.SE
  const z = ZONE_TEXT[e.zone]
  const latDiff = Math.abs(west - east)
  return (
    <div className="wb">
      <div className="wb-split">
        <div>
          <small>FRENTE · norte (cabine)</small>
          <strong style={{ color: e.zone === 'front' ? '#d62728' : undefined }}>{nf1.format(e.frontPct)}%</strong>
        </div>
        <div style={{ textAlign: 'right' }}>
          <small>TRASEIRA · sul / eixos</small>
          <strong style={{ color: e.zone === 'rear' ? '#b35f00' : e.zone === 'ideal' ? '#2a7d4f' : undefined }}>{nf1.format(e.rearPct)}%</strong>
        </div>
      </div>
      {/* medidor: % na traseira, de 45 a 55; faixa ideal em verde, uniforme em verde-claro */}
      <div className="wb-gauge" title={`Traseira ${nf1.format(e.rearPct)}% · recomendado ${nf1.format(R.rearIdealMinPct)}–${nf1.format(R.rearMaxPct)}%`}>
        <div className="wb-zone front" style={{ left: 0, width: pos(R.rearMinPct) }} />
        <div className="wb-zone okz" style={{ left: pos(R.rearMinPct), width: `calc(${pos(R.rearIdealMinPct)} - ${pos(R.rearMinPct)})` }} />
        <div className="wb-zone ideal" style={{ left: pos(R.rearIdealMinPct), width: `calc(${pos(R.rearMaxPct)} - ${pos(R.rearIdealMinPct)})` }} />
        <div className="wb-zone rear" style={{ left: pos(R.rearMaxPct), right: 0 }} />
        <div className="wb-mid" style={{ left: pos(50) }} />
        <div className="wb-mark" style={{ left: pos(e.rearPct), borderTopColor: z.color }} />
      </div>
      <div className="wb-scale">
        <span>← mais na frente</span>
        <span>50/50</span>
        <span>mais atrás →</span>
      </div>
      <div style={{ fontSize: 12, color: z.color, marginTop: 4 }}>
        {z.icon} {z.text}
      </div>
      <div className="wb-lat">
        Lateral: oeste {nf1.format(west)}% · leste {nf1.format(east)}%
        {latDiff > 4 && <span style={{ color: '#b35f00' }}> · ⚠ diferença de {nf1.format(latDiff)} p.p.</span>}
      </div>
      <details style={{ marginTop: 4 }}>
        <summary className="muted" style={{ fontSize: 12, cursor: 'pointer' }}>
          Quadrantes
        </summary>
        <div className="quad-head">
          <span>▲ NORTE / FRENTE (cabine)</span>
        </div>
        <div className="quad-grid">
          {(['NO', 'NE', 'SO', 'SE'] as Quadrant[]).map((q) => (
            <div key={q}>
              {q}
              <strong>{nf1.format(p[q])}%</strong>
              <small className="muted">{kg(kgs[q])}</small>
            </div>
          ))}
        </div>
        <div className="quad-head">
          <span>SUL / TRASEIRA ▼</span>
        </div>
      </details>
      <small className="muted" style={{ display: 'block', marginTop: 4 }}>
        Regra: o mais uniforme possível; havendo diferença, 1–2 p.p. a mais na traseira (ex.: 49% / 51%); nunca mais peso na frente. Critério operacional — os limites por eixo têm prioridade.
      </small>
    </div>
  )
}
