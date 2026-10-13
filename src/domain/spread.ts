/**
 * OCUPAR O ESPAÇO DISPONÍVEL: mesma mercadoria em MAIS paletes (menos caixas por palete), quando a
 * carga está limitada por peso e sobra piso. Não muda produtos, quantidades nem o equipamento.
 *
 * Regras:
 *  - só paletes de UM produto (com seus acompanhantes obrigatórios, ex.: KIT-HF); paletes mistos
 *    existentes ficam como estão e nunca são criados paletes mistos aqui;
 *  - cada palete novo é o palete atual com menos camadas (mesma arrumação real das caixas, de baixo
 *    para cima), com ao menos uma camada completa; as caixas de cada produto são repartidas por igual;
 *  - tudo no piso (sem empilhar paletes): é o objetivo de ocupar o espaço;
 *  - payload: cada palete a mais soma a tara do palete — a alternativa só vale se couber no limite;
 *  - depois de montar, a distribuição de peso (balanceWeight) e a validação completa da carga.
 */
import { apportion, placeLooseBoxes, placePalletsGreedy } from './autoload'
import { balanceWeight } from './balance'
import { addMissingCompanions } from './companions'
import { loadGeometries, loadSummary, validateLoad } from './load'
import { palletSummary } from './pallet'
import { evaluateQuadrants, quadrantShares } from './quadrants'
import { stagedIds } from './staging'
import type { LoadDoc, PackSnapshot, PalletDoc } from './types'

interface Group {
  /** embalagem do produto principal */
  packId: string
  sku: string
  /** palete-modelo (o de mais caixas do produto) */
  templateKey: string
  template: PalletDoc
  /** caixas do produto principal no total */
  boxes: number
  /** paletes atuais do produto */
  pallets: number
  /** caixas por camada no palete-modelo */
  perLayer: number
  /** máximo de caixas por palete hoje */
  maxPerPallet: number
}

export interface SpreadOption {
  pallets: number
  doc: LoadDoc
  floorPct: number
  volumePct: number
  maxHeightMm: number
  payloadKg: number
  payloadPct: number | null
  extraTareKg: number
  quadrantsOk: boolean
  /** por produto: paletes e caixas por palete */
  perProduct: { sku: string; pallets: number; boxesPerPallet: string }[]
}

export interface SpreadAnalysis {
  current: { pallets: number; floorPct: number; maxHeightMm: number; payloadPct: number | null }
  options: SpreadOption[]
  /** índice em options da recomendada (mais paletes que cabem no piso, sem alertas críticos) */
  best: number | null
  /** paletes mistos mantidos como estão */
  mixedKept: number
  reason?: string
}

const mainPacks = (p: PalletDoc): string[] => {
  const companionSkus = new Set(Object.values(p.packs).flatMap((k) => (k.companions ?? []).map((c) => c.sku.toUpperCase())))
  return Object.entries(p.packs)
    .filter(([, k]) => !companionSkus.has(k.sku.toUpperCase()))
    .map(([id]) => id)
}

/** Palete-modelo reduzido a `q` caixas do produto principal (de baixo para cima; sem acompanhantes — repostos depois). */
function trimPallet(t: PalletDoc, packId: string, q: number, fullBoxes: number, baseKey: string): PalletDoc {
  const items = t.items
    .filter((i) => i.packId === packId)
    .sort((a, b) => a.pos.z - b.pos.z || a.pos.y - b.pos.y || a.pos.x - b.pos.x)
    .slice(0, q)
  return { ...t, name: `${t.name.replace(/ · \d+ cx$/, '')} · ${q} cx`, packs: { [packId]: t.packs[packId] }, items, baseKey, fullBoxes }
}

const heightOf = (p: PalletDoc) => palletSummary(p).totalHeightMm

/**
 * Caixas de cada um dos n paletes do produto, por CAMADAS INTEIRAS (topo plano): as camadas completas
 * repartidas por igual (diferença máxima de uma camada) e as caixas que não fecham camada num palete só.
 */
export function boxesPerPallet(g: { boxes: number; perLayer: number }, n: number): number[] {
  const pl = Math.max(1, g.perLayer)
  const layers = Math.floor(g.boxes / pl), rem = g.boxes % pl
  const base = Math.floor(layers / n), extra = layers % n
  const out = Array.from({ length: n }, (_, i) => (base + (i < extra ? 1 : 0)) * pl)
  if (rem) out[n - 1] += rem
  return out
}

function metrics(doc: LoadDoc) {
  const s = loadSummary(doc)
  const geoms = loadGeometries(doc)
  const maxH = Math.max(0, ...geoms.filter((g) => g.unit.kind === 'PALLET').map((g) => g.box.min.z + g.box.size.z))
  return { floorPct: s.floorUtilPct, volumePct: s.volumeUtilPct, maxHeightMm: maxH, payloadKg: s.payloadKg, payloadPct: s.payloadPct }
}

