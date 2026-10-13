/**
 * CAIXAS DE KITS (acompanhante embalado em caixa coletiva).
 *
 * Os kits Hydroforce (KIT-HF) viajam em: caixa 79583 do Hidrosilo (1140 × 570 × 250 mm, 26 kits),
 * meia caixa (570 × 570 × 250 mm, até 13 kits), caixa 69488 (1000 × 600 × 400 mm, 36 kits — o palete de
 * 36 Hydroforce 5.000 L) e a caixa individual do catálogo (1 kit).
 * Regra (sempre 1 Hydroforce = 1 kit; menor nº de caixas, maiores primeiro):
 *   0. exatamente 36 kits → 1 caixa 69488 (planilha da produção, decisão do usuário em 12/10/2026); se ela
 *      não couber (altura), vale o resto da regra (26 + 10 individuais);
 *   1. ⌊n ÷ 26⌋ caixas de 26;
 *   2. resto 13 → 1 meia caixa; resto 14–25 → 2 meias caixas (13 + resto − 13);
 *   3. resto 1–12 → caixas individuais (decisão do usuário em 09/10/2026: HF 5K, 36 = caixa de 26 + 10 soltas).
 *
 * Mesmo SKU do kit: cada caixa coletiva é um PackSnapshot DERIVADO da embalagem individual do
 * catálogo, com unitsPerPackage = kits dentro (preço e kg líquido por kit iguais; preço segue por
 * unidade = kit) e o campo kitBox. A tabela fica no código (a caixa física muda raramente e é congelada
 * no snapshot de cada carga). Módulo puro.
 */
import { Dims, orientDims } from './geometry'
import type { PackSnapshot } from './types'

export type KitBoxKind = 'BIG' | 'HALF' | 'IND'

export interface KitBoxSpec {
  code: string
  dims: Dims
  /** caixa vazia (kg) */
  tareKg: number
  /** kits por caixa (máximo) */
  capacity: number
}

export interface KitBoxFamily {
  /** caixa grande (só vai cheia) */
  big: KitBoxSpec
  /** meia caixa (pode ir parcialmente cheia) */
  half: KitBoxSpec
  /** resto (kits além das caixas de 26) a partir do qual vai numa meia caixa parcial; abaixo, individuais */
  halfMinKits: number
  /** caixas usadas só quando o total de kits é EXATAMENTE a capacidade delas (ex.: 69488 de 36 kits) */
  exact?: KitBoxSpec[]
}

export const KIT_BOX_FAMILIES: Record<string, KitBoxFamily> = {
  'KIT-HF': {
    big: { code: '79583', dims: { l: 1140, w: 570, h: 250 }, tareKg: 3.2, capacity: 26 },
    half: { code: '79583-M', dims: { l: 570, w: 570, h: 250 }, tareKg: 1.6, capacity: 13 },
    // decisão do usuário (09/10/2026): meia caixa só a partir de 13 (13 cheia; 14–25 em duas); 1–12 vão em caixas individuais
    halfMinKits: 13,
    // planilha da produção (DADOS HIDROSILO, 12/10/2026): caixa 69488 com 36 kits = 70,45 kg (36 × 1,8 kg + 5,65 kg da caixa)
    exact: [{ code: '69488', dims: { l: 1000, w: 600, h: 400 }, tareKg: 5.65, capacity: 36 }],
  },
}

/** Apoio mínimo das caixas coletivas de kits: a de 26 sobre o cata-vento do HF 2K fica ~92% apoiada. */
export const KIT_BOX_MIN_SUPPORT_PCT = 90

export const kitFamilyOf = (sku: string): KitBoxFamily | null => KIT_BOX_FAMILIES[sku.toUpperCase()] ?? null

export interface KitFill {
  box: KitBoxKind
  kits: number
}

/** a caixa física de um preenchimento: meia caixa, a de 26 ou uma caixa "exata" (ex.: 69488 de 36) */
export function kitBoxSpec(fam: KitBoxFamily, box: 'BIG' | 'HALF', kits: number): KitBoxSpec {
  if (box === 'HALF') return fam.half
  if (kits === fam.big.capacity) return fam.big
  return fam.exact?.find((e) => e.capacity === kits) ?? fam.big
}

/** Caixas para n kits (maiores primeiro). SKU sem família: uma caixa individual por kit. */
export function packKits(n: number, sku = 'KIT-HF'): KitFill[] {
  const total = Math.max(0, Math.ceil(n))
  const f = kitFamilyOf(sku)
  if (!f) return Array.from({ length: total }, () => ({ box: 'IND' as const, kits: 1 }))
  // caixa do tamanho exato (36 kits = 1 caixa 69488)
  if (total > 0 && f.exact?.some((e) => e.capacity === total)) return [{ box: 'BIG', kits: total }]
  return standardKits(total, f)
}

