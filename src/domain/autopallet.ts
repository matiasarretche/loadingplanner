/**
 * Paletização de referência por camadas (não é o otimizador 3D):
 * escolhe o padrão de camada com mais volumes e empilha até a quantidade pedida.
 */
import { Orientation, orientDims, Vec3 } from './geometry'
import type { PackSnapshot, PalletDoc, PalletTypeSnapshot } from './types'

export interface LayerSlot {
  x: number
  y: number
  orientation: Orientation
}

export interface LayerPattern {
  name: string
  slots: LayerSlot[]
  /** envelope da camada (para centralizar no palete) */
  sizeX: number
  sizeY: number
}

/** strict: só o que cabe; senão, 1 volume centralizado no eixo onde não cabe (gera alerta de overhang). */
const fit = (avail: number, d: number, strict: boolean) => (d > avail ? (strict ? 0 : 1) : Math.floor(avail / d))

function grid(L: number, W: number, a: number, b: number, o: Orientation, name: string, strict = true): LayerPattern {
  const nx = fit(L, a, strict), ny = fit(W, b, strict)
  const slots: LayerSlot[] = []
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) slots.push({ x: i * a, y: j * b, orientation: o })
  return { name, slots, sizeX: nx * a, sizeY: ny * b }
}

/** Dois blocos: k colunas numa orientação + o resto girado (ao longo de x; e o simétrico em y). */
function splits(L: number, W: number, a: number, b: number, o1: Orientation, o2: Orientation): LayerPattern[] {
  const out: LayerPattern[] = []
  for (let k = 1; k * a < L; k++) {
    const rest = L - k * a
    if (rest < b) break
    const ny1 = Math.floor(W / b), nx2 = Math.floor(rest / b), ny2 = Math.floor(W / a)
    if (!ny1 || !nx2 || !ny2) continue
    const slots: LayerSlot[] = []
    for (let i = 0; i < k; i++) for (let j = 0; j < ny1; j++) slots.push({ x: i * a, y: j * b, orientation: o1 })
    for (let i = 0; i < nx2; i++) for (let j = 0; j < ny2; j++) slots.push({ x: k * a + i * b, y: j * a, orientation: o2 })
    out.push({ name: `blocos ${k}+${nx2} (x)`, slots, sizeX: k * a + nx2 * b, sizeY: Math.max(ny1 * b, ny2 * a) })
  }
  for (let k = 1; k * b < W; k++) {
    const rest = W - k * b
    if (rest < a) break
    const nx1 = Math.floor(L / a), ny2 = Math.floor(rest / a), nx2 = Math.floor(L / b)
    if (!nx1 || !ny2 || !nx2) continue
    const slots: LayerSlot[] = []
    for (let j = 0; j < k; j++) for (let i = 0; i < nx1; i++) slots.push({ x: i * a, y: j * b, orientation: o1 })
    for (let j = 0; j < ny2; j++) for (let i = 0; i < nx2; i++) slots.push({ x: i * b, y: k * b + j * a, orientation: o2 })
    out.push({ name: `blocos ${k}+${ny2} (y)`, slots, sizeX: Math.max(nx1 * a, nx2 * b), sizeY: k * b + ny2 * a })
  }
  return out
}

/** Cata-vento: 4 volumes ao redor de um vão central; cabe em (a+b) × (a+b). */
function pinwheel(L: number, W: number, a: number, b: number, o1: Orientation, o2: Orientation): LayerPattern | null {
  if (a === b || a + b > L || a + b > W) return null
  const s = a + b
  return {
    name: 'cata-vento',
    slots: [
      { x: 0, y: 0, orientation: o1 }, // a × b
      { x: a, y: 0, orientation: o2 }, // b × a
      { x: b, y: a, orientation: o1 },
      { x: 0, y: b, orientation: o2 },
    ],
    sizeX: s,
    sizeY: s,
  }
}

/**
 * toleranceMm: excesso aceito sobre o palete para ganhar volumes por camada (ex.: 3 × 385 = 1155 em 1150).
 * O excesso não é escondido: a validação marca OVERHANG para decisão do usuário.
 */
export function bestLayer(pallet: PalletTypeSnapshot, pack: PackSnapshot, toleranceMm = 0): LayerPattern {
  const L = pallet.dims.l + (pallet.overhangAllowed ? 2 * pallet.overhangMaxMm : 0) + toleranceMm
  const W = pallet.dims.w + (pallet.overhangAllowed ? 2 * pallet.overhangMaxMm : 0) + toleranceMm
  const upright = pack.allowedOrientations.filter((o) => o === 'LWH' || o === 'WLH')
  const o1: Orientation = upright.includes('LWH') ? 'LWH' : upright[0] ?? pack.allowedOrientations[0]
  const d1 = orientDims(pack.dims, o1)
  const cands: LayerPattern[] = [grid(L, W, d1.x, d1.y, o1, 'grade')]
  const o2: Orientation | null = o1 === 'LWH' && upright.includes('WLH') ? 'WLH' : o1 === 'WLH' && upright.includes('LWH') ? 'LWH' : null
  if (o2) {
    const d2 = orientDims(pack.dims, o2)
    cands.push(grid(L, W, d2.x, d2.y, o2, 'grade girada'))
    cands.push(...splits(L, W, d1.x, d1.y, o1, o2))
    const pw = pinwheel(L, W, d1.x, d1.y, o1, o2)
    if (pw) cands.push(pw)
  }
  const ok = cands.filter((c) => c.slots.length > 0)
  // mais volumes; em empate, o padrão mais simples (ordem da lista)
  if (ok.length) return ok.reduce((best, c) => (c.slots.length > best.slots.length ? c : best))
  // nada cabe dentro do palete: orientação com menor excesso, centralizada
  const forced = [grid(L, W, d1.x, d1.y, o1, 'grade (excede o palete)', false)]
  if (o2) {
    const d2 = orientDims(pack.dims, o2)
    forced.push(grid(L, W, d2.x, d2.y, o2, 'grade girada (excede o palete)', false))
  }
  const excess = (c: LayerPattern) => Math.max(c.sizeX - L, 0) + Math.max(c.sizeY - W, 0)
  return forced.reduce((best, c) => (excess(c) < excess(best) || (excess(c) === excess(best) && c.slots.length > best.slots.length) ? c : best))
}

