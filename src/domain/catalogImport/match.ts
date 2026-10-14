/**
 * Equivalente no catálogo atual: mesmo código (reimportação) ou mesma família + marca + medida +
 * espessura. O equivalente só serve de referência (atributos extras, caixa atual como evidência, palete do
 * catálogo) — os produtos atuais com outro código são desativados.
 */
import type { OfficialProduct } from './classify'
import type { ImportDecisions } from './decisions'
import type { Confidence, CurrentVariant, ProductMatch } from './types'

const near = (a: number | null | undefined, b: number | null | undefined, t: number) => a != null && b != null && Math.abs(a - b) <= t
const RANK: Record<Confidence, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 }
const REL_RANK = { SAME: 2, COMPATIBLE: 1, DIFFERENT: 0, EXACT_CODE: 3 } as const
type Relation = 'SAME' | 'COMPATIBLE' | 'DIFFERENT'

/**
 * Embalagem PROVISÓRIA do catálogo atual: estimada, criada a partir da tabela de caixas (attrs.ref_planilha)
 * com o peso líquido = máximo da faixa da caixa. Não vale como evidência de caixa nem de peso.
 */
export function isPlaceholderPack(v: CurrentVariant, d: ImportDecisions): boolean {
  return !!v.pack && v.pack.verification === 'ESTIMATED' && v.attrs?.ref_planilha != null && v.attrs.ref_planilha !== '' && d.placeholderNets.includes(Number(v.pack.netKg))
}

function familyGroup(f: string): string | null {
  if (f === 'SILAGE_TARP' || f === 'ANIMAL_COMFORT') return 'TARPS'
  if (f === 'SILO_BAG' || f === 'HIDROSILO' || f === 'HYDROFORCE') return f
  return null
}

const SILO_BAG_LINES = ['Silo-bolsa', 'Silo-bolsa Premium', 'Silo-bolsa Ecobag', 'Silo-bolsa Probag']

function relationOf(p: OfficialProduct, c: CurrentVariant): Relation {
  const cl = c.line
  if (p.family === 'SILO_BAG') {
    if (!SILO_BAG_LINES.includes(cl)) return 'DIFFERENT'
    return p.subLine ? 'COMPATIBLE' : 'SAME'
  }
  if (p.family === 'SILAGE_TARP') {
    if (cl === 'Lona medida especial') return 'COMPATIBLE'
    switch (p.lineKey) {
      case 'TARP_BPF':
        return cl === 'Lona BPF' ? 'SAME' : cl === 'Lona padrão' ? 'COMPATIBLE' : 'DIFFERENT'
      case 'TARP_BPF_PLUSX3':
      case 'TARP_BPF_BP':
        return cl === 'Lona BPF' ? 'COMPATIBLE' : 'DIFFERENT'
      case 'TARP_STD':
        return cl === 'Lona padrão' ? 'SAME' : cl === 'Lona BPF' ? 'COMPATIBLE' : 'DIFFERENT'
      case 'TARP_PLUS':
        return cl === 'Lona Plus (LP)' ? 'SAME' : 'DIFFERENT'
      case 'TARP_BIGSAFE':
        return cl === 'Lona BigSafe' ? 'SAME' : c.familyCode === 'ANIMAL_COMFORT' ? 'COMPATIBLE' : 'DIFFERENT'
      case 'TARP_BIGSAFE_PLUSX3':
      case 'TARP_BIGFORT':
        return cl === 'Lona BigSafe' || c.familyCode === 'ANIMAL_COMFORT' ? 'COMPATIBLE' : 'DIFFERENT'
      case 'TARP_BIGSILO':
        return cl === 'Lona Big Silo' ? 'SAME' : 'DIFFERENT'
      case 'TARP_BIGSILO_PLUSX3':
        return cl === 'Lona Big Silo' ? 'COMPATIBLE' : 'DIFFERENT'
      default:
        return 'DIFFERENT'
    }
  }
  if (p.family === 'HIDROSILO') return cl === 'Hidrosilo' ? (p.lineKey === 'HS' ? 'SAME' : 'COMPATIBLE') : 'DIFFERENT'
  if (p.family === 'HYDROFORCE') return cl === 'Hidroforce' ? 'SAME' : 'DIFFERENT'
  return 'DIFFERENT'
}

