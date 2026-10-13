/**
 * EXPEDIÇÃO — instrução de carregamento para quem monta a carga (SEM preços): ordem de carregamento,
 * posição de cada unidade (distância da parede do motorista, lado, altura, giro, sobre qual está),
 * conteúdo (produtos e caixas), peso, vãos a calçar e passos da sequência para as vistas 3D.
 * Convenção: x = 0 na FRENTE (NORTE, cabine) → TRASEIRA (SUL); y = 0 no lado OESTE (lado do motorista),
 * y = W no LESTE (lado do acompanhante); z = altura.
 */
import { footprintOverlap, orientDims } from './geometry'
import type { AABB, Orientation } from './geometry'
import { loadGeometries, palletParts, shortUnitLabel, UnitGeometry } from './load'
import { isOutsideSpace } from './staging'
import { itemBox, palletSummary } from './pallet'
import { kitBoxLabel, kitBoxLines, kitFamilyOf, packKeyOf } from './kitBoxes'
import type { LoadDoc, PackSnapshot, PalletDoc } from './types'

export type Side = 'OESTE' | 'CENTRO' | 'LESTE'

export interface ExpeditionRow {
  order: number
  id: string
  label: string
  kind: 'PALLET' | 'PACKAGE'
  /** tipo de palete (PBR-1, PCF-1150…) ou "volume" */
  carrier: string
  /** box = tipo da caixa de kits (ex.: "caixa 79583 (26 kits)"): uma linha por tipo, para saber o que carregar */
  items: { sku: string; name: string; boxes: number; units: number; box?: string }[]
  grossKg: number
  /** posição (mm): início e fim a partir da FRENTE (norte); lado; altura do apoio e da unidade */
  x0: number
  x1: number
  y0: number
  y1: number
  z0: number
  height: number
  side: Side
  /** palete girado 90° em relação à montagem */
  rotated: boolean
  /** rótulo(s) da(s) unidade(s) embaixo que a sustentam (empilhada; "P3 + P4" = ponte). null = no piso ou elevada sem apoio identificado (ver z0) */
  stackedOn: string | null
  /** unidade TOTALMENTE fora do equipamento (zona de trabalho): não entra na carga */
  outside: boolean
  /** carregada, mas passa em parte dos limites internos (alerta OUT_OF_BOUNDS do editor) */
  overhang: boolean
}

/** Composição EXATA de uma montagem de palete (os paletes iguais da carga juntos). */
export interface PalletComposition {
  /** rótulos dos paletes com esta montagem, na ordem de carregamento (P1, P4…) */
  labels: string[]
  /** tipo de palete (PBR-1, PCF-1150…) */
  carrier: string
  /** altura total com o tabuleiro (mm), peso bruto (produtos + embalagens + palete + acessórios) e líquido, por palete */
  heightMm: number
  grossKg: number
  netKg: number
  boxes: number
  /** produtos: caixas e unidades por palete; dims = medida da caixa (C × L × A); box = caixa coletiva de kits */
  items: { sku: string; name: string; boxes: number; units: number; box?: string; dims?: { l: number; w: number; h: number } }[]
  /** camadas de baixo para cima; camadas seguidas iguais juntas (de/até) */
  layers: { from: number; to: number; text: string }[]
  /** palete parcial: caixas que a montagem completa leva */
  fullBoxes: number | null
}

/** como a caixa aparece numa camada: kits pelo tipo de caixa; caixa deitada com a altura em que vai */
function layerKey(k: PackSnapshot, o: Orientation): string {
  const kit = kitFamilyOf(k.sku) ? ` (${kitBoxLabel(kitBoxLines([k])[0])})` : ''
  const lying = o[2] !== 'H' ? ` (deitada, altura ${Math.round(orientDims(k.dims, o).z)} mm)` : ''
  return `${k.sku}${kit}${lying}`
}

/**
 * Camadas de um palete, de baixo para cima: cada caixa fica na camada seguinte à da caixa em que se apoia
 * (no tabuleiro = 1ª), mesmo com alturas de caixa diferentes. Camadas seguidas iguais juntas. Números = caixas.
 */
