/**
 * OTIMIZADOR DE PALETES MISTOS (determinístico, sem IA).
 *
 * Recebe o PEDIDO (caixas por SKU) e devolve a composição de cada palete — cada caixa com produto,
 * posição X/Y/Z e orientação — minimizando posições de piso / quantidade de paletes sem violar
 * altura, peso, apoio ou borda do palete. As quantidades por palete são RESULTADO da geometria.
 *
 * Estratégia:
 *  1. Classes de caixa: SKUs com caixa de mesmas medidas são intercambiáveis numa camada
 *     (ex.: HS-500L/1K/2K; HS-15K/20K; HS-30K/40K).
 *  2. Para cada classe × tipo de palete: melhor padrão de camada (bestLayer) → caixas por camada.
 *  3. Enumeração das atribuições classe → tipo de palete (simples / duplo / …).
 *  4. Camadas COMPLETAS distribuídas entre paletes (altura + peso) por várias heurísticas:
 *     maiores primeiro (altura), mais pesadas primeiro, melhor encaixe e mochila sucesiva (DP exata
 *     por palete). Dentro de cada palete, camadas mais pesadas embaixo.
 *  5. Caixas que sobram (restos) sobem como "topo": empacotamento 2D (MaxRects) sobre a face de
 *     cima das caixas de baixo — cada caixa fica 100% apoiada e nunca maior que a base. O que não
 *     couber abre novos paletes pelo mesmo método.
 *  6. Escolha lexicográfica: caixas não colocadas → posições de piso → nº de paletes →
 *     volume vazio → alturas parelhas. Validação física completa (validatePallet) no resultado.
 */
import { bestLayer, interlockedSlots, LayerPattern } from './autopallet'
import { autoOrientations } from './orientation'
import { palletCompanionNeeds } from './companions'
import { Dims, Orientation, orientDims, Vec3 } from './geometry'
import { fmt, Issue } from './issues'
import { KIT_BOX_MIN_SUPPORT_PCT, kitBaseOf, kitFallback, kitFamilyOf, kitFillPack, KitFill, kitLayerEstimate, packKeyOf, packKits } from './kitBoxes'
import { palletSummary, validatePallet } from './pallet'
import { findFreePosition, Obstacle } from './placement'
import type { PackSnapshot, PalletDoc, PalletItem, PalletTypeSnapshot, SpaceSnapshot } from './types'

// ---------------------------------------------------------------------------
// Entradas / saídas
// ---------------------------------------------------------------------------

export interface OrderLine {
  /** chave da embalagem (ex.: pv123) */
  packId: string
  pack: PackSnapshot
  /** quantidade de CAIXAS pedidas */
  boxes: number
}

/** COURIER = paqueteria (DHL, FedEx…): sem palete nem equipamento, cada caixa é um volume (ver courier.ts) */
export type TransportMode = 'FCL' | 'LCL' | 'AIR' | 'ROAD' | 'PALLETS_ONLY' | 'COURIER'

export const TRANSPORT_LABEL: Record<TransportMode, string> = {
  FCL: 'Marítimo FCL (contêiner completo)',
  LCL: 'Marítimo consolidado (LCL)',
  AIR: 'Aéreo',
  ROAD: 'Rodoviário',
  PALLETS_ONLY: 'Só otimização de paletes',
  COURIER: 'Courier / paqueteria (DHL, FedEx…) — caixas soltas, sem palete',
}

export interface MixedOptions {
  /** tipos de palete candidatos (o motor escolhe por classe de caixa) */
  palletTypes: PalletTypeSnapshot[]
  /** altura máxima do palete CARREGADO (tabuleiro + caixas), mm */
  maxHeightMm: number
  /** carga máxima por palete (kg sobre o tabuleiro); o motor usa a menor entre esta e a capacidade cadastrada do tipo */
  maxLoadKg?: number | null
  /** limite de combinações classe→tipo avaliadas */
  maxCombos?: number
  /**
   * paletes de reserva (ex.: palete padrão do produto): usados só pelas caixas que não cabem em
   * nenhum dos paletes de palletTypes (ex.: regra logística 1,15 × 1,15 e caixa de 2,25 m)
   */
  fallbackPalletTypes?: PalletTypeSnapshot[]
}

export interface MixedPalletLine {
  sku: string
  name: string
  boxes: number
  units: number
  grossKg: number
}

export interface MixedPallet {
  doc: PalletDoc
  /** altura total (tabuleiro + carga) */
  heightMm: number
  /** bruto do palete (caixas + tara + acessórios) */
  grossKg: number
  netKg: number
  /** volume das caixas / (área do palete × altura útil) */
  volumeUtilPct: number
  /** medidas EXTERNAS do palete montado (inclui caixas que excedem o tabuleiro) — base da cubagem do frete */
  outerMm: { l: number; w: number; h: number }
  /** cubagem do palete = C × L × A externos (m³) */
  cbm: number
  lines: MixedPalletLine[]
  issues: Issue[]
}

export interface MixedResult {
  pallets: MixedPallet[]
  /** posições de piso equivalentes (palete duplo = 2) */
  positions: number
  totals: { pallets: number; boxes: number; units: number; netKg: number; grossKg: number; cbm: number }
  /** conferência pedido × resultado por SKU */
  check: { sku: string; name: string; requested: number; placed: number; ok: boolean }[]
  unplaced: { sku: string; boxes: number; reason: string }[]
  ok: boolean
  strategy: string
  evaluated: number
  maxHeightMm: number
  /** observações do motor (ex.: palete de reserva usado) */
  notes: string[]
}

/**
 * Altura máxima do palete carregado conforme o transporte.
 * FCL/rodoviário: altura útil do equipamento E da porta (a mais restritiva), e limite de altura dos perfis.
 * Aéreo/LCL/só paletes: valor informado (depende do operador); sem valor, usa o equipamento se houver.
 */
export function transportMaxHeight(mode: TransportMode, space: SpaceSnapshot | null, manualMm?: number | null, profileHeightMm?: number | null): number | null {
  const eq = space ? Math.min(space.inner.h, space.door.h) : null
  const prof = profileHeightMm ?? null
  const pick = (...v: (number | null | undefined)[]) => {
    const xs = v.filter((x): x is number => x != null && x > 0)
    return xs.length ? Math.min(...xs) : null
  }
  if (mode === 'FCL' || mode === 'ROAD') return eq == null && !manualMm ? null : pick(eq, prof, manualMm)
  // aéreo/LCL/só paletes: sem altura informada nem ULD, não há como saber (depende do operador)
  if (!manualMm && eq == null) return null
  return pick(manualMm ?? eq, prof)
}

// ---------------------------------------------------------------------------
// Classes de caixa, camadas
// ---------------------------------------------------------------------------

interface BoxClass {
  key: string
  rep: PackSnapshot
  /** caixas da classe, uma entrada por caixa, mais pesadas primeiro */
  queue: string[]
}

/** orientações que o motor pode usar (permitidas no cadastro, distintas e estáveis) — domain/orientation */
const autoOf = (p: PackSnapshot): Orientation[] => autoOrientations(p.dims, p.allowedOrientations)

/**
 * Plano de camada de uma classe num tipo de palete: escolhe a FACE APOIADA (qual dimensão fica na
 * vertical) entre as orientações estáveis permitidas e o padrão com mais caixas por mm de altura
 * (empate: em pé, como cadastrado). Os slots do padrão usam dimensões "virtuais"; eal traduz.
 */
interface LayerPlan {
  pat: LayerPattern
  h: number
  vdims: Dims
  real: Record<'LWH' | 'WLH', Orientation>
}

function layerPlan(t: PalletTypeSnapshot, rep: PackSnapshot, opts: MixedOptions): LayerPlan | null {
  const H = usableH(t, opts)
  const ok = autoOf(rep)
  const dimOf = { L: rep.dims.l, W: rep.dims.w, H: rep.dims.h }
  let best: LayerPlan | null = null
  let bestScore = -1
  for (const v of ['H', 'W', 'L'] as const) {
    const [a, b] = (['L', 'W', 'H'] as const).filter((x) => x !== v)
    const vdims: Dims = { l: dimOf[a], w: dimOf[b], h: dimOf[v] }
    if (vdims.h > H) continue
    const ab = `${a}${b}${v}` as Orientation, ba = `${b}${a}${v}` as Orientation
    const same = vdims.l === vdims.w
    const vAllowed: Orientation[] = []
    if (ok.includes(ab) || (same && ok.includes(ba))) vAllowed.push('LWH')
    if (!same && ok.includes(ba)) vAllowed.push('WLH')
    if (!vAllowed.length) continue
    const pat = bestLayer(t, { ...rep, dims: vdims, allowedOrientations: vAllowed })
    if (!pat.slots.length || pat.sizeX > t.dims.l || pat.sizeY > t.dims.w) continue
    const score = pat.slots.length / vdims.h
    if (score > bestScore + 1e-12) {
      bestScore = score
      best = { pat, h: vdims.h, vdims, real: { LWH: ok.includes(ab) ? ab : ba, WLH: ba } }
    }
  }
  return best
}

function classesOf(order: OrderLine[], companionSkus: Set<string>): BoxClass[] {
  const map = new Map<string, BoxClass>()
  // acompanhantes (ex.: kit Hydroforce) não formam camadas: vão por cima do palete do produto principal
  const sorted = [...order].filter((o) => o.boxes > 0 && !companionSkus.has(o.pack.sku)).sort((a, b) => b.pack.grossKg - a.pack.grossKg || a.pack.sku.localeCompare(b.pack.sku))
  for (const o of sorted) {
    const d = o.pack.dims
    const key = `${d.l}x${d.w}x${d.h}|${[...o.pack.allowedOrientations].sort().join(',')}`
    const c = map.get(key) ?? { key, rep: o.pack, queue: [] }
    for (let i = 0; i < o.boxes; i++) c.queue.push(o.packId)
    map.set(key, c)
  }
  return [...map.values()]
}

interface Layer {
  cls: number
  type: number
  packIds: string[]
  h: number
  kg: number
  /** envelope da camada (centralizado no palete) */
  ex: number
  ey: number
  /** acompanhantes exigidos pelas caixas desta camada (por SKU) */
  kits: Record<string, number>
}

const addKits = (a: Record<string, number>, b: Record<string, number>) => {
  const o = { ...a }
  for (const [k, v] of Object.entries(b)) o[k] = (o[k] ?? 0) + v
  return o
}

