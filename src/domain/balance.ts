/**
 * DISTRIBUIR PESO — otimização determinística por QUADRANTES (ver quadrants.ts para a convenção N/S/E/O).
 *
 * Não altera produtos, quantidades nem o pedido: só a POSIÇÃO dos paletes que podem se mover
 * (no piso, não travados, sem nada apoiado em cima). Caixas soltas e unidades empilhadas ficam
 * onde estão, mas o peso delas entra no cálculo.
 *
 * Função objetivo (comparação lexicográfica — cada nível só desempata o anterior):
 *   1. F = alertas físicos críticos (colisão, fora do espaço, apoio, porta, altura, EXCESSO POR EIXO…) → 0
 *   2. E = 2·(frente pesada: 50% − traseira) + (traseira − 51%)     fora da faixa (frente pesada pesa o dobro)
 *   3. G = falta para a faixa ideal da traseira (50,5%)             1–2 p.p. a mais atrás, se possível
 *   4. J = Σ|p_q − alvo_q| + 1,0·(|NE−NO| + |SE−SO|) + 0,1·|CG lateral %| + 0,05·|CG long − CG alvo| %
 *      (alvo: traseira 50,75%, oeste = leste) — o mais uniforme possível dentro da faixa
 *
 * Busca:
 *   - conjuntos de POSIÇÕES (slots): atuais, re-layouts do motor (por tamanho, alternando tipos,
 *     intercalando pesos) e, se permitido usar o espaço até a porta: primeiro o BLOCO INTEIRO deslocado
 *     (paletes continuam travados entre si; o vão fica num só lugar, na frente, para calço/airbag) e só
 *     se isso não bastar, os paletes espaçados ao longo do comprimento (vãos entre eles);
 *   - em cada conjunto, ATRIBUIÇÃO palete→posição (mesma base): início guloso (mais pesado primeiro,
 *     na posição que menos piora o objetivo) + busca local por trocas de pares até não melhorar;
 *   - avaliação rápida: peso por quadrante = Σ peso × fração da posição em cada quadrante;
 *   - a melhor candidata é validada com o motor completo (validateLoad) antes de ser aceita.
 * Reprodutível: mesma carga → mesmo resultado (sem aleatoriedade).
 */
import { placePalletsGreedy } from './autoload'
import { footprintOverlap } from './geometry'
import { loadGeometries, loadSummary, validateLoad } from './load'
import { palletEnvelope } from './pallet'
import {
  DEFAULT_QUADRANT_RULES,
  evaluateQuadrants,
  footprintFractions,
  Quadrant,
  QuadrantEvaluation,
  QuadrantFractions,
  QuadrantRules,
  QUADRANTS,
  quadrantShares,
  sharesFromKg,
} from './quadrants'
import { stagedIds, withoutStaged } from './staging'
import type { LoadDoc, LoadUnit } from './types'

export interface BalanceMetrics {
  quadrants: QuadrantEvaluation
  cgLongDevPct: number
  cgLatDevPct: number
  peakKgPerM: number
  meanKgPerM: number
  /** custo J (nível 4) */
  score: number
}

export interface BalanceResult {
  doc: LoadDoc
  before: BalanceMetrics
  after: BalanceMetrics
  swaps: number
  movable: number
  strategy: string
  spread: boolean
  /** a distribuição exigida (SUL ≤ máx. e NORTE na tolerância) foi atingida? */
  meetsRules: boolean
  reason?: string
  physicalIssuesBefore: number
  physicalIssuesAfter: number
}

export interface BalanceOptions {
  rules?: QuadrantRules
  /** permite espaçar os paletes até a porta (calços/airbags) quando ajuda a cumprir as regras */
  spread?: boolean
  maxPasses?: number
}

type PalletUnit = Extract<LoadUnit, { kind: 'PALLET' }>

// carga por eixo (quando há combinação rodoviária): os limites por eixo sempre valem mais que a preferência de distribuição
const PHYSICAL = new Set(['COLLISION', 'OUT_OF_BOUNDS', 'UNSUPPORTED', 'STACK_NOT_ALLOWED', 'STACK_WEIGHT', 'STACK_LAYERS', 'DOOR_FIT', 'HEIGHT_LIMIT', 'AXLE_OVERLOAD', 'AXLE_GROSS'])
const physicalIssues = (doc: LoadDoc) => validateLoad(doc).issues.filter((i) => i.severity === 'CRITICAL' && PHYSICAL.has(i.code))

