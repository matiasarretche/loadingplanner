/**
 * CARGA POR EIXO (rodoviário) — estática plana (2D, ao longo do comprimento), sem otimização.
 *
 * Referencial do IMPLEMENTO: s = 0 na frente do semirreboque/carroceria/chassi, s cresce para trás (mm).
 * A carga (x do documento, 0 = MOTORISTA) entra em s = início do espaço de carga + x.
 *
 * Semirreboque / chassi porta-contêiner (apoiado no pino-rei k e no conjunto de eixos g):
 *   R_g = Σ m·(s − k) / (g − k)        P (pino-rei) = Σ m − R_g
 * Cavalo mecânico (eixo dianteiro em t = 0, centro do conjunto traseiro em t = WB, 5ª roda à frente
 * do centro traseiro em t5 = WB − avanço):
 *   R_traseiro = tara_tras + P·t5/WB    R_dianteiro = tara_diant + P·(1 − t5/WB)
 * Caminhão rígido (eixo dianteiro em s = −avanço, conjunto traseiro em g):
 *   R_g = Σ m·(s − sF) / (g − sF)      R_dianteiro = Σ m − R_g
 * Dentro de um conjunto (tandem) o peso é dividido IGUALMENTE entre os eixos (suspensão equalizada).
 *
 * Todos os parâmetros (geometria, taras, limites legais por país) vêm de cadastros editáveis e entram
 * no documento como SNAPSHOT (uma edição posterior do cadastro não muda uma carga salva).
 */
import type { Issue } from './issues'
import { fmt } from './issues'
import type { LoadDoc, Verification } from './types'

export type AxleGroupType = 'STEER' | 'SINGLE_DUAL' | 'TANDEM2' | 'TANDEM3'
export const AXLE_GROUP_TYPES: AxleGroupType[] = ['STEER', 'SINGLE_DUAL', 'TANDEM2', 'TANDEM3']

export const AXLE_GROUP_LABEL: Record<AxleGroupType, string> = {
  STEER: 'Eixo simples, 2 pneus (direcional)',
  SINGLE_DUAL: 'Eixo simples, 4 pneus (rodado duplo)',
  TANDEM2: 'Tandem duplo (2 eixos, 8 pneus)',
  TANDEM3: 'Tandem triplo (3 eixos, 12 pneus)',
}
export const AXLE_COUNT: Record<AxleGroupType, number> = { STEER: 1, SINGLE_DUAL: 1, TANDEM2: 2, TANDEM3: 3 }

export interface TractorSnapshot {
  id: number
  code: string
  name: string
  /** eixo dianteiro → CENTRO do conjunto traseiro (mm) */
  wheelbaseMm: number
  /** centro da 5ª roda à frente do centro do conjunto traseiro (mm; "avanço") */
  fifthWheelAheadMm: number
  rearGroup: AxleGroupType
  /** distância entre eixos do conjunto traseiro (mm) */
  rearSpacingMm: number
  tareFrontKg: number
  tareRearKg: number
  /** capacidade técnica do fabricante (opcional; o limite efetivo é o menor entre legal e técnico) */
  techFrontKg: number | null
  techRearKg: number | null
  verification: Verification
  source: string | null
}

export type CarrierKind = 'SEMITRAILER' | 'RIGID' | 'CHASSIS'

export interface CarrierSnapshot {
  id: number
  code: string
  name: string
  kind: CarrierKind
  /** comprimento total do implemento (mm) */
  lengthMm: number
  /** semirreboque/chassi: pino-rei atrás da frente (mm) */
  kingpinMm: number | null
  /** rígido: eixo dianteiro À FRENTE da frente da carroceria (mm) */
  frontAxleAheadMm: number | null
  group: AxleGroupType
  /** centro do conjunto de eixos atrás da frente (mm) */
  groupCenterMm: number
  groupSpacingMm: number
  techGroupKg: number | null
  /** rígido: capacidade técnica do eixo dianteiro */
  techFrontKg: number | null
  tareKg: number
  /** CG da tara atrás da frente (mm); null = meio do comprimento */
  tareCgMm: number | null
  /** início do espaço de carga atrás da frente (mm) */
  cargoStartMm: number
  verification: Verification
  source: string | null
}

export interface AxleProfileSnapshot {
  id: number
  code: string
  name: string
  country: string | null
  limits: Record<AxleGroupType, number | null>
  /** PBTC máximo da combinação (kg) */
  maxGrossKg: number | null
  /** alerta "perto do limite" a partir desta % do limite */
  warnPct: number
  /** tolerâncias de fiscalização (só informativas: não se incorporam ao carregamento) */
  axleTolPct: number | null
  grossTolPct: number | null
  verification: Verification
  source: string | null
}

export interface RoadSetup {
  /** null = caminhão rígido (sem cavalo) */
  tractor: TractorSnapshot | null
  carrier: CarrierSnapshot
  profile: AxleProfileSnapshot
  /** contêiner sobre chassi: frente do contêiner atrás da frente do chassi (mm) */
  containerFrontMm?: number
}

