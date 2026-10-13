/**
 * PEDIDO EM VÁRIAS UNIDADES DE TRANSPORTE (contêineres, caminhões/carretas, ULDs).
 *
 * Regra Pacifil: primeiro a MENOR quantidade de unidades; quando forem várias, completar ao máximo
 * a 1ª, depois a 2ª… e deixar o remanente concentrado na ÚLTIMA (nunca repartir por igual). Assim o
 * cliente vê quanto espaço sobra no último e pode completar, reduzir ou mandar parcial.
 *
 * Dentro de cada unidade, prefere PRODUTOS INTEIROS (todas as paletes de uma linha na mesma unidade);
 * só parte uma linha para completar o espaço que sobrou. Peso, medidas, porta, altura, empilhamento e
 * payload são do motor de carga (placePallets); a distribuição de peso, de balanceWeight.
 */
import { placeLooseBoxes, placePallets } from './autoload'
import { balanceWeight } from './balance'
import { effectiveLimits, loadSummary } from './load'
import { palletSummary } from './pallet'
import type { LoadDoc, PackSnapshot, PalletDoc, SpaceSnapshot } from './types'

/** Paletes iguais de uma mesma montagem (uma "linha" do pedido em paletes). */
export interface PalletGroup {
  key: string
  pallet: PalletDoc
  count: number
}

/** Caixas soltas de um mesmo produto. */
export interface LooseGroup {
  packId: string
  pack: PackSnapshot
  count: number
}

export interface UnitPlan {
  doc: LoadDoc
  /** paletes por montagem nesta unidade */
  groups: { key: string; name: string; count: number }[]
  loose: { packId: string; sku: string; count: number }[]
}

export interface MultiUnitPlan {
  units: UnitPlan[]
  /** o que não cabe nem numa unidade vazia (ou passou do máximo de unidades) */
  unplaced: { key: string; name: string; count: number }[]
  unplacedLoose: { packId: string; sku: string; count: number }[]
  /** equipamento menor que comporta o remanente da última unidade (só sugestão; não aplicada) */
  smallerLast: SpaceSnapshot | null
}

const kgOf = (p: PalletDoc) => palletSummary(p).grossKg
const area = (p: PalletDoc) => p.palletType.dims.l * p.palletType.dims.w

/** Paletes e caixas soltas de uma carga, agrupados (entrada padrão: "dividir esta carga"). */
export function groupsOfDoc(doc: LoadDoc): { pallets: PalletGroup[]; loose: LooseGroup[] } {
  const pc = new Map<string, number>()
  const lc = new Map<string, number>()
  for (const u of doc.units) {
    if (u.kind === 'PALLET') pc.set(u.palletKey, (pc.get(u.palletKey) ?? 0) + 1)
    else lc.set(u.packId, (lc.get(u.packId) ?? 0) + 1)
  }
  return {
    pallets: [...pc].filter(([k]) => doc.pallets[k]).map(([key, count]) => ({ key, pallet: doc.pallets[key], count })),
    loose: [...lc].filter(([k]) => doc.packs[k]).map(([packId, count]) => ({ packId, pack: doc.packs[packId], count })),
  }
}

/** Unidade vazia com o mesmo equipamento e limites da carga base. */
export function emptyUnit(base: LoadDoc, space: SpaceSnapshot = base.space): LoadDoc {
  return { space, limits: base.limits, packs: {}, pallets: {}, units: [] }
}

/**
 * Coloca todos os paletes do conjunto numa unidade vazia (maiores e mais pesados primeiro, como o
 * "reorganizar"). Devolve a carga ou null se algum palete não couber.
 */
export function fitPallets(empty: LoadDoc, set: Map<string, number>, byKey: Map<string, PalletGroup>): LoadDoc | null {
  const keys = [...set.keys()].filter((k) => (set.get(k) ?? 0) > 0)
  keys.sort((a, b) => area(byKey.get(b)!.pallet) - area(byKey.get(a)!.pallet) || kgOf(byKey.get(b)!.pallet) - kgOf(byKey.get(a)!.pallet))
  let d = empty
  for (const k of keys) {
    const want = set.get(k)!
    const r = placePallets(d, k, byKey.get(k)!.pallet, want)
    if (r.placed < want) return null
    d = r.doc
  }
  return d
}