/** Apoio de uma camada sobre a de baixo (envelopes centralizados): fração da área de cima apoiada. */
const LAYER_MIN_SUPPORT = 0.9
const supportOf = (up: Layer, down: Layer) => (Math.min(up.ex, down.ex) * Math.min(up.ey, down.ey)) / (up.ex * up.ey)
const byWeight = (a: Layer, b: Layer) => b.kg - a.kg || b.ex * b.ey - a.ex * a.ey || b.h - a.h || a.cls - b.cls
const byArea = (a: Layer, b: Layer) => b.ex * b.ey - a.ex * a.ey || b.kg - a.kg || b.h - a.h || a.cls - b.cls
const chainSupported = (s: Layer[]) => s.every((L, i) => i === 0 || supportOf(L, s[i - 1]) >= LAYER_MIN_SUPPORT)

/**
 * Ordem física das camadas num palete: mais PESADAS embaixo quando cada camada fica ≥ 90% apoiada
 * na de baixo; senão, a de maior envelope embaixo. Nunca uma camada grande sobre uma pequena.
 */
function physicalOrder(ls: Layer[]): Layer[] {
  const w = [...ls].sort(byWeight)
  return chainSupported(w) ? w : [...ls].sort(byArea)
}

/** Camadas empilháveis entre si (alguma ordem física com apoio ≥ 90% em todas). */
function chainOk(ls: Layer[]): boolean {
  return chainSupported(physicalOrder(ls))
}
/** mesma regra da validação (palletMaxLoadKg: menor entre dinâmica, estática e carga máx.), limitada pela opção */
const capOf = (t: PalletTypeSnapshot, opts: MixedOptions) => {
  const vals = [t.dynamicMaxKg, t.staticMaxKg, t.maxLoadKg, opts.maxLoadKg].filter((v): v is number => v != null && v > 0)
  return vals.length ? Math.min(...vals) : Infinity
}
const usableH = (t: PalletTypeSnapshot, opts: MixedOptions) => opts.maxHeightMm - t.dims.h

// ---------------------------------------------------------------------------
// Distribuição das camadas completas (bin packing 2D: altura × peso)
// ---------------------------------------------------------------------------

type Bins = number[][]

type KitCost = { h: (k: Record<string, number>) => number; kg: (k: Record<string, number>) => number }
const NO_KITS: KitCost = { h: () => 0, kg: () => 0 }

function firstFit(layers: Layer[], order: number[], H: number, W: number, best: boolean, kit: KitCost = NO_KITS): Bins {
  const bins: { idx: number[]; h: number; w: number; kits: Record<string, number> }[] = []
  for (const i of order) {
    const L = layers[i]
    let target = -1
    for (let b = 0; b < bins.length; b++) {
      const k = addKits(bins[b].kits, L.kits)
      // altura e peso incluem os acompanhantes que irão por cima do palete
      if (bins[b].h + L.h + kit.h(k) > H || bins[b].w + L.kg + kit.kg(k) > W + 1e-6) continue
      if (!chainOk([...bins[b].idx.map((i) => layers[i]), L])) continue
      if (!best) {
        target = b
        break
      }
      if (target < 0 || H - bins[b].h - L.h < H - bins[target].h - L.h) target = b
    }
    if (target < 0) bins.push({ idx: [i], h: L.h, w: L.kg, kits: { ...L.kits } })
    else {
      bins[target].idx.push(i)
      bins[target].h += L.h
      bins[target].w += L.kg
      bins[target].kits = addKits(bins[target].kits, L.kits)
    }
  }
  return bins.map((b) => b.idx)
}

/**
 * Mochila sucessiva: cada palete recebe o subconjunto que mais usa a altura (peso como desempate/limite).
 * Kits por cima: perLayer = cada camada reserva a camada de kits só dela (conservador: 2 HF 5K "pagam"
 * 200 mm de kits); amortizado = altura da camada de kits de todo o pedido ÷ kits (uma caixa coletiva leva
 * dezenas de kits). As duas concorrem (solve); em ambas o palete é conferido com a camada de kits real.
 */
function successiveKnapsack(layers0: Layer[], H: number, W: number, kit: KitCost = NO_KITS, amortized = false): Bins {
  const all = layers0.reduce((k, L) => addKits(k, L.kits), {} as Record<string, number>)
  const perKitH = Object.fromEntries(Object.entries(all).map(([sku, n]) => [sku, n > 0 ? kit.h({ [sku]: n }) / n : 0]))
  const kitH = (k: Record<string, number>) => (amortized ? Object.entries(k).reduce((s, [sku, n]) => s + (perKitH[sku] ?? 0) * n, 0) : kit.h(k))
  const layers = layers0.map((L) => ({ ...L, h: Math.ceil(L.h + kitH(L.kits)), kg: L.kg + kit.kg(L.kits) }))
  // altura/peso REAIS de um palete (camada de kits do palete inteiro)
  const real = (ids: number[]) => {
    let h = 0, w = 0, k: Record<string, number> = {}
    for (const i of ids) {
      h += layers0[i].h
      w += layers0[i].kg
      k = addKits(k, layers0[i].kits)
    }
    return { h: h + kit.h(k), w: w + kit.kg(k) }
  }
  let rest = layers.map((_, i) => i)
  const bins: Bins = []
  while (rest.length) {
    const n = rest.length
    // dp[h] = menor peso para atingir exatamente a altura h; choice[k][h] = usou a camada k
    const dp = new Float64Array(H + 1).fill(Infinity)
    dp[0] = 0
    const take: Uint8Array[] = []
    for (let k = 0; k < n; k++) {
      const L = layers[rest[k]]
      const t = new Uint8Array(H + 1)
      for (let h = H; h >= L.h; h--) {
        const w = dp[h - L.h] + L.kg
        if (w <= W + 1e-6 && w < dp[h]) {
          dp[h] = w
          t[h] = 1
        }
      }
      take.push(t)
    }
    let hBest = 0
    for (let h = H; h > 0; h--)
      if (dp[h] < Infinity) {
        hBest = h
        break
      }
    if (hBest === 0) {
      bins.push([rest[0]])
      rest = rest.slice(1)
      continue
    }
    // reconstrução
    const chosen: number[] = []
    let h = hBest
    for (let k = n - 1; k >= 0 && h > 0; k--) {
      if (take[k][h]) {
        chosen.push(rest[k])
        h -= layers[rest[k]].h
      }
    }
    if (h !== 0) {
      // reconstrução ambígua (tabela sobrescrita): cai para first-fit desta rodada
      bins.push(...firstFit(layers0, rest, H, W, false, kit))
      break
    }
    // mantém só uma cadeia empilhável (maiores embaixo); o resto volta para os próximos paletes
    const ordered = chosen.map((i) => layers[i]).sort(byArea)
    const keep: Layer[] = []
    for (const L of ordered) if (chainOk([...keep, L])) keep.push(L)
    chosen.splice(0, chosen.length, ...chosen.filter((i) => keep.includes(layers[i])))
    // a amortização pode subestimar a camada de kits deste palete: tira as camadas mais leves até caber
    while (chosen.length > 1) {
      const r = real(chosen)
      if (r.h <= H && r.w <= W + 1e-6) break
      const lightest = chosen.reduce((a, b) => (byWeight(layers0[a], layers0[b]) >= 0 ? a : b))
      chosen.splice(chosen.indexOf(lightest), 1)
    }
    bins.push(chosen)
    const set = new Set(chosen)
    rest = rest.filter((i) => !set.has(i))
  }
  return bins
}

// ---------------------------------------------------------------------------
// MaxRects 2D (empacotamento das caixas de topo sobre uma face retangular)
// ---------------------------------------------------------------------------

interface Rect {
  x: number
  y: number
  w: number
  l: number
}

class MaxRects {
  free: Rect[]
  constructor(r: Rect) {
    this.free = [r]
  }
  /** melhor encaixe pelo lado menor (BSSF); devolve a posição ou null */
  find(dx: number, dy: number): { x: number; y: number } | null {
    let best: { x: number; y: number; s: number; l: number } | null = null
    for (const f of this.free) {
      if (dx <= f.w && dy <= f.l) {
        const s = Math.min(f.w - dx, f.l - dy), l = Math.max(f.w - dx, f.l - dy)
        if (!best || s < best.s || (s === best.s && (l < best.l || (l === best.l && (f.y < best.y || (f.y === best.y && f.x < best.x)))))) best = { x: f.x, y: f.y, s, l }
      }
    }
    return best ? { x: best.x, y: best.y } : null
  }
  place(r: Rect) {
    const next: Rect[] = []
    for (const f of this.free) {
      if (r.x >= f.x + f.w || r.x + r.w <= f.x || r.y >= f.y + f.l || r.y + r.l <= f.y) {
        next.push(f)
        continue
      }
      if (r.x > f.x) next.push({ x: f.x, y: f.y, w: r.x - f.x, l: f.l })
      if (r.x + r.w < f.x + f.w) next.push({ x: r.x + r.w, y: f.y, w: f.x + f.w - r.x - r.w, l: f.l })
      if (r.y > f.y) next.push({ x: f.x, y: f.y, w: f.w, l: r.y - f.y })
      if (r.y + r.l < f.y + f.l) next.push({ x: f.x, y: r.y + r.l, w: f.w, l: f.y + f.l - r.y - r.l })
    }
    // remove retângulos contidos em outros
    this.free = next.filter((a, i) => !next.some((b, j) => j !== i && a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.l <= b.y + b.l && (j < i || a.x !== b.x || a.y !== b.y || a.w !== b.w || a.l !== b.l)))
  }
}

// ---------------------------------------------------------------------------
// Montagem de um palete
// ---------------------------------------------------------------------------

interface Built {
  type: number
  items: { packId: string; x: number; y: number; z: number; o: Orientation }[]
  /** topo usado (sobre o tabuleiro) */
  top: number
  kg: number
  /** faces de apoio no topo das camadas completas (calculadas em buildLayers) */
  topFaces?: (Rect & { z: number })[]
}

interface Ctx {
  order: OrderLine[]
  packs: Map<string, PackSnapshot>
  classes: BoxClass[]
  types: PalletTypeSnapshot[]
  patterns: (LayerPlan | null)[][] // [classe][tipo]
  opts: MixedOptions
  /**
   * acompanhantes do pedido (ex.: KIT-HF): embalagem INDIVIDUAL (base das caixas coletivas), altura a
   * reservar por cima (caixa coletiva de kits = 250 mm) e quantas individuais cabem por camada em cada tipo
   */
  kits: Map<string, { packId: string; pack: PackSnapshot; z: number; perLayer: number[] }>
}

