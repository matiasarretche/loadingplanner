'use client'

import { AXLE_GROUP_LABEL, AxleProfileSnapshot, AxleResult, AxleStatus, CarrierSnapshot, containerPositions, RoadSetup, TractorSnapshot } from '@/domain/axles'
import type { LoadDoc, SpaceSnapshot } from '@/domain/types'
import { kg, nf0, nf1 } from '../format'

/** Cadastros disponíveis para montar a combinação rodoviária (snapshots). */
export interface RoadOptions {
  tractors: TractorSnapshot[]
  /** veículos com geometria de eixos (semirreboques, rígidos) e chassis porta-contêiner */
  carriers: CarrierSnapshot[]
  profiles: AxleProfileSnapshot[]
}

export const AXLE_COLOR: Record<AxleStatus, string> = { ok: '#2ca02c', warn: '#f28c00', over: '#d62728', unknown: '#8a97a3' }

/** Implementos possíveis para o espaço atual: o próprio veículo (rodoviário) ou os chassis (contêiner marítimo). */
export function carrierChoices(space: SpaceSnapshot, opts: RoadOptions): CarrierSnapshot[] {
  if (space.kind === 'VEHICLE') return opts.carriers.filter((c) => c.kind !== 'CHASSIS' && c.id === space.typeId)
  if (space.transport === 'AIR') return []
  return opts.carriers.filter((c) => c.kind === 'CHASSIS')
}

const defaultTractor = (opts: RoadOptions) => opts.tractors.find((t) => t.rearGroup === 'TANDEM2') ?? opts.tractors[0] ?? null
const defaultProfile = (opts: RoadOptions) => opts.profiles.find((p) => p.country === 'BR') ?? opts.profiles[0]

/**
 * Combinação para o espaço (null se faltam cadastros). Com `prev`, mantém as escolhas (cavalo, chassi,
 * limites, posição) com os dados ATUAIS dos cadastros.
 */
export function defaultRoad(space: SpaceSnapshot, opts: RoadOptions, prev?: RoadSetup): RoadSetup | null {
  const choices = carrierChoices(space, opts)
  const carrier = choices.find((c) => c.id === prev?.carrier.id) ?? choices[0]
  const profile = opts.profiles.find((p) => p.id === prev?.profile.id) ?? prev?.profile ?? defaultProfile(opts)
  if (!carrier || !profile) return null
  const tractor = carrier.kind === 'RIGID' ? null : opts.tractors.find((t) => t.id === prev?.tractor?.id) ?? prev?.tractor ?? defaultTractor(opts)
  if (carrier.kind !== 'RIGID' && !tractor) return null
  const road: RoadSetup = { tractor, carrier, profile }
  if (carrier.kind === 'CHASSIS') {
    const pos = containerPositions(carrier.lengthMm, space.inner.l)
    // 20' no chassi de 40': atrás (sobre os eixos) é o usual; 40': única posição
    const keep = prev?.carrier.id === carrier.id && prev.containerFrontMm != null && pos.some((p) => p.frontMm === prev.containerFrontMm)
    road.containerFrontMm = keep ? prev!.containerFrontMm : pos[pos.length - 1].frontMm
  }
  return road
}

/** Ao trocar o equipamento: mantém cavalo/limites e troca o implemento; remove se não houver correspondente. */
export function adaptRoad(road: RoadSetup | undefined, space: SpaceSnapshot, opts: RoadOptions): RoadSetup | undefined {
  if (!road) return undefined
  return defaultRoad(space, opts, road) ?? undefined
}