export type AxleStatus = 'ok' | 'warn' | 'over' | 'unknown'

export interface AxleGroupLoad {
  key: 'TRACTOR_FRONT' | 'TRACTOR_REAR' | 'CARRIER_FRONT' | 'CARRIER'
  label: string
  type: AxleGroupType
  axles: number
  kg: number
  perAxleKg: number
  legalKg: number | null
  techKg: number | null
  /** menor entre legal e técnico */
  limitKg: number | null
  pct: number | null
  status: AxleStatus
  /** posição de cada eixo no referencial da CARGA (x do documento; negativo = à frente da parede do motorista) */
  axleXs: number[]
}

export interface AxleResult {
  groups: AxleGroupLoad[]
  /** carga + taras (cavalo, implemento, contêiner) */
  grossKg: number
  grossLimitKg: number | null
  grossPct: number | null
  grossStatus: AxleStatus
  cargoKg: number
  kingpinKg: number | null
  kingpinX: number | null
}

/** Comprimento externo ISO do contêiner a partir do interno (20', 40', 45'). */
export function containerExtLengthMm(innerL: number): number {
  return innerL < 7000 ? 6058 : innerL < 13000 ? 12192 : 13716
}

/** Onde começa a carga (x = 0) no referencial do implemento. */
export function cargoOffsetMm(doc: Pick<LoadDoc, 'space'>, road: RoadSetup): number {
  if (road.carrier.kind === 'CHASSIS') {
    const L = doc.space.inner.l
    return (road.containerFrontMm ?? 0) + (containerExtLengthMm(L) - L) / 2
  }
  return road.carrier.cargoStartMm
}

/** Posições sugeridas do contêiner no chassi: frente, centro e traseira. */
export function containerPositions(chassisLengthMm: number, innerL: number): { label: string; frontMm: number }[] {
  const ext = containerExtLengthMm(innerL)
  const free = Math.max(0, chassisLengthMm - ext)
  // contêiner do tamanho do chassi (40′ no chassi de 40′): posição única, encostado na frente
  if (free < 1500) return [{ label: 'Única', frontMm: 0 }]
  return [
    { label: 'Na frente', frontMm: 0 },
    { label: 'Centralizado', frontMm: Math.round(free / 2) },
    { label: 'Atrás', frontMm: Math.round(free) },
  ]
}

const axleXs = (center: number, n: number, spacing: number) => Array.from({ length: n }, (_, i) => center + (i - (n - 1) / 2) * spacing)

function status(kg: number, limit: number | null, warnPct: number): AxleStatus {
  if (limit == null || limit <= 0) return 'unknown'
  if (kg > limit + 0.5) return 'over'
  if (kg >= (limit * warnPct) / 100) return 'warn'
  return 'ok'
}

const minOf = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.min(a, b))

/**
 * Cargas por conjunto de eixos para as massas da carga (kg e x do CG no referencial da carga).
 * Massas negativas/nulas são ignoradas.
 */
export function axleLoads(doc: Pick<LoadDoc, 'space'>, road: RoadSetup, masses: { kg: number; x: number }[]): AxleResult {
  const C = road.carrier
  const off = cargoOffsetMm(doc, road)
  // massas no referencial do implemento
  const items: { kg: number; s: number }[] = masses.filter((m) => m.kg > 0).map((m) => ({ kg: m.kg, s: off + m.x }))
  const cargoKg = items.reduce((a, m) => a + m.kg, 0)
  items.push({ kg: C.tareKg, s: C.tareCgMm ?? C.lengthMm / 2 })
  if (C.kind === 'CHASSIS') {
    const ext = containerExtLengthMm(doc.space.inner.l)
    items.push({ kg: doc.space.tareKg, s: (road.containerFrontMm ?? 0) + ext / 2 })
  }
  const M = items.reduce((a, m) => a + m.kg, 0)
  const P = road.profile
  const g = C.groupCenterMm
  const groups: AxleGroupLoad[] = []
  const mk = (key: AxleGroupLoad['key'], label: string, type: AxleGroupType, kg: number, centerS: number, spacing: number, tech: number | null): AxleGroupLoad => {
    const n = AXLE_COUNT[type]
    const legal = P.limits[type]
    const limit = minOf(legal, tech)
    return {
      key,
      label,
      type,
      axles: n,
      kg,
      perAxleKg: kg / n,
      legalKg: legal,
      techKg: tech,
      limitKg: limit,
      pct: limit ? (kg / limit) * 100 : null,
      status: kg < -0.5 ? 'over' : status(kg, limit, P.warnPct),
      axleXs: axleXs(centerS - off, n, spacing),
    }
  }
  let kingpinKg: number | null = null
  let kingpinX: number | null = null
  let tractorKg = 0
  if (C.kind === 'RIGID') {
    const sF = -(C.frontAxleAheadMm ?? 0)
    const Rg = items.reduce((a, m) => a + (m.kg * (m.s - sF)) / (g - sF), 0)
    groups.push(mk('CARRIER_FRONT', 'Eixo dianteiro', 'STEER', M - Rg, sF, 0, C.techFrontKg))
    groups.push(mk('CARRIER', 'Eixos traseiros', C.group, Rg, g, C.groupSpacingMm, C.techGroupKg))
  } else {
    const k = C.kingpinMm ?? 0
    const Rg = items.reduce((a, m) => a + (m.kg * (m.s - k)) / (g - k), 0)
    kingpinKg = M - Rg
    kingpinX = k - off
    const T = road.tractor
    if (T) {
      // cavalo: 5ª roda sob o pino-rei; eixo dianteiro em t = 0 → s = k − t5
      const t5 = T.wheelbaseMm - T.fifthWheelAheadMm
      const sFront = k - t5
      const rear = T.tareRearKg + (kingpinKg * t5) / T.wheelbaseMm
      const front = T.tareFrontKg + kingpinKg * (1 - t5 / T.wheelbaseMm)
      tractorKg = T.tareFrontKg + T.tareRearKg
      groups.push(mk('TRACTOR_FRONT', 'Cavalo · eixo dianteiro', 'STEER', front, sFront, 0, T.techFrontKg))
      groups.push(mk('TRACTOR_REAR', `Cavalo · ${T.rearGroup === 'TANDEM2' ? 'eixos traseiros' : 'eixo traseiro'}`, T.rearGroup, rear, sFront + T.wheelbaseMm, T.rearSpacingMm, T.techRearKg))
    }
    groups.push(mk('CARRIER', C.kind === 'CHASSIS' ? 'Chassi · eixos' : 'Semirreboque · eixos', C.group, Rg, g, C.groupSpacingMm, C.techGroupKg))
  }
  const grossKg = M + tractorKg
  const grossLimitKg = P.maxGrossKg
  return {
    groups,
    grossKg,
    grossLimitKg,
    grossPct: grossLimitKg ? (grossKg / grossLimitKg) * 100 : null,
    grossStatus: status(grossKg, grossLimitKg, P.warnPct),
    cargoKg,
    kingpinKg,
    kingpinX,
  }
}

