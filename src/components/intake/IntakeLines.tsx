'use client'

import { IntakeLine, QTY_UNIT_LABEL, QtyUnit, unitsFor } from '@/domain/intake'

export type IntakeRow = IntakeLine & { key: string }
export interface IntakeCatalogItem {
  sku: string
  name: string
  unitsPerPackage: number
  netKg: number
}

let seq = 0
export const intakeKey = () => `l${++seq}`
export const toRows = (lines: IntakeLine[]): IntakeRow[] => lines.map((l) => ({ ...l, key: intakeKey() }))

const nf = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 })
const lacking = (ok: boolean) => (ok ? undefined : { borderColor: '#d62728', background: '#fff5f5' })

/** Linha pronta: produto do catálogo, quantidade e unidade definidas. */
export const rowReady = (l: IntakeRow) => Boolean(l.sku && l.quantity && l.quantity > 0 && l.unit !== 'OTHER')

/**
 * Revisão das linhas do pedido do cliente: texto original, produto do catálogo (identificado, ou opções
 * quando ambíguo — nunca escolhido pela IA), quantidade/unidade e conversão em unidades.
 */
export function IntakeLines({ lines, setLines, catalog, compact }: { lines: IntakeRow[]; setLines: (fn: (ls: IntakeRow[]) => IntakeRow[]) => void; catalog: IntakeCatalogItem[]; compact?: boolean }) {
  const setLine = (key: string, patch: Partial<IntakeRow>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  return (
    <>
      <table className="data compact intake-lines">
        <thead>
          <tr>
            <th>#</th>
            <th>Pedido do cliente</th>
            <th>Produto do catálogo</th>
            <th>Quantidade</th>
            <th>Unidades</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            const pack = l.sku ? catalog.find((c) => c.sku === l.sku) : undefined
            const conv = pack && l.quantity ? unitsFor(l.quantity, l.unit, pack) : null
            const suggested = l.candidates.filter((c) => catalog.some((x) => x.sku === c.sku))
            const needsChoice = l.status !== 'MATCHED' && !l.sku
            return (
              <tr key={l.key} className={needsChoice ? 'row-warn' : undefined}>
                <td>{i + 1}</td>
                <td style={{ maxWidth: compact ? 200 : 260 }}>
                  {l.sourceText}
                  {l.unitText && <small className="muted"> · “{l.unitText}”</small>}
                  {l.note && <div style={{ fontSize: 11, color: '#b35f00' }}>⚠ {l.note}</div>}
                </td>
                <td>
                  <select value={l.sku ?? ''} onChange={(e) => setLine(l.key, { sku: e.target.value || null })} style={{ maxWidth: compact ? 260 : 330, ...lacking(Boolean(l.sku)) }}>
                    <option value="">{l.status === 'AMBIGUOUS' ? '— escolha uma das opções —' : l.status === 'NOT_FOUND' ? '— não encontrado: escolha —' : '— escolha —'}</option>
                    {suggested.length > 0 && (
                      <optgroup label={l.status === 'NOT_FOUND' ? 'Mais próximos' : 'Possíveis'}>
                        {suggested.map((c) => (
                          <option key={c.sku} value={c.sku}>
                            {c.sku} — {c.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <optgroup label="Catálogo">
                      {catalog.map((c) => (
                        <option key={c.sku} value={c.sku}>
                          {c.sku} — {c.name}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                  <div style={{ fontSize: 11 }}>
                    {l.status === 'MATCHED' && l.sku ? (
                      <span style={{ color: '#2a7d4f' }}>✓ identificado</span>
                    ) : l.sku ? (
                      <span style={{ color: '#2a7d4f' }}>✓ escolhido por você</span>
                    ) : (
                      <span style={{ color: '#d62728' }}>{l.status === 'AMBIGUOUS' ? `ambíguo: ${suggested.length} ${suggested.length === 1 ? 'opção' : 'opções'}` : 'sem correspondência no catálogo'}</span>
                    )}
                  </div>
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <input type="number" min={0} step="any" value={l.quantity ?? ''} onChange={(e) => setLine(l.key, { quantity: e.target.value === '' ? null : Number(e.target.value) })} style={{ width: 80, ...lacking(Boolean(l.quantity && l.quantity > 0)) }} />{' '}
                  <select value={l.unit} onChange={(e) => setLine(l.key, { unit: e.target.value as QtyUnit })} style={lacking(l.unit !== 'OTHER')}>
                    {(Object.keys(QTY_UNIT_LABEL) as QtyUnit[]).map((u) => (
                      <option key={u} value={u} disabled={u === 'OTHER'}>
                        {QTY_UNIT_LABEL[u]}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="num" style={{ fontSize: 12 }}>
                  {!conv ? '—' : 'error' in conv ? <span style={{ color: '#d62728' }}>{conv.error}</span> : 'pallets' in conv ? <span className="muted">calculado ao montar</span> : <span title={conv.note}>{nf.format(conv.units)} un.</span>}
                </td>
                <td>
                  <button type="button" className="small" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} title="Remover linha">
                    ✕
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <button type="button" className="small" style={{ marginTop: 6 }} onClick={() => setLines((ls) => [...ls, { key: intakeKey(), sourceText: '(adicionado manualmente)', quantity: null, unit: 'UNIT', unitText: null, status: 'NOT_FOUND', sku: null, candidates: [], note: null }])}>
        + Adicionar linha
      </button>
    </>
  )
}
