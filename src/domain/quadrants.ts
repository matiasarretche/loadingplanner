/**
 * Convenção OFICIAL de orientação (vale para motor, 3D, estatísticas, PDF, otimizador e IA):
 *
 *   NORTE = FRENTE (cabine) = parede frontal → x = 0
 *   SUL   = TRASEIRA (no contêiner, a porta)   → x = L (comprimento interno)
 *   Olhando para a frente (para o norte), sistema destro com z para cima:
 *   OESTE (O) = esquerda = lado do MOTORISTA     → y = 0
 *   LESTE (E) = direita  = lado do ACOMPANHANTE  → y = W (largura interna)
 *
 * Quadrantes: corte N/S em L/2 (metade física do equipamento) e corte E/O em W/2.
 *   NO = x ∈ [0, L/2], y ∈ [0, W/2]      NE = x ∈ [0, L/2], y ∈ [W/2, W]
 *   SO = x ∈ [L/2, L], y ∈ [0, W/2]      SE = x ∈ [L/2, L], y ∈ [W/2, W]
 *
 * O peso de cada elemento é repartido entre os quadrantes PROPORCIONALMENTE à área da sua base
 * (pegada) dentro de cada um. Tudo é expresso em % do peso total (sem limites em kg).
 */
import type { AABB } from './geometry'
import { isOutsideSpace } from './staging'
import { loadGeometries } from './load'
import type { LoadDoc } from './types'

export type Quadrant = 'NE' | 'NO' | 'SE' | 'SO'
export const QUADRANTS: Quadrant[] = ['NE', 'NO', 'SE', 'SO']

export const QUADRANT_LABEL: Record<Quadrant, string> = {
  NE: 'Nordeste (NE)',
  NO: 'Noroeste (NO)',
  SE: 'Sudeste (SE)',
  SO: 'Sudoeste (SO)',
}

/**
 * Regra operacional de distribuição (em % do peso total), na ordem de prioridade:
 *   1. limites do equipamento e por eixo (validação/carga por eixo — sempre acima desta preferência);
 *   2. o mais UNIFORME possível (frente × trás e oeste × leste);
 *   3. havendo diferença, ligeiramente mais peso na METADE TRASEIRA (SUL, sobre os eixos traseiros):
 *      +1 a +2 p.p. em relação à frente (traseira 50,5–51%; ex.: 49% frente / 51% trás);
 *   4. nunca mais peso na metade da FRENTE (norte, cabine).
 * Não é limite legal: é o critério de otimização da Pacifil. Futuro: por perfil/cliente/equipamento.
 */
export interface QuadrantRules {
  /** metade traseira abaixo disto = mais peso na frente (evitar) */
  rearMinPct: number
  /** faixa ideal da metade traseira (1–2 p.p. a mais que a frente) */
  rearIdealMinPct: number
  rearMaxPct: number
  /** alvo de otimização (desempate entre composições igualmente equilibradas) */
  rearTargetPct: number
  /** aviso: traseira acima disto = desequilíbrio maior que o recomendado */
  rearWarnPct: number
}

export const DEFAULT_QUADRANT_RULES: QuadrantRules = {
  rearMinPct: 50,
  rearIdealMinPct: 50.5,
  rearMaxPct: 51,
  rearTargetPct: 50.75,
  rearWarnPct: 52,
}

/** Alvo por quadrante: frente e trás pela regra, oeste e leste iguais. */
export function quadrantTargets(r: QuadrantRules = DEFAULT_QUADRANT_RULES): Record<Quadrant, number> {
  const rear = r.rearTargetPct / 2, front = (100 - r.rearTargetPct) / 2
  return { NE: front, NO: front, SE: rear, SO: rear }
}

/** Situação da metade traseira para telas/PDF: ideal, dentro (uniforme), frente pesada, traseira acima do recomendado. */
export type RearZone = 'ideal' | 'ok' | 'front' | 'rear'
export function rearZone(rearPct: number, r: QuadrantRules = DEFAULT_QUADRANT_RULES): RearZone {
  if (rearPct < r.rearMinPct - 1e-9) return 'front'
  if (rearPct > r.rearMaxPct + 1e-9) return 'rear'
  return rearPct >= r.rearIdealMinPct - 1e-9 ? 'ideal' : 'ok'
}