export function palletLayers(p: PalletDoc): PalletComposition['layers'] {
  const TOL = 5
  const its = p.items
    .filter((it) => p.packs[it.packId])
    .map((it) => ({ it, b: itemBox(p, it) }))
    .sort((a, b) => a.b.min.z - b.b.min.z)
  const tier: number[] = []
  its.forEach(({ b }, i) => {
    if (b.min.z < TOL) {
      tier.push(1)
      return
    }
    let sup = 0
    let below = 0
    for (let j = 0; j < i; j++) {
      const s = its[j].b
      const top = s.min.z + s.size.z
      if (top > b.min.z + TOL) continue
      below = Math.max(below, tier[j]) // caixa sem apoio identificado (montagem manual): acima da mais alta embaixo
      if (top >= b.min.z - TOL && footprintOverlap(s, b) > 0) sup = Math.max(sup, tier[j])
    }
    tier.push((sup || below) + 1)
  })
  const byT = new Map<number, Map<string, number>>()
  its.forEach(({ it }, i) => {
    const key = layerKey(p.packs[it.packId], it.orientation)
    const m = byT.get(tier[i]) ?? new Map<string, number>()
    m.set(key, (m.get(key) ?? 0) + 1)
    byT.set(tier[i], m)
  })
  const texts = [...byT.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, m]) => [...m].sort((a, b) => a[0].localeCompare(b[0])).map(([key, n]) => `${n} × ${key}`).join(' + '))
  const out: PalletComposition['layers'] = []
  texts.forEach((t, i) => {
    const last = out.at(-1)
    if (last && last.text === t && last.to === i) last.to = i + 1
    else out.push({ from: i + 1, to: i + 1, text: t })
  })
  return out
}

/** mesma montagem = mesmo palete, acessórios, estado parcial e caixas (embalagem + posição + orientação) */
const palletSig = (p: PalletDoc) =>
  JSON.stringify([
    p.palletType.code,
    p.palletType.dims,
    p.accessoriesKg,
    p.fullBoxes ?? null,
    p.items
      .map((it) => {
        const k = p.packs[it.packId]
        return k ? `${packKeyOf(k)}|${k.sku}|${Math.round(it.pos.x)},${Math.round(it.pos.y)},${Math.round(it.pos.z)}|${it.orientation}` : ''
      })
      .sort(),
  ])

/** montagens dos paletes carregados (paletes iguais juntos), na ordem em que o primeiro de cada uma entra */
export function palletCompositions(doc: LoadDoc, rows: ExpeditionRow[]): PalletComposition[] {
  const bySig = new Map<string, PalletComposition>()
  for (const r of rows) {
    if (r.outside || r.kind !== 'PALLET') continue
    const u = doc.units.find((x) => x.id === r.id)
    if (!u || u.kind !== 'PALLET') continue
    const p = doc.pallets[u.palletKey]
    if (!p) continue
    const sig = palletSig(p)
    const cur = bySig.get(sig)
    if (cur) {
      cur.labels.push(r.label)
      continue
    }
    const sm = palletSummary(p)
    const packsOf = (sku: string) => Object.values(p.packs).filter((k) => k.sku === sku)
    // medida da caixa; kits: a da caixa daquele tipo (79583 de 26, meia caixa, individual)
    const dimsOf = (i: ExpeditionRow['items'][number]) => {
      const ks = packsOf(i.sku)
      if (!i.box) return (ks.find((k) => !k.kitBox) ?? ks[0])?.dims
      return ks.find((k) => kitBoxLabel(kitBoxLines([k])[0]) === i.box)?.dims
    }
    bySig.set(sig, {
      labels: [r.label],
      carrier: p.palletType.code,
      heightMm: Math.round(sm.totalHeightMm),
      grossKg: sm.grossKg,
      netKg: sm.netKg,
      boxes: sm.packages,
      items: r.items.map((i) => ({ ...i, dims: dimsOf(i) })),
      layers: palletLayers(p),
      fullBoxes: p.fullBoxes ?? null,
    })
  }
  // rótulos em ordem natural (P1, P2, … P10) dentro de cada montagem
  const num = (l: string) => Number(/\d+/.exec(l)?.[0] ?? 0)
  for (const c of bySig.values()) c.labels.sort((a, b) => num(a) - num(b) || a.localeCompare(b))
  return [...bySig.values()]
}