/** Monta a carga com n paletes por produto; null se não couber tudo no piso / no payload / com alerta crítico. */
function build(doc: LoadDoc, groups: Group[], counts: number[], fixedPallets: { key: string; pallet: PalletDoc; count: number }[], loose: { packId: string; pack: PackSnapshot; count: number }[]): LoadDoc | null {
  let d: LoadDoc = { ...doc, pallets: {}, packs: {}, units: [] }
  // paletes a colocar: maiores pegadas e mais pesados primeiro (como o "reorganizar")
  const todo: { key: string; pallet: PalletDoc; count: number }[] = [...fixedPallets]
  groups.forEach((g, i) => {
    const sizes = new Map<number, number>()
    for (const q of boxesPerPallet(g, counts[i])) sizes.set(q, (sizes.get(q) ?? 0) + 1)
    for (const [q, c] of sizes) todo.push({ key: `${g.templateKey}|sp${counts[i]}q${q}`, pallet: trimPallet(g.template, g.packId, q, g.maxPerPallet, g.templateKey), count: c })
  })
  // acompanhantes (ex.: KIT-HF) por cima de cada palete do produto, na proporção certa
  const allPacks = Object.assign({}, ...Object.values(doc.pallets).map((p) => p.packs), doc.packs) as Record<string, PackSnapshot>
  const findPack = (sku: string) => {
    const e = Object.entries(allPacks).find(([, k]) => k.sku.toUpperCase() === sku.toUpperCase())
    return e ? { packId: e[0], pack: e[1] } : null
  }
  const area = (p: PalletDoc) => p.palletType.dims.l * p.palletType.dims.w
  todo.sort((a, b) => area(b.pallet) - area(a.pallet) || palletSummary(b.pallet).grossKg - palletSummary(a.pallet).grossKg)
  for (const t of todo) {
    // kits: o palete recebe os acompanhantes antes de ir para a carga (altura/peso reais)
    let pallet = t.pallet
    const probe: LoadDoc = { ...d, pallets: { [t.key]: pallet }, units: [{ id: 'probe', kind: 'PALLET', palletKey: t.key, pos: { x: 0, y: 0, z: 0 }, yaw: false, locked: false }] }
    const withKits = addMissingCompanions(probe, findPack)
    pallet = withKits.doc.pallets[t.key] ?? pallet
    const r = placePalletsGreedy(d, t.key, pallet, t.count, { allowStacking: false, idPrefix: 'sp' })
    if (r.placed < t.count) return null
    d = r.doc
  }
  for (const l of loose) {
    const r = placeLooseBoxes(d, l.packId, l.pack, l.count)
    if (r.placed < l.count) return null
    d = r.doc
  }
  return validateLoad(d).issues.some((i) => i.severity === 'CRITICAL') ? null : d
}

/**
 * Alternativas com mais paletes para a mesma mercadoria. `maxOptions`: quantas mostrar (a recomendada
 * — o máximo que cabe no piso — e alguns passos intermediários).
 */