function dimsEqual(p: OfficialProduct, c: CurrentVariant): boolean {
  if (p.unitsPerPack) return false
  if (p.family === 'SILO_BAG') {
    if (!near(p.diameterFt, c.diameterFt, 0.01)) return false
    if (p.lengthFt != null || c.lengthFt != null) return near(p.lengthFt, c.lengthFt, 0.6)
    return near(p.lengthM, c.lengthM, 0.5)
  }
  if (p.family === 'SILAGE_TARP') return p.lengthFt == null && near(p.widthM, c.widthM, 0.01) && near(p.lengthM, c.lengthM, 0.5)
  if (p.family === 'HIDROSILO' || p.family === 'HYDROFORCE') return near(p.widthM, c.widthM, 0.01) && near(p.lengthM, c.lengthM, 0.05)
  return false
}

const pct = (x: number) => `${(x * 100).toFixed(1).replace('.', ',')}%`

export interface MatchResult {
  match: ProductMatch | null
  variant: CurrentVariant | null
  /** melhor candidato fraco (sem equivalência), para a observação */
  weak: string | null
}

export function matchProduct(p: OfficialProduct, current: CurrentVariant[], bySku: Map<string, CurrentVariant>, d: ImportDecisions): MatchResult {
  const exact = bySku.get(p.code)
  if (exact) return { match: { sku: exact.sku, variantId: exact.variantId, confidence: 'HIGH', lineRelation: 'EXACT_CODE', why: 'mesmo código (reimportação)' }, variant: exact, weak: null }
  const group = familyGroup(p.family)
  if (!group || p.thicknessUm == null) return { match: null, variant: null, weak: null }
  // líquido comparado com o do catálogo: o que a importação grava (silo-bolsa pelo perímetro real, como a tela
  // Catálogo recalcula), senão o da planilha
  const pNet = p.calcNetKg ?? p.netKg
  const cands: { c: CurrentVariant; conf: Confidence; rel: Relation; thRel: number; netDiff: number; why: string }[] = []
  for (const c of current) {
    if (!c.active || familyGroup(c.familyCode) !== group) continue
    if (c.brand !== p.brand) continue
    if (!dimsEqual(p, c)) continue
    if (c.thicknessUm == null || !c.thicknessUm) continue
    const placeholder = isPlaceholderPack(c, d)
    const thRel = Math.abs(p.thicknessUm - c.thicknessUm) / c.thicknessUm
    if (thRel > (placeholder ? 0.03 : d.matchThicknessTolPct)) continue
    const rel = relationOf(p, c)
    const cNet = c.pack?.netKg ?? null
    const netRel = cNet && pNet != null ? Math.abs(pNet - cNet) / cNet : 1
    const netOk = netRel <= d.matchNetTolPct || placeholder
    let conf: Confidence
    if (rel === 'SAME') conf = thRel <= 0.012 && netOk ? 'HIGH' : 'MEDIUM'
    else if (rel === 'COMPATIBLE') conf = netRel <= 0.2 || placeholder ? 'MEDIUM' : 'LOW'
    else conf = netRel <= 0.005 ? 'MEDIUM' : 'LOW'
    const why = [
      'família, marca e medida iguais',
      thRel === 0 ? 'espessura igual' : `espessura ${c.thicknessUm}→${p.thicknessUm} µm`,
      rel === 'SAME' ? `mesma linha (${c.line})` : rel === 'COMPATIBLE' ? `linha compatível (${c.line})` : `linha diferente (${c.line})`,
      placeholder ? `líquido atual ${cNet} kg é provisório (máximo da faixa da tabela de caixas)` : netRel <= 0.005 ? 'líquido igual' : `líquido ${cNet ?? '—'}→${pNet ?? '—'} kg (${pct(netRel)})`,
    ].join('; ')
    cands.push({ c, conf, rel, thRel, netDiff: cNet != null && pNet != null ? Math.abs(pNet - cNet) : Infinity, why })
  }
  cands.sort((a, b) => RANK[b.conf] - RANK[a.conf] || REL_RANK[b.rel] - REL_RANK[a.rel] || a.netDiff - b.netDiff || a.thRel - b.thRel || a.c.sku.localeCompare(b.c.sku))
  const best = cands[0]
  if (!best) return { match: null, variant: null, weak: null }
  if (best.conf === 'LOW') return { match: null, variant: null, weak: `possível equivalente fraco: ${best.c.sku} (${best.why})` }
  const ties = cands.slice(1).filter((x) => x.conf === best.conf && x.rel === best.rel && Math.abs(x.netDiff - best.netDiff) < 0.01)
  const why = best.why + (ties.length ? `; empate com ${ties.map((x) => x.c.sku).join(', ')}` : '')
  return { match: { sku: best.c.sku, variantId: best.c.variantId, confidence: best.conf, lineRelation: best.rel, why }, variant: best.c, weak: null }
}