export interface ExpeditionModel {
  rows: ExpeditionRow[]
  /** composição exata de cada palete (montagens iguais juntas) */
  pallets: PalletComposition[]
  /** passos da sequência (ids acumulados até cada passo) para as vistas 3D */
  steps: { title: string; ids: string[] }[]
  /** avisos para quem carrega: vãos entre unidades e espaços livres na frente/traseira */
  notes: string[]
  totals: { units: number; pallets: number; packages: number; boxes: number; grossKg: number; usedLengthMm: number }
}

/**
 * Lado pela parede mais próxima: CENTRO só quando a linha do meio do equipamento passa pela metade
 * central da unidade (unidade centralizada ou 3 por largura). Dois paletes de 1000 mm lado a lado
 * num contêiner de 2352 mm = OESTE e LESTE (não "centro").
 */
export const sideOf = (y0: number, y1: number, W: number): Side => {
  const mid = W / 2
  if (y0 < mid && mid < y1 && Math.min(mid - y0, y1 - mid) >= 0.25 * (y1 - y0)) return 'CENTRO'
  return y0 + (y1 - y0) / 2 < mid ? 'OESTE' : 'LESTE'
}

/** Rótulo da unidade, o mesmo do 3D e dos alertas: P5 (palete), V7 (volume solto) ou o rótulo editado. */
/** Conteúdo de uma unidade da carga; kits em caixas coletivas: uma linha por tipo de caixa (units = kits). */
export function unitItems(doc: LoadDoc, g: UnitGeometry): ExpeditionRow['items'] {
  const u = g.unit
  const pd = u.kind === 'PALLET' ? doc.pallets[u.palletKey] : undefined
  const packs: PackSnapshot[] = (u.kind === 'PALLET' ? (pd?.items ?? []).map((it) => pd!.packs[it.packId]) : [doc.packs[u.packId]]).filter(Boolean)
  return g.bySku.flatMap((l) => {
    const mine = packs.filter((k) => k.sku === l.sku)
    if (!kitFamilyOf(l.sku) || !mine.some((k) => k.kitBox)) return [{ sku: l.sku, name: l.name, boxes: l.packages, units: l.units }]
    return kitBoxLines(mine).map((b) => ({ sku: l.sku, name: l.name, boxes: b.boxes, units: b.boxes * b.kits, box: kitBoxLabel(b) }))
  })
}

export function unitLabel(doc: LoadDoc, id: string): string {
  const i = doc.units.findIndex((u) => u.id === id)
  return i < 0 ? id : shortUnitLabel(doc.units[i], i)
}

/**
 * Modelo da instrução de carregamento. Ordem: da frente (norte) para a traseira (sul), de baixo para
 * cima, do oeste para o leste — a ordem em que a carga é montada.
 */