/** Altura/peso extra dos acompanhantes por cima de um palete do tipo ti (camada de kits, com a tara das caixas). */
function kitCost(ctx: Ctx, ti: number): KitCost {
  const est = (sku: string, n: number) => {
    const info = ctx.kits.get(sku)
    if (!info || n <= 0) return { h: 0, kg: 0 }
    // kits em caixas coletivas (26 / meia caixa / individuais): domain/kitBoxes
    if (kitFamilyOf(sku)) return kitLayerEstimate(n, info.pack, ctx.types[ti].dims)
    return { h: Math.ceil(n / Math.max(1, info.perLayer[ti])) * info.z, kg: info.pack.grossKg * n }
  }
  return {
    h: (k) => Object.entries(k).reduce((s, [sku, n]) => s + est(sku, n).h, 0),
    kg: (k) => Object.entries(k).reduce((s, [sku, n]) => s + est(sku, n).kg, 0),
  }
}

/** Acompanhantes exigidos por um conjunto de caixas (só os que estão no pedido). */
function kitsOf(ctx: Ctx, ids: string[]): Record<string, number> {
  const o: Record<string, number> = {}
  for (const id of ids)
    for (const c of ctx.packs.get(id)?.companions ?? [])
      if (ctx.kits.has(c.sku)) o[c.sku] = (o[c.sku] ?? 0) + c.qty
  return o
}

/** Coloca camadas completas (pesadas embaixo), centralizadas, alternando o padrão travado. */
function buildLayers(ctx: Ctx, type: number, layers: Layer[]): Built {
  const t = ctx.types[type]
  const sorted = physicalOrder(layers)
  const b: Built = { type, items: [], top: 0, kg: 0 }
  sorted.forEach((L, li) => {
    const plan = ctx.patterns[L.cls][type]!
    const pat = plan.pat
    // travar camadas (padrão espelhado alternado) só se a camada não tem vãos: senão uma caixa de cima
    // poderia ficar sobre um vão da de baixo
    const area = pat.slots.reduce((a, s) => {
      const d = orientDims(plan.vdims, s.orientation)
      return a + d.x * d.y
    }, 0)
    const alt = area >= pat.sizeX * pat.sizeY - 1 ? interlockedSlots(pat, plan.vdims) : null
    const slots = alt && li % 2 === 1 ? alt : pat.slots
    const ox = Math.round((t.dims.l - pat.sizeX) / 2), oy = Math.round((t.dims.w - pat.sizeY) / 2)
    const faces: (Rect & { z: number })[] = []
    slots.forEach((s, k) => {
      const id = L.packIds[k]
      if (id == null) return
      b.items.push({ packId: id, x: ox + s.x, y: oy + s.y, z: b.top, o: plan.real[s.orientation as 'LWH' | 'WLH'] ?? s.orientation })
      b.kg += ctx.packs.get(id)!.grossKg
      const d = orientDims(plan.vdims, s.orientation)
      faces.push({ x: ox + s.x, y: oy + s.y, w: d.x, l: d.y, z: b.top + L.h })
    })
    b.top += L.h
    // camada sem vãos: o topo é uma face única (envelope); com vãos (ex.: cata-vento, blocos), cada caixa é uma face
    const covered = faces.reduce((a, f) => a + f.w * f.l, 0)
    b.topFaces = covered >= pat.sizeX * pat.sizeY - 1 ? [{ x: ox, y: oy, w: pat.sizeX, l: pat.sizeY, z: b.top }] : faces
  })
  return b
}

/** Faces de apoio do topo de um palete: topo da última camada completa (sem vãos), ou o tabuleiro inteiro. */
function topRegions(ctx: Ctx, b: Built, lastLayerCls: number | null): (Rect & { z: number })[] {
  const t = ctx.types[b.type]
  if (lastLayerCls == null || !b.topFaces?.length) return [{ x: 0, y: 0, w: t.dims.l, l: t.dims.w, z: 0 }]
  return b.topFaces
}

/**
 * Empilha caixas soltas sobre as faces disponíveis (níveis): cada caixa colocada vira uma nova face.
 * Caixas maiores/mais pesadas primeiro; uma caixa só vai sobre uma face que a contém (100% apoiada).
 */
function stackOnFaces(ctx: Ctx, b: Built, faces: (Rect & { z: number })[], pool: string[]): string[] {
  const t = ctx.types[b.type]
  const H = usableH(t, ctx.opts), W = capOf(t, ctx.opts)
  let rest = [...pool]
  const queue = [...faces]
  while (queue.length && rest.length) {
    queue.sort((p, q) => p.z - q.z || q.w * q.l - p.w * p.l)
    const f = queue.shift()!
    const mr = new MaxRects({ x: f.x, y: f.y, w: f.w, l: f.l })
    const left: string[] = []
    for (const id of rest) {
      const p = ctx.packs.get(id)!
      if (b.kg + p.grossKg > W + 1e-6) {
        left.push(id)
        continue
      }
      let spot: { x: number; y: number; o: Orientation; dx: number; dy: number; dz: number } | null = null
      const reserve = Math.max(0, ...(p.companions ?? []).map((c) => ctx.kits.get(c.sku)?.z ?? 0))
      for (const o of autoOf(p)) {
        const d = orientDims(p.dims, o)
        if (f.z + d.z + reserve > H) continue
        const s = mr.find(d.x, d.y)
        if (s) {
          spot = { ...s, o, dx: d.x, dy: d.y, dz: d.z }
          break
        }
      }
      if (!spot) {
        left.push(id)
        continue
      }
      mr.place({ x: spot.x, y: spot.y, w: spot.dx, l: spot.dy })
      b.items.push({ packId: id, x: spot.x, y: spot.y, z: f.z, o: spot.o })
      b.kg += p.grossKg
      b.top = Math.max(b.top, f.z + spot.dz)
      queue.push({ x: spot.x, y: spot.y, w: spot.dx, l: spot.dy, z: f.z + spot.dz })
    }
    rest = left
  }
  return rest
}

// ---------------------------------------------------------------------------
// Solução completa para uma atribuição classe → tipo e uma heurística
// ---------------------------------------------------------------------------

interface Solution {
  built: Built[]
  unplaced: string[]
  /** acompanhantes (em kits) que não couberam por cima do palete do produto principal */
  unplacedKits: { sku: string; n: number; reason: string }[]
  name: string
}

/**
 * Posições candidatas para as caixas coletivas de kits: grade de quartos (570 × 570) centralizada no
 * tabuleiro, em cada nível de topo, e a caixa alinhada às bordas de cada caixa de baixo (encostada no
 * canto mínimo ou máximo, dentro do tabuleiro). Os pontos extremos sozinhos não acham a caixa de 26
 * sobre o cata-vento do HF 2K (topo 1100 × 1100, caixa 1140 × 570), nem sobre 2 caixas soltas por cima
 * da última camada (só alinhada a elas a caixa de 26 fica ≥ 90% apoiada).
 */
function kitGrid(obstacles: Obstacle[], deck: { l: number; w: number }, q: number, size?: Vec3): Vec3[] {
  const nx = Math.max(1, Math.floor(deck.l / q)), ny = Math.max(1, Math.floor(deck.w / q))
  const x0 = Math.max(0, Math.round((deck.l - nx * q) / 2)), y0 = Math.max(0, Math.round((deck.w - ny * q) / 2))
  const zs = [...new Set([0, ...obstacles.map((o) => o.box.min.z + o.box.size.z)])]
  const out: Vec3[] = []
  for (const z of zs) for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) out.push({ x: x0 + i * q, y: y0 + j * q, z })
  if (size) {
    const seen = new Set(out.map((p) => `${p.x}|${p.y}|${p.z}`))
    const cx = (v: number) => Math.max(0, Math.min(deck.l - size.x, v)), cy = (v: number) => Math.max(0, Math.min(deck.w - size.y, v))
    for (const o of obstacles) {
      const z = o.box.min.z + o.box.size.z
      for (const x of [o.box.min.x, o.box.min.x + o.box.size.x - size.x])
        for (const y of [o.box.min.y, o.box.min.y + o.box.size.y - size.y]) {
          const p = { x: cx(x), y: cy(y), z }
          const k = `${p.x}|${p.y}|${p.z}`
          if (!seen.has(k)) {
            seen.add(k)
            out.push(p)
          }
        }
    }
  }
  return out
}

/**
 * Coloca as caixas de kits `fills` (maiores primeiro) sobre os obstáculos, dentro do tabuleiro e até
 * maxZ. Caixa coletiva ≥ 90% apoiada; individual 100%. Se uma caixa não couber: a de 26 vira 2 meias
 * caixas, a meia caixa vira individuais (kitFallback). `obstacles` recebe as caixas colocadas.
 */
function placeKitBoxes(
  obstacles: Obstacle[],
  deck: { l: number; w: number },
  maxZ: number,
  kgLeft: number,
  base: PackSnapshot,
  baseId: string,
  fills: KitFill[],
): { placed: { packId: string; pack: PackSnapshot; pos: Vec3; o: Orientation }[]; kits: number } {
  const fam = kitFamilyOf(base.sku)
  const rank = { BIG: 0, HALF: 1, IND: 2 }
  const queue = [...fills]
  const placed: { packId: string; pack: PackSnapshot; pos: Vec3; o: Orientation }[] = []
  let kits = 0
  let kg = 0
  while (queue.length) {
    const f = queue.shift()!
    const { packId, pack } = kitFillPack(base, baseId, f)
    let spot: { pos: Vec3; o: Orientation; size: Vec3 } | null = null
    if (kg + pack.grossKg <= kgLeft + 1e-6) {
      // a orientação que deixa a caixa mais baixa (empate: a primeira)
      for (const o of autoOf(pack)) {
        const size = orientDims(pack.dims, o)
        const extra = f.box !== 'IND' && fam ? kitGrid(obstacles, deck, fam.half.dims.l, size) : undefined
        const pos = findFreePosition(obstacles, size, { lo: { x: 0, y: 0, z: 0 }, hi: { x: deck.l, y: deck.w, z: maxZ }, allowStacking: true, minSupportPct: f.box === 'IND' ? 100 : KIT_BOX_MIN_SUPPORT_PCT, extra })
        if (pos && (!spot || pos.z < spot.pos.z)) spot = { pos, o, size }
      }
    }
    if (!spot) {
      const fb = kitFallback(f, base.sku)
      if (fb.length) {
        queue.push(...fb)
        queue.sort((a, b) => rank[a.box] - rank[b.box] || b.kits - a.kits)
      }
      continue
    }
    obstacles.push({ box: { min: spot.pos, size: spot.size }, stackable: true })
    placed.push({ packId, pack, pos: spot.pos, o: spot.o })
    kits += f.kits
    kg += pack.grossKg
  }
  return { placed, kits }
}