/** CG longitudinal alvo (% do comprimento a partir do centro) coerente com a % alvo na traseira. */
function cgLongTargetDevPct(rules: QuadrantRules) {
  const south = rules.rearTargetPct / 100
  // metades com centros em L/4 e 3L/4: x = L/4 · (1 + 2·sul)
  return ((1 + 2 * south) / 4) * 100 - 50
}

function jCost(e: QuadrantEvaluation, cgLatPct: number, cgLongPct: number, rules: QuadrantRules) {
  return e.targetError + 1.0 * e.lateralImbalance + 0.1 * Math.abs(cgLatPct) + 0.05 * Math.abs(cgLongPct - cgLongTargetDevPct(rules))
}

export function balanceMetrics(doc: LoadDoc, rules: QuadrantRules = DEFAULT_QUADRANT_RULES): BalanceMetrics {
  const s = loadSummary(doc)
  const q = evaluateQuadrants(quadrantShares(doc), rules)
  const used = s.longitudinal.filter((b) => b.fromMm < Math.max(s.usedLengthMm, 1))
  const perM = used.map((b) => b.kg / ((b.toMm - b.fromMm) / 1000))
  const cgLong = s.cgLongDevPct ?? 0
  const cgLat = s.cgLatDevPct ?? 0
  return {
    quadrants: q,
    cgLongDevPct: cgLong,
    cgLatDevPct: cgLat,
    peakKgPerM: perM.length ? Math.max(...perM) : 0,
    meanKgPerM: perM.length ? perM.reduce((a, b) => a + b, 0) / perM.length : 0,
    score: jCost(q, cgLat, cgLong, rules),
  }
}

/** Compara candidatos pelos níveis 1→4. Negativo = `a` é melhor. */
function compare(a: { phys: number; e: QuadrantEvaluation; j: number }, b: { phys: number; e: QuadrantEvaluation; j: number }) {
  if (a.phys !== b.phys) return a.phys - b.phys
  const out = (e: QuadrantEvaluation) => 2 * e.frontExcess + e.rearExcess
  if (Math.abs(out(a.e) - out(b.e)) > 1e-6) return out(a.e) - out(b.e)
  if (Math.abs(a.e.idealGap - b.e.idealGap) > 1e-6) return a.e.idealGap - b.e.idealGap
  return a.j - b.j
}

/**
 * COLUNA móvel: palete no piso + paletes empilhados exatamente sobre ele (mesma pegada, alinhados).
 * A coluna muda de posição inteira (peso = soma). Não move: travados, ou colunas com caixas soltas /
 * paletes desalinhados por cima (perderiam o apoio).
 */
interface Column {
  base: PalletUnit
  /** de baixo para cima */
  uppers: PalletUnit[]
  kg: number
}

function movableColumns(doc: LoadDoc): Column[] {
  const geos = loadGeometries(doc)
  const above = geos.filter((g) => g.box.min.z > 0)
  const env = (u: PalletUnit) => palletEnvelope(doc.pallets[u.palletKey]).size
  const out: Column[] = []
  for (const g of geos) {
    const u = g.unit
    if (u.kind !== 'PALLET' || u.locked || u.pos.z !== 0) continue
    const over = above.filter((a) => footprintOverlap(a.box, g.box) > 0)
    const e0 = env(u)
    const aligned = over.every((a) => {
      if (a.unit.kind !== 'PALLET' || a.unit.locked) return false
      if (a.box.min.x !== g.box.min.x || a.box.min.y !== g.box.min.y || a.box.size.x !== g.box.size.x || a.box.size.y !== g.box.size.y) return false
      const e = env(a.unit)
      return a.unit.yaw === u.yaw ? e.x === e0.x && e.y === e0.y : e.x === e0.y && e.y === e0.x
    })
    if (!aligned) continue
    out.push({ base: u, uppers: over.sort((a, b) => a.box.min.z - b.box.min.z).map((a) => a.unit as PalletUnit), kg: g.grossKg + over.reduce((s, a) => s + a.grossKg, 0) })
  }
  return out
}

const baseOf = (doc: LoadDoc, key: string) => {
  const e = palletEnvelope(doc.pallets[key]).size
  return `${e.x}x${e.y}`
}