export type QuadrantFractions = Record<Quadrant, number>

/** Frações (0–1) da pegada de uma caixa em cada quadrante. */
export function footprintFractions(box: AABB, L: number, W: number): QuadrantFractions {
  const x0 = box.min.x, x1 = box.min.x + box.size.x
  const y0 = box.min.y, y1 = box.min.y + box.size.y
  const area = Math.max(1e-9, (x1 - x0) * (y1 - y0))
  const ov = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
  const hx = L / 2, hy = W / 2
  // partes fora do equipamento (se houver) ficam com o quadrante mais próximo: estende as faixas extremas
  const north = ov(x0, x1, -Infinity, hx), south = ov(x0, x1, hx, Infinity)
  const west = ov(y0, y1, -Infinity, hy), east = ov(y0, y1, hy, Infinity)
  return { NE: (north * east) / area, NO: (north * west) / area, SE: (south * east) / area, SO: (south * west) / area }
}

export interface QuadrantShares {
  /** % do peso total em cada quadrante */
  pct: Record<Quadrant, number>
  northPct: number
  southPct: number
  totalKg: number
}

export function sharesFromKg(kg: Record<Quadrant, number>): QuadrantShares {
  const total = kg.NE + kg.NO + kg.SE + kg.SO
  const p = (q: Quadrant) => (total > 0 ? (kg[q] / total) * 100 : 0)
  const pct = { NE: p('NE'), NO: p('NO'), SE: p('SE'), SO: p('SO') }
  return { pct, northPct: pct.NE + pct.NO, southPct: pct.SE + pct.SO, totalKg: total }
}

/** Distribuição atual por quadrante (paletes, caixas soltas e empilhadas, pela área de cada pegada). */
export function quadrantShares(doc: LoadDoc): QuadrantShares {
  const L = doc.space.inner.l, W = doc.space.inner.w
  const kg: Record<Quadrant, number> = { NE: 0, NO: 0, SE: 0, SO: 0 }
  for (const g of loadGeometries(doc)) {
    if (isOutsideSpace(doc, g.box)) continue // zona de trabalho: não está carregado
    const f = footprintFractions(g.box, L, W)
    for (const q of QUADRANTS) kg[q] += g.grossKg * f[q]
  }
  return sharesFromKg(kg)
}

export interface QuadrantEvaluation {
  shares: QuadrantShares
  /** % na metade traseira (SUL) e na da frente (NORTE) */
  rearPct: number
  frontPct: number
  /** p.p. abaixo do mínimo da traseira (= mais peso na frente) — o pior caso */
  frontExcess: number
  /** p.p. acima do máximo recomendado da traseira */
  rearExcess: number
  /** quanto falta para a faixa ideal (1–2 p.p. a mais atrás) quando a carga está equilibrada */
  idealGap: number
  /** erro aos alvos por quadrante (p.p.) */
  targetError: number
  lateralImbalance: number
  zone: RearZone
  /** dentro da regra: nem frente pesada, nem traseira acima do recomendado */
  ok: boolean
}

export function evaluateQuadrants(s: QuadrantShares, rules: QuadrantRules = DEFAULT_QUADRANT_RULES): QuadrantEvaluation {
  const t = quadrantTargets(rules)
  const rearPct = s.southPct, frontPct = s.northPct
  const frontExcess = s.totalKg > 0 ? Math.max(0, rules.rearMinPct - rearPct) : 0
  const rearExcess = s.totalKg > 0 ? Math.max(0, rearPct - rules.rearMaxPct) : 0
  const idealGap = s.totalKg > 0 ? Math.max(0, rules.rearIdealMinPct - rearPct) : 0
  const targetError = QUADRANTS.reduce((a, q) => a + Math.abs(s.pct[q] - t[q]), 0)
  const lateralImbalance = Math.abs(s.pct.NE - s.pct.NO) + Math.abs(s.pct.SE - s.pct.SO)
  return { shares: s, rearPct, frontPct, frontExcess, rearExcess, idealGap, targetError, lateralImbalance, zone: rearZone(rearPct, rules), ok: frontExcess <= 1e-9 && rearExcess <= 1e-9 }
}