/** a regra de sempre: caixas de 26, meias caixas (13 / 14–25) ou individuais (1–12) */
function standardKits(total: number, f: KitBoxFamily): KitFill[] {
  const out: KitFill[] = []
  for (let i = 0; i < Math.floor(total / f.big.capacity); i++) out.push({ box: 'BIG', kits: f.big.capacity })
  let r = total % f.big.capacity
  if (r >= Math.min(f.halfMinKits, f.half.capacity)) {
    // 13 → uma meia caixa cheia; 14–25 → duas meias caixas (a segunda parcial)
    while (r > 0) {
      const k = Math.min(r, f.half.capacity)
      out.push({ box: 'HALF', kits: k })
      r -= k
    }
  } else for (let i = 0; i < r; i++) out.push({ box: 'IND', kits: 1 })
  return out
}

/**
 * Se a caixa não couber: a caixa exata (69488 de 36) vira a regra de sempre (26 + individuais); a de 26 vira
 * meias caixas de 13; a meia caixa vira caixas individuais.
 */
export function kitFallback(f: KitFill, sku = 'KIT-HF'): KitFill[] {
  const fam = kitFamilyOf(sku)
  if (f.box === 'BIG' && fam && f.kits !== fam.big.capacity) return standardKits(f.kits, fam)
  if (f.box === 'BIG' && fam) {
    const out: KitFill[] = []
    for (let r = f.kits; r > 0; r -= fam.half.capacity) out.push({ box: 'HALF', kits: Math.min(r, fam.half.capacity) })
    return out
  }
  if (f.box === 'HALF') return Array.from({ length: f.kits }, () => ({ box: 'IND' as const, kits: 1 }))
  return []
}

const round3 = (v: number) => Math.round(v * 1000) / 1000

/** Caixa coletiva com `kits` kits, derivada da embalagem individual do catálogo (mesmo SKU/versão/preço/cor). */
export function kitBoxPack(base: PackSnapshot, box: 'BIG' | 'HALF', kits: number): PackSnapshot {
  const fam = kitFamilyOf(base.sku)
  if (!fam) throw new Error(`${base.sku} não tem caixas coletivas de kits`)
  const spec = kitBoxSpec(fam, box, kits)
  // o snapshot é sempre derivado da caixa individual (nunca de outra caixa coletiva)
  const ind = kitBaseOf(base)
  const netKg = round3((kits * ind.netKg) / Math.max(1, ind.unitsPerPackage))
  return {
    ...ind,
    dims: { ...spec.dims },
    netKg,
    grossKg: round3(netKg + spec.tareKg),
    unitsPerPackage: kits,
    allowedOrientations: ['LWH', 'WLH'],
    kitBox: {
      kind: box,
      code: spec.code,
      capacity: spec.capacity,
      kits,
      unit: { dims: { ...ind.dims }, netKg: ind.netKg, grossKg: ind.grossKg, unitsPerPackage: ind.unitsPerPackage, allowedOrientations: [...ind.allowedOrientations] },
    },
  }
}

/** Embalagem individual (do catálogo) de um kit, a partir de qualquer caixa do kit (coletiva ou não). */
export function kitBaseOf(pack: PackSnapshot): PackSnapshot {
  if (!pack.kitBox) return pack
  const u = pack.kitBox.unit
  const rest: PackSnapshot = { ...pack }
  delete rest.kitBox
  return { ...rest, dims: { ...u.dims }, netKg: u.netKg, grossKg: u.grossKg, unitsPerPackage: u.unitsPerPackage, allowedOrientations: [...u.allowedOrientations] }
}

/** Chave única da embalagem num documento: pv<id>; caixa coletiva de kits: pv<id>:<código>x<kits>. */
export function packKeyOf(p: PackSnapshot): string {
  return `pv${p.packagingVersionId}${p.kitBox ? `:${p.kitBox.code}x${p.kitBox.kits}` : ''}`
}

/** Embalagem (chave + snapshot) de uma caixa da regra; a individual mantém a chave recebida. */
export function kitFillPack(base: PackSnapshot, baseId: string, f: KitFill): { packId: string; pack: PackSnapshot } {
  if (f.box === 'IND') return { packId: baseId, pack: base }
  const pack = kitBoxPack(base, f.box, f.kits)
  return { packId: packKeyOf(pack), pack }
}

/** Linhas de pedido (caixas por embalagem) para n kits sem palete (courier): uma por tipo de caixa. */
export function kitOrderLines(base: PackSnapshot, baseId: string, n: number): { packId: string; pack: PackSnapshot; boxes: number }[] {
  const by = new Map<string, { packId: string; pack: PackSnapshot; boxes: number }>()
  for (const f of packKits(n, base.sku)) {
    const k = kitFillPack(base, baseId, f)
    const cur = by.get(k.packId) ?? { ...k, boxes: 0 }
    cur.boxes++
    by.set(k.packId, cur)
  }
  return [...by.values()]
}

const naturalZ = (p: PackSnapshot) => Math.min(...p.allowedOrientations.map((o) => orientDims(p.dims, o).z))

/**
 * Estimativa da camada de kits por cima de um palete (reserva de altura/peso do otimizador): quartos de
 * 570 × 570 por camada no tabuleiro; caixa de 26 = 2 quartos, meia caixa = 1, individuais 4 por quarto
 * (10 em meio palete). Camada com caixa coletiva = 250 mm; só individuais = altura da individual.
 */