/**
 * Recoloca as BASES das colunas móveis do zero, no piso, na ordem dada (mantém ids/rótulos).
 * Os paletes de cima saem do documento aqui e voltam junto com a base na atribuição. Null se algum não couber.
 */
function relayout(doc: LoadDoc, moving: Set<string>, order: PalletUnit[]): LoadDoc | null {
  let d: LoadDoc = { ...doc, units: doc.units.filter((u) => !moving.has(u.id)) }
  for (const u of order) {
    const r = placePalletsGreedy(d, u.palletKey, doc.pallets[u.palletKey], 1, { allowStacking: false })
    if (r.placed !== 1) return null
    const nid = r.unitIds[0]
    d = { ...r.doc, units: r.doc.units.map((x) => (x.id === nid ? { ...(x as PalletUnit), id: u.id, label: u.label } : x)) }
  }
  return d
}

/**
 * Sequências de BASES para re-layout (o motor coloca do motorista para a porta).
 * Dentro de cada base a ordem não importa: a atribuição palete→posição é otimizada depois.
 * Gera: blocos (cada permutação, até 3 tipos), intercalação 1 a 1, em pares (fileiras alternadas)
 * e espelhada (AB BA AB…, equilibra leste/oeste), começando por cada tipo.
 */
function layoutOrders(doc: LoadDoc, movable: PalletUnit[]): { name: string; order: PalletUnit[] }[] {
  const groups = new Map<string, PalletUnit[]>()
  for (const u of movable) {
    const b = baseOf(doc, u.palletKey)
    groups.set(b, [...(groups.get(b) ?? []), u])
  }
  const lists = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([, l]) => l)
  if (lists.length === 1) return [{ name: 'reorganizado', order: lists[0] }]
  const perms = (xs: number[]): number[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])))
  const idx = lists.map((_, i) => i)
  const starts = lists.length <= 3 ? perms(idx) : [idx, [...idx].reverse()]
  const out: { name: string; order: PalletUnit[] }[] = []
  for (const p of starts) out.push({ name: 'por tipo de palete', order: p.flatMap((i) => lists[i]) })
  /** intercala proporcionalmente (Bresenham) em blocos de `chunk`; `mirror` inverte a ordem a cada bloco */
  const interleave = (p: number[], chunk: number, mirror: boolean) => {
    const taken = p.map(() => 0)
    const total = movable.length
    const out: PalletUnit[] = []
    let flip = false
    while (out.length < total) {
      // escolhe os próximos `chunk` grupos pelo critério de maior atraso proporcional
      const block: number[] = []
      for (let c = 0; c < chunk && out.length + block.length < total; c++) {
        let best = -1, bestLag = -Infinity
        for (const g of p) {
          const n = lists[g].length
          const used = taken[g] + block.filter((x) => x === g).length
          if (used >= n) continue
          const lag = (out.length + block.length + 1) * (n / total) - used
          if (lag > bestLag + 1e-9) {
            best = g
            bestLag = lag
          }
        }
        block.push(best)
      }
      if (mirror && flip) block.reverse()
      flip = !flip
      for (const g of block) out.push(lists[g][taken[g]++])
    }
    return out
  }
  for (const p of starts) {
    out.push({ name: 'intercalando os tipos de palete', order: interleave(p, 1, false) })
    out.push({ name: 'intercalando os tipos de palete (espelhado)', order: interleave(p, 2, true) })
    out.push({ name: 'alternando fileiras por tipo', order: pairRows(interleave(p, 1, false), (u) => baseOf(doc, u.palletKey)) })
  }
  return out
}

/** AB AB… → AA BB…: agrupa de dois em dois os do mesmo tipo (fileiras inteiras do mesmo tipo). */
function pairRows(order: PalletUnit[], key: (u: PalletUnit) => string): PalletUnit[] {
  const rest = [...order]
  const out: PalletUnit[] = []
  while (rest.length) {
    const a = rest.shift()!
    out.push(a)
    const k = rest.findIndex((u) => key(u) === key(a))
    if (k >= 0) out.push(rest.splice(k, 1)[0])
  }
  return out
}

/**
 * Desloca a carga inteira em direção à porta, SEM abrir vãos entre os paletes (continuam travados entre
 * si): `fraction` do espaço livre até a porta. O vão fica todo na frente (motorista), num só lugar,
 * para um calço/airbag/barra. Nada pode estar travado.
 */