/** Alertas da distribuição por eixo (entram no validateLoad quando a carga tem `road`). */
export function axleIssues(road: RoadSetup, r: AxleResult): Issue[] {
  const out: Issue[] = []
  const P = road.profile
  for (const g of r.groups) {
    if (g.kg < -0.5) {
      out.push({ code: 'AXLE_OVERLOAD', severity: 'CRITICAL', message: `${g.label}: carga negativa (${fmt.kg(g.kg)}) — o eixo levanta. Traga peso para perto dele.`, refs: [], value: g.kg })
      continue
    }
    if (g.limitKg == null) continue
    const src = g.techKg != null && g.limitKg === g.techKg && (g.legalKg == null || g.techKg < g.legalKg) ? 'capacidade técnica' : `limite legal ${P.name}`
    if (g.status === 'over')
      out.push({
        code: 'AXLE_OVERLOAD',
        severity: 'CRITICAL',
        message: `${g.label}: ${fmt.kg(g.kg)} acima de ${fmt.kg(g.limitKg)} (${src}; ${fmt.pct(g.pct ?? 0)}). Redistribua a carga ao longo do comprimento.`,
        refs: [],
        value: g.kg,
        limit: g.limitKg,
      })
    else if (g.status === 'warn')
      out.push({
        code: 'AXLE_NEAR_LIMIT',
        severity: 'WARNING',
        message: `${g.label}: ${fmt.kg(g.kg)} = ${fmt.pct(g.pct ?? 0)} do limite (${fmt.kg(g.limitKg)}; alerta a partir de ${fmt.pct(P.warnPct)}).`,
        refs: [],
        value: g.kg,
        limit: g.limitKg,
      })
  }
  if (r.grossStatus === 'over')
    out.push({ code: 'AXLE_GROSS', severity: 'CRITICAL', message: `PBTC da combinação ${fmt.kg(r.grossKg)} acima de ${fmt.kg(r.grossLimitKg!)} (${P.name}).`, refs: [], value: r.grossKg, limit: r.grossLimitKg ?? undefined })
  else if (r.grossStatus === 'warn')
    out.push({ code: 'AXLE_NEAR_LIMIT', severity: 'WARNING', message: `PBTC da combinação ${fmt.kg(r.grossKg)} = ${fmt.pct(r.grossPct ?? 0)} do limite (${fmt.kg(r.grossLimitKg!)}).`, refs: [], value: r.grossKg, limit: r.grossLimitKg ?? undefined })
  const est = [road.tractor && road.tractor.verification !== 'VERIFIED' ? `cavalo ${road.tractor.code}` : null, road.carrier.verification !== 'VERIFIED' ? `implemento ${road.carrier.code}` : null, P.verification !== 'VERIFIED' ? `limites ${P.code}` : null].filter(Boolean)
  if (est.length) out.push({ code: 'UNVERIFIED_DATA', severity: 'INFO', message: `Distribuição por eixo com dados de referência (${est.join(', ')}) — confirmar com o transportador.`, refs: [] })
  return out
}