/**
 * Coloca os kits exigidos pelas caixas deste palete, por cima (até a altura máx.), em caixas coletivas
 * pela regra de domain/kitBoxes (1 kit por caixa do produto, nunca mais que o pedido).
 */
function placeKits(ctx: Ctx, b: Built, left: Map<string, number>, unplaced: Solution['unplacedKits']) {
  const need = kitsOf(ctx, b.items.map((i) => i.packId))
  const t = ctx.types[b.type]
  const H = usableH(t, ctx.opts), W = capOf(t, ctx.opts)
  for (const [sku, n] of Object.entries(need)) {
    const take = Math.min(Math.ceil(n - 1e-9), left.get(sku) ?? 0)
    if (take <= 0) continue
    left.set(sku, (left.get(sku) ?? 0) - take)
    const info = ctx.kits.get(sku)!
    const obstacles: Obstacle[] = b.items.map((i) => ({ box: { min: { x: i.x, y: i.y, z: i.z }, size: orientDims(ctx.packs.get(i.packId)!.dims, i.o) }, stackable: true }))
    const r = placeKitBoxes(obstacles, t.dims, H, W - b.kg, info.pack, info.packId, packKits(take, sku))
    for (const p of r.placed) {
      ctx.packs.set(p.packId, p.pack)
      b.items.push({ packId: p.packId, x: p.pos.x, y: p.pos.y, z: p.pos.z, o: p.o })
      b.kg += p.pack.grossKg
      b.top = Math.max(b.top, p.pos.z + orientDims(p.pack.dims, p.o).z)
    }
    if (r.kits < take) unplaced.push({ sku, n: take - r.kits, reason: 'sem espaço/altura por cima do palete do produto principal' })
  }
}

/**
 * Índices (em items) das caixas SOLTAS (depois das camadas completas) que podem sair do palete sem tirar o
 * apoio de outra (nada por cima; de cima para baixo, repetindo). withKits = false: só as que não pedem
 * acompanhante.
 */
function looseRemovable(ctx: Ctx, items: Built['items'], layered: number, withKits: boolean): number[] {
  const box = (i: number) => {
    const it = items[i]
    const d = orientDims(ctx.packs.get(it.packId)!.dims, it.o)
    return { x0: it.x, y0: it.y, x1: it.x + d.x, y1: it.y + d.y, z0: it.z, z1: it.z + d.z }
  }
  const needsKit = (i: number) => (ctx.packs.get(items[i].packId)?.companions ?? []).some((c) => ctx.kits.has(c.sku))
  const left = new Set(items.map((_, i) => i))
  const out: number[] = []
  for (let changed = true; changed; ) {
    changed = false
    for (let i = layered; i < items.length; i++) {
      if (!left.has(i) || (!withKits && needsKit(i)) || ctx.kits.has(ctx.packs.get(items[i].packId)!.sku)) continue
      const A = box(i)
      const covered = [...left].some((j) => {
        if (j === i) return false
        const B = box(j)
        return Math.abs(B.z0 - A.z1) < 1 && Math.min(A.x1, B.x1) > Math.max(A.x0, B.x0) && Math.min(A.y1, B.y1) > Math.max(A.y0, B.y0)
      })
      if (covered) continue
      left.delete(i)
      out.push(i)
      changed = true
    }
  }
  return out
}

type Heuristic = 'ffd-h' | 'ffd-kg' | 'bfd' | 'knap' | 'knap-kit'

function solve(ctx: Ctx, assign: number[], heuristic: Heuristic): Solution {
  const built: Built[] = []
  const unplaced: string[] = []
  const unplacedKits: Solution['unplacedKits'] = []
  // kits do pedido ainda por colocar, por SKU (em unidades = kits)
  const kitLeft = new Map<string, number>()
  for (const o of ctx.order) if (ctx.kits.has(o.pack.sku)) kitLeft.set(o.pack.sku, (kitLeft.get(o.pack.sku) ?? 0) + o.boxes * Math.max(1, o.pack.unitsPerPackage))
  for (let ti = 0; ti < ctx.types.length; ti++) {
    const t = ctx.types[ti]
    const H = usableH(t, ctx.opts), W = capOf(t, ctx.opts)
    const layers: Layer[] = []
    const pool: string[] = []
    ctx.classes.forEach((c, ci) => {
      if (assign[ci] !== ti) return
      const plan = ctx.patterns[ci][ti]!
      const cap = plan.pat.slots.length
      const kgBox = (id: string) => ctx.packs.get(id)!.grossKg
      const full = Math.floor(c.queue.length / cap)
      for (let k = 0; k < full; k++) {
        const ids = c.queue.slice(k * cap, (k + 1) * cap)
        layers.push({ cls: ci, type: ti, packIds: ids, h: plan.h, kg: ids.reduce((s, id) => s + kgBox(id), 0), ex: plan.pat.sizeX, ey: plan.pat.sizeY, kits: kitsOf(ctx, ids) })
      }
      pool.push(...c.queue.slice(full * cap))
    })
    if (!layers.length && !pool.length) continue
    const idx = layers.map((_, i) => i)
    const kc = kitCost(ctx, ti)
    const bins =
      heuristic === 'knap' || heuristic === 'knap-kit'
        ? successiveKnapsack(layers, H, W, kc, heuristic === 'knap-kit')
        : firstFit(layers, heuristic === 'ffd-kg' ? idx.sort((a, b) => layers[b].kg - layers[a].kg || layers[b].h - layers[a].h) : idx.sort((a, b) => layers[b].h - layers[a].h || layers[b].kg - layers[a].kg), H, W, heuristic === 'bfd', kc)
    // layered = caixas das camadas completas (as seguintes são soltas, de stackOnFaces)
    const mine: { b: Built; lastCls: number | null; layered: number }[] = bins.map((bin) => {
      const ls = bin.map((i) => layers[i])
      const b = buildLayers(ctx, ti, ls)
      const last = physicalOrder(ls).at(-1)
      return { b, lastCls: last ? last.cls : null, layered: b.items.length }
    })
    // restos: maiores/mais pesados primeiro
    let rest = [...pool].sort((a, b) => {
      const p = ctx.packs.get(a)!, q = ctx.packs.get(b)!
      return q.dims.l * q.dims.w - p.dims.l * p.dims.w || q.grossKg - p.grossKg || q.dims.h - p.dims.h || a.localeCompare(b)
    })
    // primeiro nos paletes existentes com mais altura livre
    for (const m of [...mine].sort((a, c) => a.b.top - c.b.top)) {
      if (!rest.length) break
      rest = stackOnFaces(ctx, m.b, topRegions(ctx, m.b, m.lastCls), rest)
    }
    // o que sobrou abre paletes novos
    while (rest.length) {
      const b: Built = { type: ti, items: [], top: 0, kg: 0 }
      const before = rest.length
      rest = stackOnFaces(ctx, b, topRegions(ctx, b, null), rest)
      if (rest.length === before) {
        unplaced.push(...rest)
        break
      }
      mine.push({ b, lastCls: null, layered: 0 })
    }
    // acompanhantes (ex.: 1 kit por Hydroforce) SÓ no palete do produto principal, por cima;
    // o que não couber fica como não colocado (aviso) — nunca vai para outro palete. Se faltar lugar para
    // os kits, as caixas SOLTAS por cima das camadas saem para um palete novo e os kits ocupam o lugar
    // delas: primeiro as que não pedem kit (ex.: 1 HS sobre 18 camadas de HF 5K), depois as que pedem
    // (ex.: 2 HF 2K soltos sobre 12 camadas — vão com os seus kits para o palete novo)
    const moved: string[] = []
    for (const m of mine) {
      const b = m.b
      const snap = () => ({ items: [...b.items], kg: b.kg, top: b.top, left: new Map(kitLeft) })
      const restore = (x: ReturnType<typeof snap>) => {
        b.items = [...x.items]
        b.kg = x.kg
        b.top = x.top
        kitLeft.clear()
        for (const [k, v] of x.left) kitLeft.set(k, v)
      }
      const before = snap()
      const miss: Solution['unplacedKits'] = []
      placeKits(ctx, b, kitLeft, miss)
      const short = miss.reduce((t, k) => t + k.n, 0)
      let done = !short
      for (const withKits of [false, true]) {
        const out = done ? [] : looseRemovable(ctx, before.items, m.layered, withKits)
        if (!out.length) continue
        const first = snap()
        restore(before)
        const gone = new Set(out)
        b.items = b.items.filter((_, i) => !gone.has(i))
        b.kg = b.items.reduce((t, it) => t + ctx.packs.get(it.packId)!.grossKg, 0)
        b.top = b.items.reduce((t, it) => Math.max(t, it.z + orientDims(ctx.packs.get(it.packId)!.dims, it.o).z), 0)
        const miss2: Solution['unplacedKits'] = []
        placeKits(ctx, b, kitLeft, miss2)
        if (miss2.reduce((t, k) => t + k.n, 0) < short) {
          moved.push(...out.map((i) => before.items[i].packId))
          unplacedKits.push(...miss2)
          done = true
          break
        }
        restore(first)
      }
      if (!done || !short) unplacedKits.push(...miss)
    }
    // as caixas que saíram abrem paletes novos (com os kits delas, se pedem)
    let again = moved
    while (again.length) {
      const b: Built = { type: ti, items: [], top: 0, kg: 0 }
      const before = again.length
      again = stackOnFaces(ctx, b, topRegions(ctx, b, null), again)
      if (again.length === before) {
        unplaced.push(...again)
        break
      }
      placeKits(ctx, b, kitLeft, unplacedKits)
      mine.push({ b, lastCls: null, layered: 0 })
    }
    built.push(...mine.map((m) => m.b))
  }
  for (const [sku, n] of kitLeft) if (n > 0) unplacedKits.push({ sku, n, reason: 'sem palete com o produto principal' })
  return { built, unplaced, unplacedKits, name: heuristic }
}