export function shiftAlongLength(doc: LoadDoc, fraction = 1): LoadDoc {
  if (doc.units.some((u) => u.locked)) return doc
  const geos = loadGeometries(doc)
  if (!geos.length) return doc
  const free = doc.space.inner.l - Math.max(...geos.map((g) => g.box.min.x + g.box.size.x))
  const dx = Math.floor(free * Math.min(1, Math.max(0, fraction)))
  if (dx < 1) return doc
  return { ...doc, units: doc.units.map((u) => ({ ...u, pos: { ...u.pos, x: u.pos.x + dx } })) }
}

/**
 * Espaça a carga ao longo de todo o comprimento por ESTIRAMENTO PROPORCIONAL (x × k, k ≥ 1):
 * os vãos só aumentam, nada se sobrepõe, a última unidade encosta na porta.
 * Unidades empilhadas acompanham a unidade de baixo (só se estiverem alinhadas sobre ela);
 * nada pode estar travado.
 */
export function spreadAlongLength(doc: LoadDoc, fraction = 1): LoadDoc {
  if (doc.units.some((u) => u.locked)) return doc
  const geos = loadGeometries(doc)
  const floor = geos.filter((g) => g.box.min.z === 0)
  if (floor.length < 2) return doc
  // cada unidade de cima precisa estar alinhada (mesmo x inicial e dentro da pegada) sobre uma do piso
  const carrier = new Map<string, string>()
  for (const g of geos) {
    if (g.box.min.z === 0) continue
    const f = floor.find((b) => b.box.min.x === g.box.min.x && footprintOverlap(b.box, g.box) > 0 && g.box.size.x <= b.box.size.x)
    if (!f) return doc
    carrier.set(g.unit.id, f.unit.id)
  }
  const L = doc.space.inner.l
  let k = Infinity
  for (const g of floor) if (g.box.min.x > 0) k = Math.min(k, (L - g.box.size.x) / g.box.min.x)
  if (!Number.isFinite(k) || k <= 1.0001) return doc
  k = 1 + (k - 1) * Math.min(1, Math.max(0, fraction))
  const pos = new Map(floor.map((g) => [g.unit.id, Math.floor(g.box.min.x * k)]))
  for (const [id, base] of carrier) pos.set(id, pos.get(base)!)
  return { ...doc, units: doc.units.map((u) => ({ ...u, pos: { ...u.pos, x: pos.get(u.id) ?? u.pos.x } })) }
}

// ---------------------------------------------------------------------------
// Atribuição palete → posição (avaliação rápida)
// ---------------------------------------------------------------------------

interface Slot {
  unit: PalletUnit // posição/giro do layout
  base: string
  frac: QuadrantFractions
  cx: number
  cy: number
}
interface Item {
  unit: PalletUnit // palete de baixo da coluna (id, rótulo, montagem)
  uppers: PalletUnit[] // paletes empilhados sobre ele (vão junto)
  base: string
  kg: number // peso da coluna inteira
}