/**
 * Variante "travada" de uma camada com orientações misturadas (espelhada/girada) para alternar
 * entre camadas; null se a camada não muda (orientação única ou simétrica).
 */
export function interlockedSlots(pattern: LayerPattern, dims: PackSnapshot['dims']): LayerSlot[] | null {
  if (new Set(pattern.slots.map((x) => x.orientation)).size <= 1) return null
  const key = (arr: LayerSlot[]) => arr.map((q) => `${q.x},${q.y},${q.orientation}`).sort().join('|')
  for (const t of [
    { mx: true, my: false },
    { mx: false, my: true },
    { mx: true, my: true },
  ]) {
    const alt = pattern.slots.map((q) => {
      const d = orientDims(dims, q.orientation)
      return { x: t.mx ? pattern.sizeX - q.x - d.x : q.x, y: t.my ? pattern.sizeY - q.y - d.y : q.y, orientation: q.orientation }
    })
    if (key(alt) !== key(pattern.slots)) return alt
  }
  return null
}

export interface ReferencePallet {
  doc: PalletDoc
  pattern: LayerPattern
  perLayer: number
  layers: number
  /** camadas alternadas giradas 180° (padrão com orientações misturadas) */
  interlocked: boolean
}

/** Monta `count` volumes em camadas, cada camada centralizada no palete. */
export function buildReferencePallet(pallet: PalletTypeSnapshot, pack: PackSnapshot, packId: string, count: number, name: string, toleranceMm = 0): ReferencePallet {
  const strict = bestLayer(pallet, pack)
  const loose = toleranceMm > 0 ? bestLayer(pallet, pack, toleranceMm) : strict
  const pattern = loose.slots.length > strict.slots.length ? { ...loose, name: `${loose.name} (excede ${Math.max(loose.sizeX - pallet.dims.l, loose.sizeY - pallet.dims.w)} mm)` } : strict
  const perLayer = Math.max(1, pattern.slots.length)
  const layers = Math.ceil(count / perLayer)
  const ox = Math.round((pallet.dims.l - pattern.sizeX) / 2)
  const oy = Math.round((pallet.dims.w - pattern.sizeY) / 2)
  const h = pack.dims.h
  // camada com orientações misturadas: camadas ímpares espelhadas/giradas para travar (blocos cruzados entre camadas).
  // Usa a primeira transformação que realmente muda a camada (o cata-vento girado 180° fica igual; espelhado, não).
  const mixed = new Set(pattern.slots.map((x) => x.orientation)).size > 1
  const key = (arr: { x: number; y: number; orientation: string }[]) => arr.map((q) => `${q.x},${q.y},${q.orientation}`).sort().join('|')
  const transforms = [
    { name: 'espelhadas', mx: true, my: false },
    { name: 'espelhadas', mx: false, my: true },
    { name: 'giradas 180°', mx: true, my: true },
  ]
  const apply = (t: { mx: boolean; my: boolean }) =>
    pattern.slots.map((q) => {
      const d = orientDims(pack.dims, q.orientation)
      return { x: t.mx ? pattern.sizeX - q.x - d.x : q.x, y: t.my ? pattern.sizeY - q.y - d.y : q.y, orientation: q.orientation }
    })
  const tf = mixed ? transforms.find((t) => key(apply(t)) !== key(pattern.slots)) : undefined
  const interlocked = Boolean(tf)
  const alt = tf ? apply(tf) : pattern.slots
  const items: PalletDoc['items'] = []
  let n = 0
  for (let layer = 0; layer < layers; layer++) {
    const slots = interlocked && layer % 2 === 1 ? alt : pattern.slots
    for (const s of slots) {
      if (n >= count) break
      const pos: Vec3 = { x: ox + s.x, y: oy + s.y, z: layer * h }
      items.push({ id: `r${layer}_${n}`, packId, pos, orientation: s.orientation, locked: false })
      n++
    }
  }
  return {
    doc: { name, palletType: pallet, packs: { [packId]: pack }, items, stackable: false, maxTopKg: null, accessoriesKg: 0 },
    pattern: tf ? { ...pattern, name: `${pattern.name}, camadas travadas (${tf.name})` } : pattern,
    perLayer,
    layers,
    interlocked,
  }
}