// ---------------------------------------------------------------------------
// Função principal
// ---------------------------------------------------------------------------

/** Máximo de caixas por palete do catálogo (null = sem limite cadastrado). */
const catalogMax = (p: PackSnapshot) => (p.boxesPerPallet != null && p.boxesPerPallet > 0 ? p.boxesPerPallet : null)

/** SKUs acompanhantes presentes no pedido (ex.: KIT-HF): não contam no máximo do produto. */
const companionSkusOf = (order: OrderLine[]) =>
  new Set(order.flatMap((o) => (o.pack.companions ?? []).map((c) => c.sku)).filter((sku) => order.some((o) => o.pack.sku === sku)))

/**
 * Ocupação de um palete em "paletes do catálogo": Σ caixas do produto ÷ máximo por palete do produto.
 * > 1 = passou do máximo (num palete misto, 3 de um produto de máx. 6 + 3 de outro de máx. 6 = 1).
 */
export function catalogFill(p: PalletDoc): number {
  const kits = new Set(Object.values(p.packs).flatMap((k) => (k.companions ?? []).map((c) => c.sku)))
  const n = new Map<string, number>()
  for (const it of p.items) n.set(it.packId, (n.get(it.packId) ?? 0) + 1)
  let f = 0
  for (const [id, c] of n) {
    const k = p.packs[id]
    const m = k && !kits.has(k.sku) ? catalogMax(k) : null
    if (m) f += c / m
  }
  return f
}

/**
 * Altura máxima de montagem pelo PALETE PADRÃO do catálogo: camadas do padrão (máximo de caixas ÷
 * caixas por camada) × altura da camada, mais os acompanhantes. Só reduz a altura do transporte, nunca
 * aumenta; sem máximo cadastrado em algum produto, fica a do transporte.
 * Pedido que cabe inteiro em UM palete do catálogo (Σ caixas ÷ máximo ≤ 1): nenhum palete passa do
 * máximo, então fica a altura do transporte — ex.: 47 HF 2K, cuja camada de cima incompleta deixa os
 * kits mais acima que no padrão de 52 (2.220 × 2.100 mm).
 */
function catalogHeightCap(order: OrderLine[], opts: MixedOptions): number {
  const kits = companionSkusOf(order)
  const types = [...opts.palletTypes, ...(opts.fallbackPalletTypes ?? [])]
  let fill = 0
  for (const o of order) {
    if (kits.has(o.pack.sku) || o.boxes <= 0) continue
    const m = catalogMax(o.pack)
    if (!m) return opts.maxHeightMm
    fill += o.boxes / m
  }
  if (fill <= 1 + 1e-9) return opts.maxHeightMm
  let usable = 0
  for (const o of order) {
    if (kits.has(o.pack.sku) || o.boxes <= 0) continue
    const m = catalogMax(o.pack)
    if (!m) return opts.maxHeightMm
    let best: { per: number; h: number; t: PalletTypeSnapshot } | null = null
    for (const t of types) {
      const pl = layerPlan(t, o.pack, opts)
      if (pl && (!best || pl.pat.slots.length / pl.h > best.per / best.h)) best = { per: pl.pat.slots.length, h: pl.h, t }
    }
    if (!best) continue
    let h = Math.ceil(m / Math.max(1, best.per)) * best.h
    // acompanhantes do produto por cima (ex.: 1 KIT-HF por Hydroforce)
    for (const c of o.pack.companions ?? []) {
      const line = order.find((x) => x.pack.sku === c.sku)
      if (!line) continue
      const k = kitBaseOf(line.pack)
      // kits em caixas coletivas: camada estimada pela regra (26 / meia caixa / individuais)
      if (kitFamilyOf(c.sku)) {
        h += kitLayerEstimate(m * c.qty, k, best.t.dims).h
        continue
      }
      const kz = Math.min(...autoOf(k).map((x) => orientDims(k.dims, x).z))
      const kPer = Math.max(1, ...types.map((t) => layerPlan(t, k, opts)?.pat.slots.length ?? 1))
      h += Math.ceil((m * c.qty) / kPer) * kz
    }
    usable = Math.max(usable, h)
  }
  if (!usable) return opts.maxHeightMm
  const deck = Math.max(...types.map((t) => t.dims.h))
  return Math.min(opts.maxHeightMm, usable + deck)
}

/**
 * Tira de cada palete as caixas acima do máximo do catálogo (as de cima primeiro) e os acompanhantes
 * que ficaram sobrando; devolve os paletes ajustados e o que saiu (para montar paletes novos).
 * Kits: o palete fica com 1 kit por caixa que ficou (caixas de kits refeitas pela regra); os kits que
 * sobram saem como caixas individuais (o motor os reembala no palete novo).
 */
function trimToCatalog(docs: PalletDoc[], maxHeightMm: number): { docs: PalletDoc[]; out: Map<string, { pack: PackSnapshot; boxes: number }> } {
  const out = new Map<string, { pack: PackSnapshot; boxes: number }>()
  const take = (id: string, pack: PackSnapshot, n = 1) => {
    const cur = out.get(id) ?? { pack, boxes: 0 }
    cur.boxes += n
    out.set(id, cur)
  }
  const res = docs.map((p) => {
    if (catalogFill(p) <= 1 + 1e-9) return p
    const kits = new Set(Object.values(p.packs).flatMap((k) => (k.companions ?? []).map((c) => c.sku)))
    let items = [...p.items]
    // caixas do produto de cima para baixo; primeiro as que não têm nada por cima (tirar uma caixa que
    // apoia outras — ex.: caixas de kits por cima — deixaria essas flutuando)
    const isMain = (it: PalletItem) => !kits.has(p.packs[it.packId].sku) && catalogMax(p.packs[it.packId]) != null
    let disturbed = false
    while (catalogFill({ ...p, items }) > 1 + 1e-9) {
      const free = new Set(freeOnTop({ ...p, items }))
      const cands = items.filter(isMain).sort((a, b) => Number(free.has(b)) - Number(free.has(a)) || b.pos.z - a.pos.z || b.pos.x - a.pos.x || b.pos.y - a.pos.y)
      const it = cands[0]
      if (!it) break
      if (!free.has(it)) disturbed = true
      items = items.filter((x) => x !== it)
      take(it.packId, p.packs[it.packId])
    }
    // acompanhantes: só os exigidos pelas caixas que ficaram (contados em kits, não em caixas); se saiu
    // uma caixa que apoiava algo, as caixas de kits são refeitas sobre o que ficou (nunca flutuando)
    let packs = p.packs
    for (const sku of kits) {
      const need = Math.ceil(items.reduce((s, it) => s + ((packs[it.packId].companions ?? []).find((c) => c.sku === sku)?.qty ?? 0), 0) - 1e-9)
      const kitItems = items.filter((it) => packs[it.packId].sku === sku)
      const present = kitItems.reduce((s, it) => s + packs[it.packId].unitsPerPackage, 0)
      if (!kitItems.length || (present <= need && !(disturbed && kitFamilyOf(sku)))) continue
      const base = kitBaseOf(packs[kitItems[0].packId])
      const baseId = packKeyOf(base)
      if (kitFamilyOf(sku)) {
        const r = repackKitsOnPallet({ ...p, packs, items }, base, baseId, Math.min(need, present), maxHeightMm, `tk-${sku}`)
        items = r.doc.items
        packs = r.doc.packs
        take(baseId, base, present - r.placed)
        continue
      }
      for (const it of [...kitItems].sort((a, b) => b.pos.z - a.pos.z).slice(0, Math.max(0, kitItems.length - need))) {
        items = items.filter((x) => x !== it)
        take(it.packId, packs[it.packId])
      }
    }
    return { ...p, packs, items }
  })
  return { docs: res.filter((d) => d.items.length), out }
}

/**
 * Paletes PADRÃO completos: para cada produto com máximo no catálogo, ⌊caixas ÷ máximo⌋ paletes iguais
 * ao palete padrão (só esse produto, exatamente o máximo). Assim um pedido de 104 caixas de máx. 8
 * vira 13 paletes de 8 — nunca 12 de 8 + 2 de 4. Devolve os paletes prontos e o que sobra para o motor misto.
 *
 * Produto com acompanhante em caixas coletivas (ex.: Hydroforce + KIT-HF): o palete padrão leva
 * exatamente o máximo do catálogo e 1 kit por caixa (por cima). Se a altura/peso da modalidade não
 * permitir (ex.: porta de 2.292 mm do 20'/40' Dry), usa o MAIOR número de caixas que cabe com os kits
 * (nunca acima do catálogo) e avisa nas notas.
 */