function optimizeAssignment(layout: LoadDoc, baseIds: Set<string>, upperIds: Set<string>, items: Item[], rules: QuadrantRules, maxPasses: number) {
  const L = layout.space.inner.l, W = layout.space.inner.w
  const geos = loadGeometries(layout)
  // contribuição fixa (o que não se move)
  const fixedKg: Record<Quadrant, number> = { NE: 0, NO: 0, SE: 0, SO: 0 }
  let fm = 0, fx = 0, fy = 0
  const slots: Slot[] = []
  for (const g of geos) {
    if (upperIds.has(g.unit.id)) continue // vai junto com a sua base (peso já está no item)
    if (g.unit.kind === 'PALLET' && baseIds.has(g.unit.id)) {
      slots.push({
        unit: g.unit as PalletUnit,
        base: baseOf(layout, (g.unit as PalletUnit).palletKey),
        frac: footprintFractions(g.box, L, W),
        cx: g.box.min.x + g.box.size.x / 2,
        cy: g.box.min.y + g.box.size.y / 2,
      })
      continue
    }
    const f = footprintFractions(g.box, L, W)
    for (const q of QUADRANTS) fixedKg[q] += g.grossKg * f[q]
    fm += g.grossKg
    fx += g.grossKg * g.cg.x
    fy += g.grossKg * g.cg.y
  }
  const evalAssign = (assign: (number | null)[]) => {
    const kg = { ...fixedKg }
    let m = fm, mx = fx, my = fy
    assign.forEach((si, ii) => {
      if (si == null) return
      const s = slots[si], w = items[ii].kg
      for (const q of QUADRANTS) kg[q] += w * s.frac[q]
      m += w
      mx += w * s.cx
      my += w * s.cy
    })
    const e = evaluateQuadrants(sharesFromKg(kg), rules)
    const cgLong = m > 0 ? ((mx / m - L / 2) / L) * 100 : 0
    const cgLat = m > 0 ? ((my / m - W / 2) / W) * 100 : 0
    return { phys: 0, e, j: jCost(e, cgLat, cgLong, rules) }
  }

  // início guloso: do mais pesado ao mais leve, na posição livre (mesma base) que menos piora o objetivo
  const order = items.map((_, i) => i).sort((a, b) => items[b].kg - items[a].kg || items[a].unit.id.localeCompare(items[b].unit.id))
  const assign: (number | null)[] = items.map(() => null)
  const used = new Set<number>()
  for (const ii of order) {
    let best: { si: number; c: ReturnType<typeof evalAssign> } | null = null
    slots.forEach((s, si) => {
      if (used.has(si) || s.base !== items[ii].base) return
      assign[ii] = si
      const c = evalAssign(assign)
      if (!best || compare(c, best.c) < 0) best = { si, c }
    })
    if (!best) return null // posição incompatível (não deveria acontecer)
    assign[ii] = (best as { si: number }).si
    used.add(assign[ii]!)
  }

  // busca local: trocas de pares (mesma base, pesos diferentes) até não melhorar
  let cur = evalAssign(assign)
  let swaps = 0
  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false
    for (let a = 0; a < items.length; a++)
      for (let b = a + 1; b < items.length; b++) {
        if (items[a].base !== items[b].base || items[a].kg === items[b].kg) continue
        ;[assign[a], assign[b]] = [assign[b], assign[a]]
        const c = evalAssign(assign)
        if (compare(c, cur) < -1e-9) {
          cur = c
          swaps++
          improved = true
        } else [assign[a], assign[b]] = [assign[b], assign[a]]
      }
    if (!improved) break
  }

  // monta o documento: cada coluna na posição atribuída (os de cima mantêm a altura e acompanham o giro da base)
  const placed: PalletUnit[] = items.flatMap((it, ii) => {
    const s = slots[assign[ii]!]
    const base = { ...it.unit, pos: { ...s.unit.pos }, yaw: s.unit.yaw }
    const ups = it.uppers.map((up) => ({ ...up, pos: { x: s.unit.pos.x, y: s.unit.pos.y, z: up.pos.z }, yaw: up.yaw === it.unit.yaw ? s.unit.yaw : !s.unit.yaw }))
    return [base, ...ups]
  })
  const doc: LoadDoc = { ...layout, units: [...layout.units.filter((u) => !baseIds.has(u.id) && !upperIds.has(u.id)), ...placed] }
  return { doc, swaps }
}

/**
 * Distribuição de peso só com o que está carregado: unidades na zona de trabalho (fora do equipamento)
 * ficam onde estão e voltam ao documento no fim.
 */
export function balanceWeight(doc0: LoadDoc, opts: BalanceOptions = {}): BalanceResult {
  const staged = stagedIds(doc0, loadGeometries(doc0).map((g) => ({ id: g.unit.id, box: g.box })))
  if (!staged.size) return balanceLoaded(doc0, opts)
  const loaded = withoutStaged(doc0, staged)
  const r = balanceLoaded(loaded, opts)
  if (r.doc === loaded) return { ...r, doc: doc0 }
  const keep = doc0.units.filter((u) => staged.has(u.id))
  return { ...r, doc: { ...r.doc, units: [...r.doc.units, ...keep] } }
}