/** Maior n em [0, max] tal que ok(n) (ok monotônico: se cabe n, cabe n-1). */
function maxFeasible(max: number, ok: (n: number) => boolean): number {
  let lo = 0, hi = max
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (ok(mid)) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Enche UMA unidade com o máximo do que resta: primeiro linhas inteiras (mais kg primeiro), depois
 * completa o espaço que sobrou com parte das linhas que não couberam inteiras.
 */
function fillOne(empty: LoadDoc, remaining: Map<string, number>, byKey: Map<string, PalletGroup>): { set: Map<string, number>; doc: LoadDoc } | null {
  const all = fitPallets(empty, remaining, byKey)
  if (all) return { set: new Map(remaining), doc: all }
  const order = [...remaining.keys()].filter((k) => remaining.get(k)! > 0)
  order.sort((a, b) => remaining.get(b)! * kgOf(byKey.get(b)!.pallet) - remaining.get(a)! * kgOf(byKey.get(a)!.pallet))
  const set = new Map<string, number>()
  let doc: LoadDoc | null = null
  // 1) produtos inteiros
  for (const k of order) {
    const trial = new Map(set).set(k, remaining.get(k)!)
    const d = fitPallets(empty, trial, byKey)
    if (d) {
      set.set(k, remaining.get(k)!)
      doc = d
    }
  }
  // 2) completa com parte das linhas que ficaram de fora (mais pesadas por palete primeiro: mais kg no espaço)
  const rest = order.filter((k) => !set.has(k)).sort((a, b) => kgOf(byKey.get(b)!.pallet) - kgOf(byKey.get(a)!.pallet))
  for (const k of rest) {
    const n = maxFeasible(remaining.get(k)! - 1, (m) => m === 0 || fitPallets(empty, new Map(set).set(k, m), byKey) != null)
    if (n > 0) {
      set.set(k, n)
      doc = fitPallets(empty, set, byKey)
    }
  }
  return doc ? { set, doc } : null
}

const groupLines = (set: Map<string, number>, byKey: Map<string, PalletGroup>) =>
  [...set].filter(([, n]) => n > 0).map(([key, count]) => ({ key, name: byKey.get(key)!.pallet.name, count }))

/**
 * Divide um pedido (paletes + caixas soltas) em unidades do equipamento de `base`, enchendo uma de
 * cada vez. `alternatives`: equipamentos do mesmo modal para sugerir um menor para o remanente.
 */
export function splitIntoUnits(
  base: LoadDoc,
  pallets: PalletGroup[],
  loose: LooseGroup[] = [],
  opts: { maxUnits?: number; alternatives?: SpaceSnapshot[] } = {},
): MultiUnitPlan {
  const maxUnits = opts.maxUnits ?? 10
  const byKey = new Map(pallets.map((g) => [g.key, g]))
  const remaining = new Map(pallets.filter((g) => g.count > 0).map((g) => [g.key, g.count]))
  const empty = emptyUnit(base)
  const docs: { doc: LoadDoc; set: Map<string, number> }[] = []
  const unplaced: MultiUnitPlan['unplaced'] = []

  // paletes que não cabem nem sozinhos numa unidade vazia (porta, altura, payload) ficam de fora
  for (const k of [...remaining.keys()]) {
    if (!fitPallets(empty, new Map([[k, 1]]), byKey)) {
      unplaced.push({ key: k, name: byKey.get(k)!.pallet.name, count: remaining.get(k)! })
      remaining.delete(k)
    }
  }
  while ([...remaining.values()].some((n) => n > 0) && docs.length < maxUnits) {
    const r = fillOne(empty, remaining, byKey)
    if (!r) break
    docs.push(r)
    for (const [k, n] of r.set) remaining.set(k, remaining.get(k)! - n)
  }
  for (const [k, n] of remaining) if (n > 0) unplaced.push({ key: k, name: byKey.get(k)!.pallet.name, count: n })

  // caixas soltas: completam a primeira unidade com espaço (mesma regra: encher em ordem)
  const unplacedLoose: MultiUnitPlan['unplacedLoose'] = []
  const looseIn: Map<string, number>[] = docs.map(() => new Map())
  for (const g of loose) {
    let left = g.count
    for (let i = 0; i < docs.length && left > 0; i++) {
      const r = placeLooseBoxes(docs[i].doc, g.packId, g.pack, left)
      if (r.placed) {
        docs[i].doc = r.doc
        looseIn[i].set(g.packId, r.placed)
        left -= r.placed
      }
    }
    if (left > 0 && docs.length < maxUnits) {
      // nenhuma unidade tinha espaço para o resto: abre mais uma
      const r = placeLooseBoxes(docs.length ? emptyUnit(base) : empty, g.packId, g.pack, left)
      if (r.placed) {
        docs.push({ doc: r.doc, set: new Map() })
        looseIn.push(new Map([[g.packId, r.placed]]))
        left -= r.placed
      }
    }
    if (left > 0) unplacedLoose.push({ packId: g.packId, sku: g.pack.sku, count: left })
  }

  const units: UnitPlan[] = docs.map(({ doc, set }, i) => {
    const b = balanceWeight(doc)
    const balanced = b.doc !== doc && b.physicalIssuesAfter === 0 ? b.doc : doc
    return {
      doc: balanced,
      groups: groupLines(set, byKey),
      loose: [...looseIn[i]].map(([packId, count]) => ({ packId, sku: doc.packs[packId]?.sku ?? packId, count })),
    }
  })

  // sugestão: equipamento menor (por volume interno) onde o remanente inteiro caberia
  let smallerLast: SpaceSnapshot | null = null
  const last = docs[docs.length - 1]
  if (docs.length > 1 && last && last.set.size && !looseIn[docs.length - 1].size && opts.alternatives?.length) {
    const vol = (s: SpaceSnapshot) => s.inner.l * s.inner.w * s.inner.h
    const cands = opts.alternatives.filter((s) => vol(s) < vol(base.space) && (s.transport ?? null) === (base.space.transport ?? null)).sort((a, b) => vol(a) - vol(b))
    smallerLast = cands.find((s) => fitPallets(emptyUnit(base, s), last.set, byKey)) ?? null
  }
  return { units, unplaced, unplacedLoose, smallerLast }
}

/** Quanto ainda cabe numa unidade: payload livre e, por montagem, quantos paletes a mais. */
export function freeCapacity(doc: LoadDoc, candidates: PalletGroup[]): { payloadFreeKg: number | null; morePallets: { key: string; name: string; count: number }[] } {
  const s = loadSummary(doc)
  const limit = effectiveLimits(doc).payloadKg.value
  // um representante por tipo de palete (o mais alto e, empatando, o mais pesado: estimativa conservadora)
  const rep = new Map<string, PalletGroup>()
  for (const g of candidates) {
    const t = g.pallet.palletType.code
    const cur = rep.get(t)
    const h = (p: PalletDoc) => palletSummary(p).totalHeightMm
    if (!cur || h(g.pallet) > h(cur.pallet) || (h(g.pallet) === h(cur.pallet) && kgOf(g.pallet) > kgOf(cur.pallet))) rep.set(t, g)
  }
  return {
    payloadFreeKg: limit != null ? Math.max(0, limit - s.payloadKg) : null,
    morePallets: [...rep].map(([type, g]) => ({
      key: g.key,
      name: rep.size === candidates.length && !g.pallet.name.startsWith('Misto') ? g.pallet.name : `paletes ${type} (como ${g.pallet.name})`,
      count: placePallets(doc, g.key, g.pallet, null).placed,
    })),
  }
}

/** Avisos da divisão para o usuário: o que não coube e equipamento menor para o remanente. */
export function planNotes(plan: MultiUnitPlan): string[] {
  return [
    ...(plan.unplaced.length ? [`Não couberam: ${plan.unplaced.map((u) => `${u.count} × ${u.name}`).join(', ')}.`] : []),
    ...(plan.unplacedLoose.length ? [`Caixas soltas sem lugar: ${plan.unplacedLoose.map((u) => `${u.count} × ${u.sku}`).join(', ')}.`] : []),
    ...(plan.smallerLast ? [`O remanente (última unidade) caberia num ${plan.smallerLast.code} — ${plan.smallerLast.name}.`] : []),
  ]
}