function fullCatalogPallets(order: OrderLine[], opts: MixedOptions): { docs: PalletDoc[]; rest: OrderLine[]; notes: string[] } {
  const kits = companionSkusOf(order)
  const docs: PalletDoc[] = []
  const main = new Map<OrderLine, OrderLine | null>()
  const notes: string[] = []
  // kits (unidades) que foram nos paletes padrão, por SKU do kit
  const kitUsed = new Map<string, number>()
  const unitsOf = (doc: PalletDoc, sku: string) => doc.items.reduce((s, it) => s + (doc.packs[it.packId]?.sku === sku ? doc.packs[it.packId].unitsPerPackage : 0), 0)
  for (const o of order) {
    if (kits.has(o.pack.sku)) continue
    const m = catalogMax(o.pack)
    const comps = (o.pack.companions ?? []).filter((c) => kits.has(c.sku))
    // acompanhante sem caixas coletivas: fica com o motor completo (como antes)
    if (!m || o.boxes < 1 || comps.some((c) => !kitFamilyOf(c.sku)) || (!comps.length && o.boxes < m)) {
      main.set(o, o)
      continue
    }
    // palete de UM produto com n caixas (e 1 kit por caixa, por cima): só vale se sair exatamente assim
    const build = (n: number): PalletDoc | null => {
      const one: OrderLine[] = [
        { ...o, boxes: n },
        ...comps.map((c) => {
          const kl = order.find((x) => x.pack.sku === c.sku)!
          const base = kitBaseOf(kl.pack)
          return { packId: kl.pack.kitBox ? packKeyOf(base) : kl.packId, pack: base, boxes: Math.ceil((n * c.qty) / Math.max(1, base.unitsPerPackage) - 1e-9) }
        }),
      ]
      const r = optimizeCore(one, { ...opts, maxHeightMm: catalogHeightCap(one, opts) })
      const doc = r.pallets.length === 1 && !r.unplaced.length ? r.pallets[0].doc : null
      if (!doc || doc.items.some((it) => doc.packs[it.packId].sku !== o.pack.sku && !comps.some((c) => c.sku === doc.packs[it.packId].sku))) return null
      if (doc.items.filter((it) => doc.packs[it.packId].sku === o.pack.sku).length !== n) return null
      return comps.every((c) => unitsOf(doc, c.sku) === Math.ceil(n * c.qty - 1e-9)) ? doc : null
    }
    let size = m
    let doc: PalletDoc | null = null
    if (o.boxes >= m) doc = build(m)
    else if (build(o.boxes)) {
      // menos que um palete padrão e cabe inteiro num palete (com os kits): fica com o motor misto
      main.set(o, o)
      continue
    }
    if (!doc) {
      // o pedido não cabe num palete: o palete MENOR que o padrão (e a nota) só se o próprio padrão não se
      // monta nesta modalidade (altura/peso); se o padrão cabe, o motor misto divide o pedido
      if (!comps.length || (o.boxes < m && build(m))) {
        main.set(o, o)
        continue
      }
      for (let k = Math.min(m, o.boxes) - 1; k >= 1 && !doc; k--) {
        doc = build(k)
        if (doc) size = k
      }
      if (doc) notes.push(`${o.pack.sku}: o palete padrão do catálogo (${m} un. + ${m} kits por cima) não cabe na altura/peso desta modalidade (máx. ${fmt.mm(opts.maxHeightMm)}); paletes completos com ${size} un. + ${size} kits, o máximo que cabe.`)
    }
    const n = doc ? Math.floor(o.boxes / size) : 0
    if (!doc || n < 1) {
      // o padrão não se monta nestas condições (altura/peso da modalidade): fica com o motor misto
      main.set(o, o)
      continue
    }
    for (let k = 0; k < n; k++) docs.push({ ...doc, items: doc.items.map((it) => ({ ...it, pos: { ...it.pos } })) })
    for (const c of comps) kitUsed.set(c.sku, (kitUsed.get(c.sku) ?? 0) + n * Math.ceil(size * c.qty - 1e-9))
    main.set(o, o.boxes - n * size > 0 ? { ...o, boxes: o.boxes - n * size } : null)
  }
  // remanente na ordem do pedido; linhas de kits sem os que já foram nos paletes padrão
  const rest: OrderLine[] = []
  for (const o of order) {
    if (!kits.has(o.pack.sku)) {
      const r = main.get(o)
      if (r) rest.push(r)
      continue
    }
    const upp = Math.max(1, o.pack.unitsPerPackage)
    const used = Math.min(kitUsed.get(o.pack.sku) ?? 0, o.boxes * upp)
    kitUsed.set(o.pack.sku, (kitUsed.get(o.pack.sku) ?? 0) - used)
    const left = o.boxes - Math.floor(used / upp)
    if (left > 0) rest.push({ ...o, boxes: left })
  }
  return { docs, rest, notes }
}

/**
 * PALETES MISTOS respeitando o catálogo logístico: o máximo de caixas por palete de cada produto é
 * estrito (pode ficar menos, nunca mais). Prioridade: NÃO dividir paletes — primeiro saem os paletes
 * padrão completos de cada produto; só o remanente (menos que um palete) vai para o motor misto.
 * A montagem usa a altura do palete padrão e, por segurança, qualquer palete acima do máximo é aparado
 * e as caixas que saírem viram paletes novos.
 */
export function optimizeMixedPallets(order: OrderLine[], opts: MixedOptions): MixedResult {
  const full = fullCatalogPallets(order, opts)
  const restOrder = full.rest
  const capped: MixedOptions = { ...opts, maxHeightMm: catalogHeightCap(restOrder, opts) }
  const first: MixedResult = restOrder.length ? optimizeCore(restOrder, capped) : evaluateMixedPlan([], [], { maxHeightMm: opts.maxHeightMm, palletTypes: opts.palletTypes }, { strategy: 'paletes padrão completos' })
  let docs = [...full.docs, ...first.pallets.map((p) => p.doc)]
  let unplaced = [...first.unplaced]
  let trimmed = 0
  for (let pass = 0; pass < 5; pass++) {
    const t = trimToCatalog(docs, opts.maxHeightMm)
    if (!t.out.size) break
    const extra: OrderLine[] = [...t.out].map(([packId, v]) => ({ packId, pack: v.pack, boxes: v.boxes }))
    const kitSkus = companionSkusOf(extra)
    trimmed += extra.reduce((s, x) => s + (kitSkus.has(x.pack.sku) ? 0 : x.boxes), 0)
    const r = optimizeCore(extra, { ...capped, maxHeightMm: catalogHeightCap(extra, opts) })
    docs = [...t.docs, ...r.pallets.map((p) => p.doc)]
    unplaced = [...unplaced, ...r.unplaced]
  }
  const types = [...opts.palletTypes, ...(opts.fallbackPalletTypes ?? []).filter((f) => !opts.palletTypes.some((t) => t.palletTypeId === f.palletTypeId))]
  const notes = [...full.notes, ...first.notes]
  if (full.docs.length) notes.push(`${full.docs.length} palete(s) padrão completo(s) do catálogo (sem dividir); ${restOrder.length ? 'o remanente foi montado à parte.' : 'sem remanente.'}`)
  if (restOrder.length && capped.maxHeightMm < opts.maxHeightMm) notes.push(`Máximo de caixas por palete do catálogo respeitado (montagem até ${Math.round(capped.maxHeightMm)} mm, a altura do palete padrão).`)
  if (trimmed) notes.push(`${trimmed} caixa(s) passariam do máximo por palete do catálogo e foram para outros paletes.`)
  const named = docs.map((d, i) => ({ ...d, name: palletName(i, d.packs) }))
  return evaluateMixedPlan(named, order, { maxHeightMm: opts.maxHeightMm, palletTypes: types }, { unplaced, strategy: first.strategy, evaluated: first.evaluated, notes })
}

function optimizeCore(order: OrderLine[], opts: MixedOptions): MixedResult {
  const packs = new Map(order.map((o) => [o.packId, o.pack]))
  // acompanhantes presentes no pedido (ex.: KIT-HF de cada Hydroforce)
  const companionSkus = new Set(order.flatMap((o) => (o.pack.companions ?? []).map((c) => c.sku)).filter((sku) => order.some((o) => o.pack.sku === sku)))
  const classes = classesOf(order, companionSkus)
  const primary = opts.palletTypes.length
  const types = [...opts.palletTypes, ...(opts.fallbackPalletTypes ?? []).filter((f) => !opts.palletTypes.some((t) => t.palletTypeId === f.palletTypeId))]
  const ctx: Ctx = {
    order,
    packs,
    classes,
    types,
    opts,
    // só padrões que cabem dentro do palete (sem excesso), na melhor face apoiada permitida
    patterns: classes.map((c) => types.map((t) => layerPlan(t, c.rep, opts))),
    kits: new Map(
      [...companionSkus].map((sku) => {
        const o = order.find((x) => x.pack.sku === sku)!
        // base = caixa individual do catálogo (a linha do pedido pode vir numa caixa coletiva)
        const pack = kitBaseOf(o.pack)
        const packId = o.pack.kitBox ? packKeyOf(pack) : o.packId
        packs.set(packId, pack)
        const fam = kitFamilyOf(sku)
        const nat = autoOf(pack)[0]
        // reserva por cima: a caixa coletiva de kits (250 mm) quando o kit tem família de caixas
        return [sku, { packId, pack, z: Math.max(fam ? fam.big.dims.h : 0, orientDims(pack.dims, nat).z), perLayer: types.map((t) => layerPlan(t, pack, opts)?.pat.slots.length ?? 1) }]
      }),
    ),
  }
  const minArea = Math.min(...types.map((t) => t.dims.l * t.dims.w))
  const positionsOf = (ti: number) => Math.max(1, Math.round((types[ti].dims.l * types[ti].dims.w) / minArea))

  // classes sem nenhum tipo possível
  const unfit: MixedResult['unplaced'] = []
  // cada classe usa os paletes principais; os de reserva só quando nenhum principal serve
  const notes: string[] = []
  const options = classes.map((c, ci) => {
    const main = types.map((_, ti) => ti).filter((ti) => ti < primary && ctx.patterns[ci][ti])
    if (main.length) {
      // o palete padrão do produto (reserva) também concorre quando leva MAIS caixas por camada que os da regra
      // (ex.: SB 9×60 1000×600: 2 por camada no PBR-1, 1 no PCF-1150) — a configuração do catálogo não se perde
      const perLayer = (ti: number) => ctx.patterns[ci][ti]?.pat.slots.length ?? 0
      const bestMain = Math.max(...main.map(perLayer))
      const better = types.map((_, ti) => ti).filter((ti) => ti >= primary && perLayer(ti) > bestMain)
      return [...main, ...better]
    }
    const fb = types.map((_, ti) => ti).filter((ti) => ti >= primary && ctx.patterns[ci][ti])
    if (fb.length) {
      const skus = [...new Set(c.queue.map((id) => packs.get(id)!.sku))].join(', ')
      notes.push(`${skus}: caixa ${c.rep.dims.l}×${c.rep.dims.w}×${c.rep.dims.h} mm não cabe em ${opts.palletTypes.map((t) => t.code).join('/')}; usado ${fb.map((ti) => types[ti].code).join('/')} (palete padrão do produto).`)
    }
    return fb
  })
  classes.forEach((c, ci) => {
    if (!options[ci].length) {
      const bySku = new Map<string, number>()
      for (const id of c.queue) bySku.set(packs.get(id)!.sku, (bySku.get(packs.get(id)!.sku) ?? 0) + 1)
      for (const [sku, n] of bySku)
        unfit.push({ sku, boxes: n, reason: Math.min(...autoOf(c.rep).map((o) => orientDims(c.rep.dims, o).z)) > Math.max(...types.map((t) => usableH(t, opts))) ? `caixa (${c.rep.dims.l}×${c.rep.dims.w}×${c.rep.dims.h} mm) mais alta que a altura útil em qualquer face permitida` : 'caixa maior que os paletes disponíveis' })
    }
  })
  const fitIdx = classes.map((_, ci) => ci).filter((ci) => options[ci].length)

  // enumeração das atribuições classe → tipo (produto cartesiano, limitado)
  const maxCombos = opts.maxCombos ?? 4096
  let combos: number[][] = [[]]
  for (const ci of fitIdx) {
    const next: number[][] = []
    for (const c of combos) for (const ti of options[ci]) next.push([...c, ti])
    combos = next
    if (combos.length > maxCombos) {
      // muitas combinações: mantém as que usam o menor número de tipos (mais simples)
      combos = combos.sort((a, b) => new Set(a).size - new Set(b).size).slice(0, maxCombos)
    }
  }

  let best: { sol: Solution; score: number[]; assign: number[] } | null = null
  let evaluated = 0
  for (const combo of combos) {
    const assign = classes.map(() => -1)
    fitIdx.forEach((ci, k) => (assign[ci] = combo[k]))
    // mochila com kits amortizados só faz diferença com acompanhantes no pedido
    const heuristics: Heuristic[] = ctx.kits.size ? ['knap', 'knap-kit', 'ffd-h', 'ffd-kg', 'bfd'] : ['knap', 'ffd-h', 'ffd-kg', 'bfd']
    for (const h of heuristics) {
      const sol = solve(ctx, assign, h)
      evaluated++
      const heights = sol.built.map((b) => b.top + types[b.type].dims.h)
      const mean = heights.reduce((s, x) => s + x, 0) / Math.max(1, heights.length)
      const empty = sol.built.reduce((s, b) => {
        const t = types[b.type]
        const vol = b.items.reduce((v, it) => {
          const d = packs.get(it.packId)!.dims
          return v + d.l * d.w * d.h
        }, 0)
        return s + t.dims.l * t.dims.w * usableH(t, opts) - vol
      }, 0)
      const score = [sol.unplaced.length + sol.unplacedKits.reduce((s, k) => s + k.n, 0), sol.built.reduce((s, b) => s + positionsOf(b.type), 0), sol.built.length, Math.round(empty / 1e6), Math.round(Math.sqrt(heights.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, heights.length)))]
      if (!best || lexLess(score, best.score)) best = { sol, score, assign }
    }
  }

  const sol: Solution = best?.sol ?? { built: [], unplaced: [], unplacedKits: [], name: '—' }
  const docs = sol.built.sort((a, b) => b.kg - a.kg).map((b, i) => builtToDoc(ctx, b, i))
  const unplacedMap = new Map<string, number>()
  for (const id of sol.unplaced) unplacedMap.set(packs.get(id)!.sku, (unplacedMap.get(packs.get(id)!.sku) ?? 0) + 1)
  const kitMap = new Map<string, { sku: string; boxes: number; reason: string }>()
  for (const k of sol.unplacedKits) {
    const key = `${k.sku}|${k.reason}`
    const cur = kitMap.get(key) ?? { sku: k.sku, boxes: 0, reason: `acompanhante: ${k.reason} (não é colocado em outro lugar)` }
    cur.boxes += k.n
    kitMap.set(key, cur)
  }
  const notPlaced = [...unfit, ...[...unplacedMap.entries()].map(([sku, boxes]) => ({ sku, boxes, reason: 'não coube em nenhum palete (altura/peso)' })), ...kitMap.values()]
  const strategy = best ? `${best.sol.name}; ${best.assign.map((ti, ci) => `${classes[ci].rep.sku.replace(/-.*$/, '')} ${classes[ci].rep.dims.l}×${classes[ci].rep.dims.w}×${classes[ci].rep.dims.h}→${ti >= 0 ? types[ti].code : '—'}`).join(', ')}` : '—'
  return evaluateMixedPlan(docs, order, { maxHeightMm: opts.maxHeightMm, palletTypes: types }, { unplaced: notPlaced, strategy, evaluated, notes })
}