export function AxlePanel({ doc, opts, result, readOnly, onChange }: { doc: LoadDoc; opts: RoadOptions; result: AxleResult | null; readOnly: boolean; onChange: (road: RoadSetup | undefined) => void }) {
  const road = doc.road
  const choices = carrierChoices(doc.space, opts)
  if (doc.space.transport === 'AIR') return null
  const isContainer = doc.space.kind === 'CONTAINER'

  if (!road || !result) {
    const def = defaultRoad(doc.space, opts)
    return (
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Carga por eixo</h3>
        {def ? (
          <>
            <small className="muted" style={{ display: 'block' }}>
              {isContainer ? 'Contêiner sobre chassi porta-contêiner puxado por cavalo mecânico.' : 'Cavalo + implemento (ou caminhão rígido).'} Calcula o peso em cada conjunto de eixos e avisa quando um conjunto passa do limite, mesmo com o total dentro do permitido.
            </small>
            {!readOnly && (
              <button className="primary" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} onClick={() => onChange(def)}>
                🚛 Calcular carga por eixo
              </button>
            )}
          </>
        ) : (
          <small className="muted">
            {doc.space.kind === 'VEHICLE'
              ? `O veículo ${doc.space.code} ainda não tem a geometria dos eixos cadastrada (Cadastros → Veículos rodoviários → “Eixos”).`
              : 'Cadastre um chassi porta-contêiner (Cadastros → Veículos rodoviários, tipo “Chassi porta-contêiner”).'}
            {!opts.tractors.length && ' Falta cadastrar um cavalo mecânico.'}
            {!opts.profiles.length && ' Falta cadastrar os limites por eixo do país.'}
          </small>
        )}
      </div>
    )
  }

  const C = road.carrier
  const P = road.profile
  const set = (patch: Partial<RoadSetup>) => onChange({ ...road, ...patch })
  const positions = C.kind === 'CHASSIS' ? containerPositions(C.lengthMm, doc.space.inner.l) : []
  const estimated = [road.tractor?.verification, C.verification, P.verification].some((v) => v && v !== 'VERIFIED')
  const rows = [...result.groups.map((g) => ({ key: g.key, label: g.label, sub: `${AXLE_GROUP_LABEL[g.type]}${g.axles > 1 ? ` · ${nf0.format(g.perAxleKg)} kg/eixo` : ''}`, kg: g.kg, limit: g.limitKg, pct: g.pct, status: g.status, tech: g.techKg != null && g.limitKg === g.techKg && (g.legalKg == null || g.techKg < g.legalKg) }))]

  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>Carga por eixo</h3>
      {!readOnly ? (
        <>
          {C.kind !== 'RIGID' && (
            <label className="field">
              Cavalo mecânico
              <select value={road.tractor?.id ?? ''} onChange={(e) => set({ tractor: opts.tractors.find((t) => t.id === Number(e.target.value)) ?? road.tractor })}>
                {opts.tractors.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.code} — {t.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {isContainer && (
            <>
              <label className="field">
                Chassi
                <select value={C.id} onChange={(e) => {
                  const c = choices.find((x) => x.id === Number(e.target.value))
                  if (c) onChange({ ...road, carrier: c, containerFrontMm: containerPositions(c.lengthMm, doc.space.inner.l).at(-1)!.frontMm })
                }}>
                  {choices.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} — {c.name}
                    </option>
                  ))}
                </select>
              </label>
              {positions.length > 1 && (
                <label className="field">
                  Posição do contêiner no chassi
                  <select value={road.containerFrontMm ?? 0} onChange={(e) => set({ containerFrontMm: Number(e.target.value) })}>
                    {positions.map((p) => (
                      <option key={p.frontMm} value={p.frontMm}>
                        {p.label} ({nf0.format(p.frontMm)} mm da frente)
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}
          <label className="field">
            Limites legais
            <select value={P.id} onChange={(e) => set({ profile: opts.profiles.find((p) => p.id === Number(e.target.value)) ?? P })}>
              {opts.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : (
        <small className="muted" style={{ display: 'block', marginBottom: 6 }}>
          {[road.tractor?.code, C.code, P.name].filter(Boolean).join(' + ')}
        </small>
      )}

      <table className="data compact" style={{ marginTop: 6 }}>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>
                {r.label}
                <div className="muted" style={{ fontSize: 11 }}>{r.sub}</div>
                <AxleBar pct={r.pct} status={r.status} />
              </td>
              <td className="num" style={{ verticalAlign: 'top' }}>
                <strong style={{ color: r.status === 'ok' ? undefined : AXLE_COLOR[r.status] }}>{kg(r.kg)}</strong>
                <div className="muted" style={{ fontSize: 11 }}>
                  {r.limit != null ? `de ${nf0.format(r.limit)}${r.tech ? ' (técnico)' : ''} · ${nf1.format(r.pct ?? 0)}%` : 'sem limite'}
                </div>
              </td>
            </tr>
          ))}
          <tr>
            <td>
              <strong>PBTC</strong> <small className="muted">(carga + taras)</small>
              <AxleBar pct={result.grossPct} status={result.grossStatus} />
            </td>
            <td className="num" style={{ verticalAlign: 'top' }}>
              <strong style={{ color: result.grossStatus === 'ok' ? undefined : AXLE_COLOR[result.grossStatus] }}>{kg(result.grossKg)}</strong>
              <div className="muted" style={{ fontSize: 11 }}>{result.grossLimitKg != null ? `de ${nf0.format(result.grossLimitKg)} · ${nf1.format(result.grossPct ?? 0)}%` : 'PBTC sem limite no perfil'}</div>
            </td>
          </tr>
          {result.kingpinKg != null && (
            <tr>
              <td className="muted">No pino-rei</td>
              <td className="num muted">{kg(result.kingpinKg)}</td>
            </tr>
          )}
        </tbody>
      </table>
      <small className="muted" style={{ display: 'block', marginTop: 4 }}>
        Estática pelo CG de cada palete/caixa; peso dividido igualmente entre os eixos de um tandem. Alerta a partir de {nf0.format(P.warnPct)}% do limite.
        {(P.axleTolPct != null || P.grossTolPct != null) && ` Tolerância de fiscalização (${[P.axleTolPct != null ? `${nf1.format(P.axleTolPct)}% eixo` : null, P.grossTolPct != null ? `${nf1.format(P.grossTolPct)}% PBTC` : null].filter(Boolean).join(', ')}) não é somada ao limite.`}
      </small>
      {estimated && (
        <small style={{ display: 'block', marginTop: 4, color: '#b35f00' }}>
          ⚠ Dados de referência (fichas públicas/normas pesquisadas), editáveis em Cadastros — confirmar com o transportador.
        </small>
      )}
      {!readOnly && (
        <div className="row" style={{ marginTop: 6, gap: 4 }}>
          <button className="small" onClick={() => onChange(defaultRoad(doc.space, opts, road) ?? road)} title="Recarrega os dados atuais dos cadastros (cavalo, implemento, limites)">
            ↻ Atualizar dos cadastros
          </button>
          <button className="small" onClick={() => onChange(undefined)}>
            Remover
          </button>
        </div>
      )}
    </div>
  )
}

function AxleBar({ pct, status }: { pct: number | null; status: AxleStatus }) {
  if (pct == null) return null
  return (
    <div style={{ height: 6, background: '#e3e8ec', borderRadius: 3, marginTop: 3, position: 'relative', overflow: 'hidden' }}>
      <div style={{ width: `${Math.min(100, Math.max(0, pct))}%`, height: '100%', background: AXLE_COLOR[status], borderRadius: 3 }} />
    </div>
  )
}