export function kitLayerEstimate(n: number, base: PackSnapshot, deck: { l: number; w: number } = { l: 1150, w: 1150 }): { h: number; kg: number; boxes: number } {
  const ind = kitBaseOf(base)
  const fam = kitFamilyOf(ind.sku)
  const fills = packKits(n, ind.sku)
  // caixa exata (69488 de 36, 400 mm): só é usada se couber; para planejar o palete vale a regra de sempre
  // (a mais baixa), e a caixa exata entra no lugar dela quando houver altura
  if (fam && fills.some((f) => f.box === 'BIG' && f.kits !== fam.big.capacity)) {
    const std = layerOf(standardKits(Math.max(0, Math.ceil(n)), fam), ind, fam, deck)
    const ex = layerOf(fills, ind, fam, deck)
    return ex.h <= std.h ? ex : std
  }
  return layerOf(fills, ind, fam, deck)
}

function layerOf(fills: KitFill[], ind: PackSnapshot, fam: KitBoxFamily | null, deck: { l: number; w: number }): { h: number; kg: number; boxes: number } {
  const perKitNet = ind.netKg / Math.max(1, ind.unitsPerPackage)
  const kg = fills.reduce((s, f) => s + (f.box === 'IND' ? ind.grossKg : f.kits * perKitNet + kitBoxSpec(fam!, f.box, f.kits).tareKg), 0)
  const indH = naturalZ(ind)
  if (!fills.length) return { h: 0, kg: 0, boxes: 0 }
  if (!fam) {
    const per = Math.max(1, Math.floor(deck.l / ind.dims.l) * Math.floor(deck.w / ind.dims.w))
    return { h: Math.ceil(fills.length / per) * indH, kg, boxes: fills.length }
  }
  const q = fam.half.dims.l
  const perLayer = Math.max(1, Math.floor(deck.l / q) * Math.floor(deck.w / q))
  const fit = (a: number, b: number) => Math.max(Math.floor(a / ind.dims.l) * Math.floor(b / ind.dims.w), Math.floor(a / ind.dims.w) * Math.floor(b / ind.dims.l))
  const perQuarter = fit(q, q), perHalf = fit(2 * q, q)
  const nInd = fills.filter((f) => f.box === 'IND').length
  const indSlots = perQuarter > 0 ? 2 * Math.floor(nInd / Math.max(1, perHalf)) + (nInd % Math.max(1, perHalf) === 0 ? 0 : nInd % Math.max(1, perHalf) <= perQuarter ? 1 : 2) : nInd
  const boxSlots = fills.reduce((s, f) => s + (f.box === 'BIG' ? 2 : f.box === 'HALF' ? 1 : 0), 0)
  const boxLayers = Math.ceil(boxSlots / perLayer)
  const free = boxLayers * perLayer - boxSlots
  const extra = Math.ceil(Math.max(0, indSlots - free) / perLayer)
  // altura da camada de caixas coletivas: a mais alta usada (69488 = 400 mm; 26 e meia = 250 mm)
  const boxH = Math.max(fam.big.dims.h, ...fills.filter((f) => f.box !== 'IND').map((f) => kitBoxSpec(fam, f.box as 'BIG' | 'HALF', f.kits).dims.h))
  return { h: boxLayers * boxH + extra * indH, kg: round3(kg), boxes: fills.length }
}

export interface KitBoxLine {
  kind: KitBoxKind
  code: string | null
  /** kits por caixa */
  kits: number
  boxes: number
}

/** Caixas de kits agrupadas por tipo (uma entrada por caixa física): 26 primeiro, depois meias, individuais. */
export function kitBoxLines(packs: PackSnapshot[]): KitBoxLine[] {
  const by = new Map<string, KitBoxLine>()
  for (const p of packs) {
    const kind: KitBoxKind = p.kitBox?.kind ?? 'IND'
    const kits = p.kitBox ? p.kitBox.kits : p.unitsPerPackage
    const k = `${kind}|${kits}`
    const cur = by.get(k) ?? { kind, code: p.kitBox?.code ?? null, kits, boxes: 0 }
    cur.boxes++
    by.set(k, cur)
  }
  const rank = { BIG: 0, HALF: 1, IND: 2 }
  return [...by.values()].sort((a, b) => rank[a.kind] - rank[b.kind] || b.kits - a.kits)
}

/** Texto curto (português) de uma linha de caixas de kits. */
export const kitBoxLabel = (l: Pick<KitBoxLine, 'kind' | 'code' | 'kits'>) =>
  l.kind === 'BIG' ? `caixa ${l.code} (${l.kits} kits)` : l.kind === 'HALF' ? `meia caixa (${l.kits} kits)` : `caixa individual${l.kits > 1 ? ` (${l.kits} kits)` : ''}`

/** Ex.: "2 × caixa 79583 (26 kits) + 1 × meia caixa (10 kits)". */
export const describeKitBoxes = (lines: KitBoxLine[]) => lines.map((l) => `${l.boxes} × ${kitBoxLabel(l)}`).join(' + ')