function lexLess(a: number[], b: number[]) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i]
  return false
}

function builtToDoc(ctx: Ctx, b: Built, index: number): PalletDoc {
  const usedPacks: PalletDoc['packs'] = {}
  const items: PalletItem[] = b.items.map((it, k) => {
    usedPacks[it.packId] = ctx.packs.get(it.packId)!
    return { id: `m${index + 1}_${k + 1}`, packId: it.packId, pos: { x: it.x, y: it.y, z: it.z }, orientation: it.o, locked: false }
  })
  return { name: palletName(index, usedPacks), palletType: ctx.types[b.type], packs: usedPacks, items, stackable: true, maxTopKg: null, accessoriesKg: 0 }
}

const palletName = (index: number, packs: PalletDoc['packs']) => {
  const skus = [...new Set(Object.values(packs).map((p) => p.sku))]
  return `Palete ${index + 1}${skus.length > 1 ? ' (misto)' : ''} · ${skus.join(' + ')}`
}

/** Resumo de um palete do plano (recalculado a cada edição). */
export function describeMixedPallet(doc: PalletDoc, maxHeightMm: number, index: number, companionSkus: Set<string> = new Set()): MixedPallet {
  const t = doc.palletType
  const s = palletSummary(doc)
  const issues = validatePallet(doc)
  // acompanhantes: só no palete do produto principal, na quantidade exigida
  const needs = palletCompanionNeeds(doc)
  for (const n of needs)
    if (n.present < n.required)
      issues.push({ code: 'COMPANION_MISSING', severity: 'WARNING', message: `Palete ${index + 1}: faltam ${n.required - n.present} ${n.sku} por cima de ${n.for.join(', ')}.`, refs: [], value: n.present, limit: n.required })
  // em kits (uma caixa coletiva leva até 26)
  const strays = doc.items.filter((it) => companionSkus.has(doc.packs[it.packId]?.sku ?? '') && !needs.some((n) => n.sku === doc.packs[it.packId].sku)).reduce((s, it) => s + doc.packs[it.packId].unitsPerPackage, 0)
  if (strays) issues.push({ code: 'COMPANION_MISPLACED', severity: 'WARNING', message: `Palete ${index + 1}: ${strays} acompanhante(s) num palete sem o produto principal.`, refs: [], value: strays })
  if (s.totalHeightMm > maxHeightMm) {
    issues.push({ code: 'HEIGHT_LIMIT', severity: 'CRITICAL', message: `Palete ${index + 1} com ${fmt.mm(s.totalHeightMm)} de altura (máx. ${fmt.mm(maxHeightMm)}).`, refs: [], value: s.totalHeightMm, limit: maxHeightMm })
  }
  const vol = doc.items.reduce((v, it) => {
    const d = doc.packs[it.packId]?.dims
    return d ? v + d.l * d.w * d.h : v
  }, 0)
  return {
    doc,
    heightMm: s.totalHeightMm,
    outerMm: { l: Math.round(Math.max(t.dims.l, s.envelope.size.x)), w: Math.round(Math.max(t.dims.w, s.envelope.size.y)), h: Math.round(s.totalHeightMm) },
    cbm: (Math.max(t.dims.l, s.envelope.size.x) * Math.max(t.dims.w, s.envelope.size.y) * s.totalHeightMm) / 1e9,
    grossKg: s.grossKg,
    netKg: s.netKg,
    volumeUtilPct: (vol / (t.dims.l * t.dims.w * Math.max(1, maxHeightMm - t.dims.h))) * 100,
    lines: s.bySku.map((l) => ({ sku: l.sku, name: l.name, boxes: l.packages, units: l.units, grossKg: l.grossKg })).sort((a, c) => c.grossKg - a.grossKg),
    issues,
  }
}

/**
 * "Palete completo" de um produto com as condições REAIS (altura máxima, tipos de palete, peso):
 * o maior nº de caixas que o motor acomoda em UM palete, já contando os acompanhantes obrigatórios
 * (ex.: 1 KIT-HF por Hydroforce, por cima). `withCompanions(boxes)` devolve o pedido completo
 * (produto + acompanhantes) para essa quantidade de caixas. 0 = não cabe nem uma.
 */
export function maxBoxesPerPallet(pack: PackSnapshot, withCompanions: (boxes: number) => OrderLine[], opts: MixedOptions): number {
  // "palete completo" = no máximo o palete padrão do catálogo
  const m = catalogMax(pack)
  if (m) {
    const r = optimizeMixedPallets(withCompanions(m), opts)
    if (r.pallets.length === 1 && r.unplaced.length === 0) return m
  }
  const fits = (b: number) => {
    const r = optimizeMixedPallets(withCompanions(b), opts)
    return r.pallets.length === 1 && r.unplaced.length === 0
  }
  if (!fits(1)) return 0
  // limite superior: volume útil do maior palete ÷ volume da caixa
  const vol = pack.dims.l * pack.dims.w * pack.dims.h
  const ub = Math.min(2000, Math.max(1, ...opts.palletTypes.concat(opts.fallbackPalletTypes ?? []).map((t) => Math.floor((t.dims.l * t.dims.w * Math.max(0, opts.maxHeightMm - t.dims.h)) / Math.max(1, vol)))))
  let lo = 1, hi = ub
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(mid)) lo = mid
    else hi = mid - 1
  }
  // não é monotônico perto do máximo: com a camada de cima incompleta os kits sobem (ex.: HF 2K a 2.000 mm
  // cabem 48, mas não 47) — confere uma camada acima do resultado
  const types = [...opts.palletTypes, ...(opts.fallbackPalletTypes ?? [])]
  const per = Math.max(1, ...types.map((t) => layerPlan(t, pack, opts)?.pat.slots.length ?? 1))
  const top = Math.min(ub, m ? m - 1 : Infinity)
  for (let b = lo + 1, end = lo + per; b <= Math.min(end, top); b++)
    if (fits(b)) {
      lo = b
      end = b + per
    }
  return m ? Math.min(lo, m) : lo
}

/**
 * Avalia um plano de paletes (otimizado ou editado à mão): totais, posições, alertas por palete e a
 * conferência pedido × colocado (pendentes e excedentes).
 */