function balanceLoaded(doc0: LoadDoc, opts: BalanceOptions): BalanceResult {
  const rules = opts.rules ?? DEFAULT_QUADRANT_RULES
  const maxPasses = opts.maxPasses ?? 12
  const before = balanceMetrics(doc0, rules)
  const issues0 = physicalIssues(doc0)
  const columns = movableColumns(doc0)
  const movable = columns.map((c) => c.base)
  const baseIds = new Set(movable.map((u) => u.id))
  const upperIds = new Set(columns.flatMap((c) => c.uppers.map((u) => u.id)))
  const moving = new Set([...baseIds, ...upperIds])
  const base = { before, movable: columns.length, physicalIssuesBefore: issues0.length }
  const none = (reason: string): BalanceResult => ({
    ...base,
    doc: doc0,
    after: before,
    swaps: 0,
    strategy: 'nenhuma',
    spread: false,
    meetsRules: before.quadrants.ok && issues0.length === 0,
    reason,
    physicalIssuesAfter: issues0.length,
  })
  if (!movable.length) return none('Nenhum palete pode mudar de posição (travados, ou com caixas soltas / paletes desalinhados por cima).')

  const items: Item[] = columns.map((c) => ({ unit: c.base, uppers: c.uppers, base: baseOf(doc0, c.base.palletKey), kg: c.kg }))
  const layouts: { name: string; doc: LoadDoc }[] = [{ name: 'posições atuais', doc: doc0 }]
  const seen = new Set<string>()
  for (const { name, order } of layoutOrders(doc0, movable)) {
    const sig = order.map((u) => baseOf(doc0, u.palletKey)).join('|')
    if (seen.has(sig)) continue // mesma sequência de bases = mesmas posições
    seen.add(sig)
    const d = relayout(doc0, moving, order)
    if (d) layouts.push({ name, doc: d })
  }
  const compact = [...layouts]
  if (opts.spread) {
    // bloco inteiro deslocado até a porta (sem vãos entre paletes): ajuste fino da % na traseira
    for (const l of compact)
      for (let f = 1; f > 0.05; f -= 0.1) {
        const sh = shiftAlongLength(l.doc, f)
        if (sh !== l.doc) layouts.push({ name: `${l.name}, bloco deslocado para a porta`, doc: sh })
      }
  }

  // otimiza a atribuição em cada conjunto de posições e valida com o motor completo
  type Best = { doc: LoadDoc; name: string; swaps: number; c: { phys: number; e: QuadrantEvaluation; j: number } }
  let best = null as Best | null
  const tryLayouts = (ls: { name: string; doc: LoadDoc }[]) => {
    for (const l of ls) {
      const r = optimizeAssignment(l.doc, baseIds, upperIds, items, rules, maxPasses)
      if (!r) continue
      const m = balanceMetrics(r.doc, rules)
      const c = { phys: physicalIssues(r.doc).length, e: m.quadrants, j: m.score }
      if (!best || compare(c, best.c) < 0) best = { doc: r.doc, name: l.name, swaps: r.swaps, c }
    }
  }
  tryLayouts(layouts)
  // paletes espaçados (vãos entre eles) só quando a carga travada não alcança a regra
  const tight = best
  if (opts.spread && !(tight && tight.c.phys === 0 && tight.c.e.ok)) {
    const spaced: { name: string; doc: LoadDoc }[] = []
    for (const l of compact)
      for (const f of [1, 0.75, 0.5, 0.25]) {
        const sp = spreadAlongLength(l.doc, f)
        if (sp !== l.doc) spaced.push({ name: `${l.name}, espaçado`, doc: sp })
      }
    tryLayouts(spaced)
  }
  const cur = { phys: issues0.length, e: before.quadrants, j: before.score }
  if (!best || compare(best.c, cur) >= -1e-6) {
    const reason = before.quadrants.ok
      ? undefined
      : 'Não foi possível alcançar a distribuição de peso requerida com a composição atual: nenhuma reorganização dos paletes móveis melhora a distribuição.'
    return none(issues0.length ? `A carga tem ${issues0.length} problema(s) físico(s) (ex.: ${issues0[0].message}). ${reason ?? ''}`.trim() : reason ?? 'A distribuição atual já é a melhor encontrada.')
  }
  const after = balanceMetrics(best.doc, rules)
  const meets = after.quadrants.ok && best.c.phys === 0
  let reason: string | undefined
  if (!meets)
    reason =
      best.c.phys > 0
        ? `Ainda restam ${best.c.phys} problema(s) físico(s): nem todos os paletes cabem sem conflito neste equipamento.`
        : 'Não foi possível alcançar a distribuição de peso requerida com a composição atual. Esta é a melhor alternativa encontrada.'
  return {
    ...base,
    doc: best.doc,
    after,
    swaps: best.swaps,
    strategy: best.name,
    spread: best.name.includes('espaçado'),
    meetsRules: meets,
    reason,
    physicalIssuesAfter: best.c.phys,
  }
}