export function expeditionModel(doc: LoadDoc, o: { maxSteps?: number; gapMm?: number } = {}): ExpeditionModel {
  const L = doc.space.inner.l, W = doc.space.inner.w
  const gapMin = o.gapMm ?? 50
  const geoms = loadGeometries(doc)
  // fora da carga = zona de trabalho (TOTALMENTE fora), a mesma definição do resto do sistema
  const out = new Map(geoms.map((g) => [g, isOutsideSpace(doc, g.box)]))
  const isOut = (g: UnitGeometry) => out.get(g) ?? false
  const sorted = [...geoms].sort((a, b) => Number(isOut(a)) - Number(isOut(b)) || a.box.min.x - b.box.min.x || a.box.min.z - b.box.min.z || a.box.min.y - b.box.min.y)
  const label = (g: UnitGeometry) => unitLabel(doc, g.unit.id)
  const overlapXY = (a: AABB, b: AABB) =>
    a.min.x < b.min.x + b.size.x - 1 && b.min.x < a.min.x + a.size.x - 1 && a.min.y < b.min.y + b.size.y - 1 && b.min.y < a.min.y + a.size.y - 1
  // superfícies REAIS de cada unidade: palete = tabuleiro + cada caixa (uma caixa solta pode estar
  // sobre a 1ª camada de um palete parcial, abaixo do topo do envelope); volume = a própria caixa
  const parts = new Map(
    geoms.map((g) => {
      const u = g.unit
      const p = u.kind === 'PALLET' ? doc.pallets[u.palletKey] : undefined
      return [g, u.kind === 'PALLET' && p ? palletParts(p, u).map((x) => x.box) : [g.box]] as const
    }),
  )
  /** topo da parte mais alta de b que fica embaixo de g (null = b não está embaixo de g) */
  const supportTop = (b: UnitGeometry, g: UnitGeometry): number | null => {
    if (b === g || !overlapXY(b.box, g.box)) return null
    let best: number | null = null
    for (const a of parts.get(b) ?? []) {
      const t = a.min.z + a.size.z
      if (t <= g.box.min.z + 5 && overlapXY(a, g.box)) best = Math.max(best ?? -Infinity, t)
    }
    return best
  }
  // ORDEM TOPOLÓGICA: uma unidade só entra depois de TODAS as que estão embaixo dela (apoio ou ponte);
  // entre as liberadas, vale a ordem frente → traseira, baixo → cima, oeste → leste. Fora da carga no
  // fim (uma unidade carregada nunca espera por uma da zona de trabalho).
  const pending = [...sorted]
  const ordered: UnitGeometry[] = []
  while (pending.length) {
    const k = pending.findIndex((g) => !pending.some((b) => (!isOut(b) || isOut(g)) && supportTop(b, g) != null))
    ordered.push(...pending.splice(Math.max(0, k), 1))
  }
  // APOIO real: as unidades com a superfície mais alta embaixo (até 50 mm abaixo da base = folga de medida)
  const supportsOf = (g: UnitGeometry): UnitGeometry[] => {
    if (g.box.min.z <= 1) return []
    const cands = geoms.map((b) => ({ b, t: supportTop(b, g) })).filter((c): c is { b: UnitGeometry; t: number } => c.t != null)
    if (!cands.length) return []
    const maxTop = Math.max(...cands.map((c) => c.t))
    if (maxTop < g.box.min.z - 50) return []
    return cands
      .filter((c) => c.t >= maxTop - 5)
      .map((c) => c.b)
      .sort((a, b) => a.box.min.x - b.box.min.x || a.box.min.y - b.box.min.y)
  }
  const itemsOf = (g: UnitGeometry) => unitItems(doc, g)
  const rows: ExpeditionRow[] = ordered.map((g, i) => {
    const u = g.unit
    const sup = supportsOf(g)
    return {
      order: i + 1,
      id: u.id,
      label: label(g),
      kind: u.kind,
      carrier: u.kind === 'PALLET' ? doc.pallets[u.palletKey]?.palletType.code ?? 'palete' : 'volume',
      items: itemsOf(g),
      grossKg: g.grossKg,
      x0: Math.round(g.box.min.x),
      x1: Math.round(g.box.min.x + g.box.size.x),
      y0: Math.round(g.box.min.y),
      y1: Math.round(g.box.min.y + g.box.size.y),
      z0: Math.round(g.box.min.z),
      height: Math.round(g.box.size.z),
      side: sideOf(g.box.min.y, g.box.min.y + g.box.size.y, W),
      rotated: u.kind === 'PALLET' ? u.yaw : false,
      stackedOn: sup.length ? sup.slice(0, 3).map(label).join(' + ') + (sup.length > 3 ? ' …' : '') : null,
      outside: isOut(g),
      overhang: !isOut(g) && (g.box.min.x < -1 || g.box.min.x + g.box.size.x > L + 1 || g.box.min.y < -1 || g.box.min.y + g.box.size.y > W + 1),
    }
  })
  const loaded = rows.filter((r) => !r.outside)

  // passos da sequência: blocos de unidades na ordem de carregamento (no máximo maxSteps imagens)
  const maxSteps = Math.max(1, o.maxSteps ?? 6)
  const per = Math.max(1, Math.ceil(loaded.length / maxSteps))
  const steps: ExpeditionModel['steps'] = []
  for (let i = 0; i < loaded.length; i += per) {
    const upto = loaded.slice(0, i + per)
    const block = loaded.slice(i, i + per)
    steps.push({ title: `Passo ${steps.length + 1}: ${block[0].label}${block.length > 1 ? ` a ${block[block.length - 1].label}` : ''} (${upto.length} de ${loaded.length})`, ids: upto.map((r) => r.id) })
  }

  // avisos POR FAIXA (carril): espaço livre junto ao motorista e à porta, e vãos entre unidades do piso
  const notes: string[] = []
  const floor = loaded.filter((r) => r.z0 <= 1)
  if (floor.length) {
    const sameLane = (a: ExpeditionRow, b: ExpeditionRow) => a !== b && a.y0 < b.y1 - 1 && b.y0 < a.y1 - 1
    // primeira / última unidade de cada faixa: nada do piso antes / depois dela na mesma faixa
    const firsts = floor.filter((r) => !floor.some((b) => sameLane(b, r) && b.x1 <= r.x0 + 1))
    const lasts = floor.filter((r) => !floor.some((b) => sameLane(b, r) && b.x0 >= r.x1 - 1))
    const ends = (list: ExpeditionRow[], gap: (r: ExpeditionRow) => number, all: (n: number) => string, one: (labels: string, side: string, n: number) => string) => {
      const open = list.filter((r) => gap(r) > gapMin)
      if (!open.length) return
      // todas as faixas com o mesmo espaço: um aviso só
      if (open.length === list.length && Math.max(...open.map(gap)) - Math.min(...open.map(gap)) <= 10) return void notes.push(all(Math.min(...open.map(gap))))
      // senão, um aviso por espaço e lado (unidades lado a lado com o mesmo espaço juntas)
      const groups = new Map<string, ExpeditionRow[]>()
      for (const r of open) {
        const k = `${gap(r)}|${r.side}`
        groups.set(k, [...(groups.get(k) ?? []), r])
      }
      for (const rs of groups.values()) notes.push(one(rs.map((r) => r.label).join(', '), rs[0].side.toLowerCase(), gap(rs[0])))
    }
    ends(
      firsts,
      (r) => r.x0,
      (n) => `Espaço livre de ${n} mm junto à FRENTE (norte, cabine) antes da primeira fileira: travar com calço/airbag/barra.`,
      (labels, side, n) => `Espaço livre de ${n} mm entre a FRENTE (norte) e ${labels} (lado ${side}): travar com calço/airbag/barra.`,
    )
    ends(
      lasts,
      (r) => L - r.x1,
      (n) => `Espaço livre de ${n} mm junto à TRASEIRA (sul): travar a última fileira (calço/airbag/barra).`,
      (labels, side, n) => `Espaço livre de ${n} mm entre ${labels} (lado ${side}) e a TRASEIRA (sul): travar (calço/airbag/barra).`,
    )
    for (const r of floor) {
      // próxima unidade do piso na direção da porta que ocupa a mesma faixa (y)
      const next = floor.filter((b) => sameLane(b, r) && b.x0 >= r.x1 - 1).sort((a, b) => a.x0 - b.x0)[0]
      if (next && next.x0 - r.x1 > gapMin) notes.push(`Vão de ${next.x0 - r.x1} mm entre ${r.label} e ${next.label} (lado ${r.side.toLowerCase()}): calçar.`)
    }
  }
  const over = loaded.filter((r) => r.overhang)
  if (over.length) notes.push(`${over.map((r) => r.label).join(', ')} passa(m) dos limites internos do equipamento no plano: revisar a posição antes de carregar.`)
  const outside = rows.filter((r) => r.outside)
  if (outside.length) notes.push(`${outside.length} unidade(s) FORA do equipamento no plano (${outside.map((r) => r.label).join(', ')}): não carregar sem revisar.`)

  return {
    rows,
    pallets: palletCompositions(doc, rows),
    steps,
    notes,
    totals: {
      units: loaded.length,
      pallets: loaded.filter((r) => r.kind === 'PALLET').length,
      packages: loaded.filter((r) => r.kind === 'PACKAGE').length,
      boxes: loaded.reduce((s, r) => s + r.items.reduce((a, i) => a + i.boxes, 0), 0),
      grossKg: loaded.reduce((s, r) => s + r.grossKg, 0),
      usedLengthMm: loaded.length ? Math.max(...loaded.map((r) => r.x1)) : 0,
    },
  }
}