export function evaluateMixedPlan(
  docs: PalletDoc[],
  order: OrderLine[],
  opts: { maxHeightMm: number; palletTypes?: PalletTypeSnapshot[] },
  extra: { unplaced?: MixedResult['unplaced']; strategy?: string; evaluated?: number; notes?: string[] } = {},
): MixedResult {
  const companionSkus = new Set([...order.map((o) => o.pack), ...docs.flatMap((d) => Object.values(d.packs))].flatMap((k) => (k.companions ?? []).map((c) => c.sku)))
  const pallets = docs.filter((d) => d.items.length).map((d, i) => describeMixedPallet({ ...d, name: palletName(i, d.packs) }, opts.maxHeightMm, i, companionSkus))
  const areas = [...(opts.palletTypes ?? []), ...pallets.map((p) => p.doc.palletType)].map((t) => t.dims.l * t.dims.w)
  const minArea = Math.min(...areas, Infinity)
  // conferência em caixas; acompanhantes (ex.: KIT-HF) em kits — uma caixa coletiva leva vários
  const placedBySku = new Map<string, number>()
  for (const p of pallets) for (const l of p.lines) placedBySku.set(l.sku, (placedBySku.get(l.sku) ?? 0) + (companionSkus.has(l.sku) ? l.units : l.boxes))
  const reqBySku = new Map<string, { name: string; n: number }>()
  for (const o of order) {
    const cur = reqBySku.get(o.pack.sku) ?? { name: o.pack.name, n: 0 }
    cur.n += companionSkus.has(o.pack.sku) ? o.boxes * Math.max(1, o.pack.unitsPerPackage) : o.boxes
    reqBySku.set(o.pack.sku, cur)
  }
  const check = [...reqBySku.entries()].map(([sku, r]) => ({ sku, name: r.name, requested: r.n, placed: placedBySku.get(sku) ?? 0, ok: (placedBySku.get(sku) ?? 0) === r.n }))
  // produtos colocados que não estão no pedido (edição manual)
  for (const [sku, n] of placedBySku) if (!reqBySku.has(sku)) check.push({ sku, name: sku, requested: 0, placed: n, ok: false })
  const totals = pallets.reduce(
    (t, p) => ({
      pallets: t.pallets + 1,
      boxes: t.boxes + p.lines.reduce((s, l) => s + l.boxes, 0),
      units: t.units + p.lines.reduce((s, l) => s + l.units, 0),
      netKg: t.netKg + p.netKg,
      grossKg: t.grossKg + p.grossKg,
      cbm: t.cbm + p.cbm,
    }),
    { pallets: 0, boxes: 0, units: 0, netKg: 0, grossKg: 0, cbm: 0 },
  )
  const critical = pallets.some((p) => p.issues.some((i) => i.severity === 'CRITICAL'))
  const unplaced = extra.unplaced ?? []
  return {
    pallets,
    positions: pallets.reduce((s, p) => s + Math.max(1, Math.round((p.doc.palletType.dims.l * p.doc.palletType.dims.w) / minArea)), 0),
    totals,
    check,
    unplaced,
    ok: !unplaced.length && check.every((c) => c.ok) && !critical,
    strategy: extra.strategy ?? 'edição manual',
    evaluated: extra.evaluated ?? 0,
    maxHeightMm: opts.maxHeightMm,
    notes: extra.notes ?? [],
  }
}

// ---------------------------------------------------------------------------
// Edição manual: tirar / colocar / mover caixas entre paletes (recalculado pelo motor)
// ---------------------------------------------------------------------------

/** Caixas que não têm nada por cima (podem ser retiradas sem tirar o apoio de outras). */
function freeOnTop(doc: PalletDoc): PalletItem[] {
  const box = (it: PalletItem) => {
    const d = orientDims(doc.packs[it.packId].dims, it.orientation)
    return { x0: it.pos.x, y0: it.pos.y, x1: it.pos.x + d.x, y1: it.pos.y + d.y, z1: it.pos.z + d.z, z0: it.pos.z }
  }
  return doc.items.filter((a) => {
    const A = box(a)
    return !doc.items.some((b) => {
      if (b === a) return false
      const B = box(b)
      return Math.abs(B.z0 - A.z1) < 1 && Math.min(A.x1, B.x1) > Math.max(A.x0, B.x0) && Math.min(A.y1, B.y1) > Math.max(A.y0, B.y0)
    })
  })
}

/** Retira até `qty` caixas do SKU, sempre as de cima. */
export function removeBoxesFromMixed(doc: PalletDoc, sku: string, qty: number): { doc: PalletDoc; removed: { packId: string; pack: PackSnapshot }[] } {
  let d = doc
  const removed: { packId: string; pack: PackSnapshot }[] = []
  for (let k = 0; k < qty; k++) {
    const cands = freeOnTop(d).filter((it) => d.packs[it.packId].sku === sku)
    if (!cands.length) break
    const top = cands.sort((a, b) => b.pos.z - a.pos.z || b.pos.x - a.pos.x || b.pos.y - a.pos.y)[0]
    removed.push({ packId: top.packId, pack: d.packs[top.packId] })
    const items = d.items.filter((i) => i !== top)
    const packs = Object.fromEntries(Object.entries(d.packs).filter(([k2]) => items.some((i) => i.packId === k2)))
    d = { ...d, items, packs }
  }
  return { doc: d, removed }
}

/**
 * Coloca até `qty` caixas no palete na melhor posição livre: 100% apoiada, dentro do palete e
 * abaixo da altura máxima (piso primeiro, depois por cima). Devolve quantas couberam.
 */
export function addBoxesToMixed(doc: PalletDoc, packId: string, pack: PackSnapshot, qty: number, maxHeightMm: number): { doc: PalletDoc; added: number } {
  const t = doc.palletType
  const capKg = [t.dynamicMaxKg, t.staticMaxKg, t.maxLoadKg].filter((v): v is number => v != null && v > 0)
  const limitKg = capKg.length ? Math.min(...capKg) : Infinity
  let d: PalletDoc = doc.packs[packId] ? doc : { ...doc, packs: { ...doc.packs, [packId]: pack } }
  let added = 0
  let kgNow = d.items.reduce((s, it) => s + (d.packs[it.packId]?.grossKg ?? 0), 0)
  for (let k = 0; k < qty; k++) {
    if (kgNow + pack.grossKg > limitKg + 1e-6) break
    const obstacles = d.items.map((it) => ({ box: { min: it.pos, size: orientDims(d.packs[it.packId].dims, it.orientation) }, stackable: true }))
    let best: { pos: { x: number; y: number; z: number }; o: Orientation } | null = null
    for (const o of autoOf(pack)) {
      const size = orientDims(pack.dims, o)
      const pos = findFreePosition(obstacles, size, { lo: { x: 0, y: 0, z: 0 }, hi: { x: t.dims.l, y: t.dims.w, z: maxHeightMm - t.dims.h }, allowStacking: true, minSupportPct: 100 })
      if (pos && (!best || pos.z < best.pos.z || (pos.z === best.pos.z && pos.x < best.pos.x))) best = { pos, o }
    }
    if (!best) break
    d = { ...d, items: [...d.items, { id: `e${Date.now().toString(36)}_${k}_${d.items.length}`, packId, pos: best.pos, orientation: best.o, locked: false }] }
    kgNow += pack.grossKg
    added++
  }
  return { doc: added ? d : doc, added }
}

/**
 * REEMBALA os kits de um palete: tira todas as caixas do kit (`base.sku`) e coloca `kits` kits pela
 * regra (caixas de 26 / meia caixa / individuais, maiores primeiro, por cima, até a altura máxima;
 * caixa que não cabe vira caixas menores). Devolve o palete novo e quantos kits couberam.
 */
export function repackKitsOnPallet(doc: PalletDoc, base0: PackSnapshot, baseId: string, kits: number, maxHeightMm: number, idPrefix = `k${Date.now().toString(36)}`): { doc: PalletDoc; placed: number } {
  const base = kitBaseOf(base0)
  const t = doc.palletType
  const capKg = [t.dynamicMaxKg, t.staticMaxKg, t.maxLoadKg].filter((v): v is number => v != null && v > 0)
  const limitKg = capKg.length ? Math.min(...capKg) : Infinity
  const keep = doc.items.filter((it) => doc.packs[it.packId]?.sku !== base.sku)
  const kgNow = keep.reduce((s, it) => s + (doc.packs[it.packId]?.grossKg ?? 0), 0)
  const obstacles: Obstacle[] = keep.map((it) => ({ box: { min: it.pos, size: orientDims(doc.packs[it.packId].dims, it.orientation) }, stackable: true }))
  const r = placeKitBoxes(obstacles, t.dims, maxHeightMm - t.dims.h, limitKg - kgNow, base, baseId, packKits(kits, base.sku))
  const used = new Set(keep.map((it) => it.packId))
  const packs: PalletDoc['packs'] = Object.fromEntries(Object.entries(doc.packs).filter(([k, p]) => p.sku !== base.sku || used.has(k)))
  for (const p of r.placed) packs[p.packId] = p.pack
  const items: PalletItem[] = [...keep, ...r.placed.map((p, k) => ({ id: `${idPrefix}_${k + 1}`, packId: p.packId, pos: p.pos, orientation: p.o, locked: false }))]
  return { doc: { ...doc, packs, items }, placed: r.kits }
}

/** Move caixas de um palete para outro (tira as de cima da origem; coloca onde couber no destino). */
export function moveBoxesBetween(from: PalletDoc, to: PalletDoc, sku: string, qty: number, maxHeightMm: number): { from: PalletDoc; to: PalletDoc; moved: number } {
  const r = removeBoxesFromMixed(from, sku, qty)
  let dest = to
  let moved = 0
  for (const b of r.removed) {
    const a = addBoxesToMixed(dest, b.packId, b.pack, 1, maxHeightMm)
    if (!a.added) break
    dest = a.doc
    moved++
  }
  if (moved < r.removed.length) {
    // devolve o que não coube
    const back = removeBoxesFromMixed(from, sku, moved)
    return { from: back.doc, to: dest, moved }
  }
  return { from: r.doc, to: dest, moved }
}

/** Referência para comparação: cada SKU em paletes próprios (mesma geometria e limites). */
export function singleSkuBaseline(order: OrderLine[], opts: MixedOptions, typeOf: (o: OrderLine) => PalletTypeSnapshot | undefined): { sku: string; perPallet: number; pallets: number; positions: number }[] {
  const minArea = Math.min(...opts.palletTypes.map((t) => t.dims.l * t.dims.w))
  return order.map((o) => {
    const t = typeOf(o) ?? opts.palletTypes[0]
    const pat = bestLayer(t, o.pack)
    const layers = Math.floor(usableH(t, opts) / o.pack.dims.h)
    const byKg = Math.floor(capOf(t, opts) / o.pack.grossKg)
    const perPallet = Math.max(0, Math.min(pat.slots.length * layers, byKg))
    const pallets = perPallet ? Math.ceil(o.boxes / perPallet) : NaN
    return { sku: o.pack.sku, perPallet, pallets, positions: pallets * Math.max(1, Math.round((t.dims.l * t.dims.w) / minArea)) }
  })
}