export function analyzeSpread(doc: LoadDoc, o: { maxOptions?: number } = {}): SpreadAnalysis {
  const before = metrics(doc)
  const pallets = doc.units.filter((u) => u.kind === 'PALLET')
  const current = { pallets: pallets.length, floorPct: before.floorPct, maxHeightMm: before.maxHeightMm, payloadPct: before.payloadPct }
  const none = (reason: string, mixedKept = 0): SpreadAnalysis => ({ current, options: [], best: null, mixedKept, reason })
  if (stagedIds(doc, loadGeometries(doc).map((g) => ({ id: g.unit.id, box: g.box }))).size) return none('Há unidades fora da carga: reposicione ou retire antes de otimizar.')
  if (doc.units.some((u) => u.locked)) return none('Há unidades travadas: destrave para permitir a redistribuição.')

  const groupsBy = new Map<string, Group>()
  const fixed = new Map<string, { key: string; pallet: PalletDoc; count: number }>()
  for (const u of pallets) {
    if (u.kind !== 'PALLET') continue
    const p = doc.pallets[u.palletKey]
    const mains = mainPacks(p)
    if (mains.length !== 1) {
      const f = fixed.get(u.palletKey) ?? { key: u.palletKey, pallet: p, count: 0 }
      f.count++
      fixed.set(u.palletKey, f)
      continue
    }
    const packId = mains[0]
    const n = p.items.filter((i) => i.packId === packId).length
    const k = `${packId}|${p.palletType.code}`
    const g = groupsBy.get(k)
    const minZ = Math.min(...p.items.filter((i) => i.packId === packId).map((i) => i.pos.z))
    const perLayer = p.items.filter((i) => i.packId === packId && i.pos.z === minZ).length
    if (!g) groupsBy.set(k, { packId, sku: p.packs[packId].sku, templateKey: u.palletKey, template: p, boxes: n, pallets: 1, perLayer, maxPerPallet: n })
    else {
      g.boxes += n
      g.pallets++
      if (n > g.maxPerPallet) Object.assign(g, { template: p, templateKey: u.palletKey, maxPerPallet: n, perLayer })
    }
  }
  const groups = [...groupsBy.values()]
  const mixedKept = [...fixed.values()].reduce((t, f) => t + f.count, 0)
  if (!groups.length) return none('Não há paletes de um só produto para redistribuir (paletes mistos ficam como estão).', mixedKept)
  const looseMap = new Map<string, { packId: string; pack: PackSnapshot; count: number }>()
  for (const u of doc.units)
    if (u.kind === 'PACKAGE') {
      const l = looseMap.get(u.packId) ?? { packId: u.packId, pack: doc.packs[u.packId], count: 0 }
      l.count++
      looseMap.set(u.packId, l)
    }
  const loose = [...looseMap.values()]

  // teto por produto: ao menos uma camada completa por palete
  const cap = groups.map((g) => Math.max(g.pallets, Math.floor(g.boxes / Math.max(1, g.perLayer))))
  const n0 = groups.reduce((t, g) => t + g.pallets, 0)
  const nMax = cap.reduce((a, b) => a + b, 0)
  if (nMax <= n0) return none('Os paletes já estão com uma camada só (ou perto disso): não dá para repartir mais sem deixar camadas incompletas.', mixedKept)

  /** n paletes no total → por produto, proporcional às caixas, respeitando o mínimo atual e o teto */
  const allocate = (n: number): number[] => {
    const extra = n - n0
    const counts = groups.map((g) => g.pallets)
    let left = extra
    // reparte o extra pelas caixas de cada produto, re-repartindo o que bater no teto
    for (let guard = 0; left > 0 && guard < 20; guard++) {
      const open = groups.map((g, i) => (counts[i] < cap[i] ? g.boxes : 0))
      if (!open.some((x) => x > 0)) break
      const add = apportion(left, open)
      add.forEach((a, i) => {
        const take = Math.min(a, cap[i] - counts[i])
        counts[i] += take
        left -= take
      })
    }
    return counts
  }

  // procura o maior n que cabe (busca binária: mais paletes nunca cabe se menos não cabe — aproximação),
  // depois alguns passos intermediários para comparação
  const tried = new Map<number, LoadDoc | null>()
  const at = (n: number) => {
    if (!tried.has(n)) tried.set(n, build(doc, groups, allocate(n), [...fixed.values()], loose))
    return tried.get(n)!
  }
  let lo = n0, hi = nMax
  if (!at(n0 + 1)) return none('Nem um palete a mais cabe no piso (ou passaria do payload com a tara do palete).', mixedKept)
  lo = n0 + 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (at(mid)) lo = mid
    else hi = mid - 1
  }
  const bestN = lo
  const want = Math.max(1, o.maxOptions ?? 4)
  const steps = new Set<number>([bestN])
  for (let k = 1; steps.size < want && k < want + 3; k++) {
    const n = Math.round(n0 + ((bestN - n0) * k) / want)
    if (n > n0 && n < bestN && at(n)) steps.add(n)
  }
  const tare = (p: PalletDoc) => p.palletType.tareKg
  const options: SpreadOption[] = [...steps]
    .sort((a, b) => a - b)
    .map((n) => {
      const counts = allocate(n)
      const balanced = balanceWeight(at(n)!).doc
      const m = metrics(balanced)
      return {
        pallets: n + mixedKept,
        doc: balanced,
        ...m,
        extraTareKg: groups.reduce((t, g, i) => t + (counts[i] - g.pallets) * tare(g.template), 0),
        quadrantsOk: evaluateQuadrants(quadrantShares(balanced)).ok,
        perProduct: groups.map((g, i) => {
          const qs = boxesPerPallet(g, counts[i])
          const lo = Math.min(...qs), hi = Math.max(...qs)
          return { sku: g.sku, pallets: counts[i], boxesPerPallet: lo === hi ? String(lo) : `${lo}–${hi}` }
        }),
      }
    })
  return { current: { ...current, maxHeightMm: Math.max(current.maxHeightMm, ...groups.map((g) => heightOf(g.template))) }, options, best: options.findIndex((x) => x.pallets === bestN + mixedKept), mixedKept }
}
