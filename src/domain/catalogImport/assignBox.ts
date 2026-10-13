/**
 * Caixa de cada produto (tabela de caixas). Ordem das regras (porta de scripts/d-proposal.js com as
 * decisões de 13/10/2026 e as correções da verificação):
 *   1. regra explícita da planilha (linha + medida + faixa de peso), preferindo a faixa estrita;
 *   2. a tara oficial (bruto − líquido) igual à tara de uma caixa da linha;
 *   3. a caixa que o equivalente do catálogo atual já usa (se as medidas existem na planilha) — menos nas
 *      lonas BigSafe / Big Silo 16–28 × 50 m, em que a fila da linha irmã vem antes (decisão 12);
 *   4. faixa de peso da linha / linhas irmãs.
 * ALTA ou MÉDIA → caixa atribuída; senão o produto entra sem embalagem (pendente, com sugestão).
 * Embalagens PROVISÓRIAS do catálogo atual (match.isPlaceholderPack) nunca contam como evidência.
 */
import { boxDimsText } from './boxSheet'
import type { OfficialProduct } from './classify'
import type { ImportDecisions } from './decisions'
import { isPlaceholderPack } from './match'
import { round } from './parseProduct'
import type { BoxLine, BoxModel, CurrentPack, CurrentVariant, PendingReason } from './types'
import { grossProblem, officialTare } from './weights'

export type BoxAssignment =
  | { status: 'ASSIGNED'; source: 'SHEET'; box: BoxModel; confidence: 'HIGH' | 'MEDIUM'; reason: string; notes: string[] }
  | { status: 'ASSIGNED'; source: 'CURRENT_CATALOG'; pack: CurrentPack; fromSku: string; confidence: 'MEDIUM'; reason: string; notes: string[] }
  | { status: 'PENDING'; reasonCode: PendingReason; reason: string; suggestion: BoxModel | null; unitsPerPackHint: number | null; notes: string[] }

export interface AssignContext {
  d: ImportDecisions
  boxes: BoxModel[]
  /**
   * Coluna N digitada (≠ K+L+M) por linha da tabela de caixas: os brutos oficiais às vezes foram
   * calculados com ela (69491: 6,7 kg), então a tara oficial também "bate" com esse valor.
   */
  sheetTotalByRow?: Map<number, number>
}

const near = (a: number | null | undefined, b: number | null | undefined, t: number) => a != null && b != null && Math.abs(a - b) <= t
const kg = (x: number) => String(round(x, 3)).replace('.', ',')
const n2 = (x: number | null) => (x == null ? '—' : String(round(x, 3)).replace('.', ','))
const dimsKey = (l: number, w: number, h: number) => `${Math.max(l, w)}x${Math.min(l, w)}x${h}`
const boxKey = (b: BoxModel) => dimsKey(b.lengthMm, b.widthMm, b.heightMm)
const packKey = (p: CurrentPack) => dimsKey(p.lengthMm, p.widthMm, p.heightMm)
const packDims = (p: CurrentPack) => `${Math.max(p.lengthMm, p.widthMm)}×${Math.min(p.lengthMm, p.widthMm)}×${p.heightMm}`
export const boxLabel = (b: BoxModel) => `${b.code} (${boxDimsText(b)}, tabela de caixas linha ${b.sheetRow}: "${b.reference.replace(/\s+/g, ' ').trim()}")`

const assigned = (box: BoxModel, confidence: 'HIGH' | 'MEDIUM', reason: string, notes: string[]): BoxAssignment => ({ status: 'ASSIGNED', source: 'SHEET', box, confidence, reason, notes })
const pending = (reasonCode: PendingReason, reason: string, suggestion: BoxModel | null, notes: string[] = [], unitsPerPackHint: number | null = null): BoxAssignment => ({
  status: 'PENDING',
  reasonCode,
  reason,
  suggestion,
  unitsPerPackHint,
  notes,
})

/** Caixa por código (de preferência da família do produto). */
export function boxByCode(boxes: BoxModel[], code: string, family?: BoxModel['family']): BoxModel | null {
  const all = boxes.filter((b) => b.code === code && b.recognized)
  return all.find((b) => b.family === family) ?? all[0] ?? boxes.find((b) => b.code === code) ?? null
}

/** Faixa de peso: com tolerância (1 kg / 2 %) e estrita. Fila sem faixa → sempre dentro. */
function ranges(net: number, d: ImportDecisions) {
  const tolOf = (max: number) => Math.max(d.weightTolKg, max * d.weightTolPct)
  return {
    inRange: (b: BoxModel) => b.netKgMax == null || (net >= (b.netKgMin ?? 0) - d.weightTolKg && net <= b.netKgMax + tolOf(b.netKgMax)),
    strictIn: (b: BoxModel) => b.netKgMax == null || (net >= (b.netKgMin ?? 0) && net <= b.netKgMax),
    midDist: (b: BoxModel) => (b.netKgMax == null ? 0 : Math.abs(net - ((b.netKgMin ?? 0) + b.netKgMax) / 2)),
  }
}

function tareMatcher(p: OfficialProduct, ctx: AssignContext) {
  const { d } = ctx
  const tare = officialTare(p)
  const usable = tare != null && !grossProblem(p, d)
  return (b: BoxModel) => {
    if (!usable) return false
    if (Math.abs(tare! - b.tareKg) <= d.tareMatchTolKg) return true
    const alt = ctx.sheetTotalByRow?.get(b.sheetRow)
    return alt != null && Math.abs(tare! - alt) <= d.tareMatchTolKg
  }
}

/** Faixa estrita primeiro: a tolerância só vale quando nenhuma fila contém o peso de verdade. */
function strictFirst(rows: BoxModel[], strict: (b: BoxModel) => boolean): BoxModel[] {
  const s = rows.filter(strict)
  return s.length ? s : rows
}

/** Entre caixas de mesmas medidas, a da linha do produto, depois linha irmã, depois a família. */
function preferred(same: BoxModel[], family: BoxModel['family'], prim: BoxLine[], sec: BoxLine[]): BoxModel {
  return (
    same.find((b) => b.family === family && b.line != null && prim.includes(b.line)) ??
    same.find((b) => b.family === family && b.line != null && sec.includes(b.line)) ??
    same.find((b) => b.family === family) ??
    same[0]
  )
}

/** Evidência do catálogo atual: a embalagem do equivalente, se não é provisória. */
function currentEvidence(cur: CurrentVariant | null, d: ImportDecisions): CurrentVariant | null {
  return cur && cur.pack && !isPlaceholderPack(cur, d) ? cur : null
}

// ---------------------------------------------------------------- silo-bolsa
function assignSiloBag(p: OfficialProduct, cur: CurrentVariant | null, ctx: AssignContext): BoxAssignment {
  const { d } = ctx
  const net = p.netKg!
  const spec = d.lines[p.lineKey]
  const all = ctx.boxes.filter((b) => b.recognized && b.code && b.family === 'SILO_BAG')
  const ev = currentEvidence(cur, d)
  const curKey = ev ? packKey(ev.pack!) : null
  const changeNote = (b: BoxModel) => (ev && curKey !== boxKey(b) ? [`caixa muda (atual ${packDims(ev.pack!)} em ${ev.sku})`] : [])
  const { inRange, strictIn, midDist } = ranges(net, d)
  const tareMatch = tareMatcher(p, ctx)
  const sizeTxt = `${n2(p.diameterFt)} pés × ${p.lengthFt != null ? `${n2(p.lengthFt)} pés` : `${n2(p.lengthM)} m`}`

  // 1. regras do dono (ex.: Pacifil 9/10 × 100 m = caixa do Probag)
  for (const rule of d.siloBagRules) {
    if (rule.line !== p.lineKey || !rule.diametersFt.some((x) => near(x, p.diameterFt, 0.01)) || !near(p.lengthM, rule.lengthM, rule.lenTolM)) continue
    if (net < rule.minNetKg || net > rule.maxNetKg) continue
    const b = boxByCode(ctx.boxes, rule.box, 'SILO_BAG')
    if (b) return assigned(b, 'HIGH', rule.reason, changeNote(b))
  }
  // 2. lacuna da tabela (61–99 kg): pendente com sugestão (decisão: todas as silo-bolsas desse peso)
  if (net > d.siloBagGap.aboveKg && net < d.siloBagGap.belowKg)
    return pending('SILO_BAG_WEIGHT_GAP', `silo-bolsa de ${kg(net)} kg: a tabela de caixas não tem faixa entre ${d.siloBagGap.aboveKg} e ${d.siloBagGap.belowKg} kg`, boxByCode(ctx.boxes, d.siloBagGap.suggestion, 'SILO_BAG'))

  const lenEq = (m: BoxModel['measures'][number]) => (m.lenM == null && m.lenFt == null) || (p.lengthFt != null && m.lenFt != null ? near(p.lengthFt, m.lenFt, 1) : near(p.lengthM, m.lenM, 1))
  const listed = (b: BoxModel) => b.measures.some((m) => near(m.d, p.diameterFt, 0.01) && lenEq(m))
  const lengthListed = (b: BoxModel) => b.measures.some((m) => near(m.d, p.diameterFt, 0.01) && (m.lenM != null || m.lenFt != null) && lenEq(m))
  const sameD = (b: BoxModel) => b.measures.some((m) => near(m.d, p.diameterFt, 0.01))
  const lineRows = all.filter((b) => b.line != null && spec.boxLines.includes(b.line))
  const W = strictFirst(
    lineRows.filter((b) => inRange(b) && !listed(b)),
    strictIn,
  )
  const M = lineRows.filter((b) => listed(b) && !inRange(b))

  // 3. regra explícita: faixa estrita primeiro; depois comprimento listado; depois o meio da faixa
  const eStrict = lineRows.filter((b) => listed(b) && strictIn(b))
  const E = (eStrict.length ? eStrict : lineRows.filter((b) => listed(b) && inRange(b))).sort((a, b) => Number(lengthListed(b)) - Number(lengthListed(a)) || midDist(a) - midDist(b))
  if (E.length) {
    const b = E[0]
    const strict = eStrict.length > 0
    return assigned(
      b,
      strict ? 'HIGH' : 'MEDIUM',
      `regra da tabela de caixas: linha ${b.line}, ${sizeTxt} ${lengthListed(b) ? 'listado' : `(fila só pelo diâmetro: "${b.reference}")`}, líquido ${kg(net)} kg ${strict ? 'na faixa' : 'no limite da faixa'} "${b.rangeText ?? ''}"`,
      changeNote(b),
    )
  }
  // 4. tara oficial = tara de uma caixa da linha
  const T = lineRows.filter(tareMatch)
  if (T.length) {
    const b = T.find(inRange) ?? T.find((x) => curKey === boxKey(x)) ?? T[0]
    const curEq = curKey === boxKey(b)
    const notes = changeNote(b)
    if (T.length > 1) notes.push(`mesma tara: ${T.filter((x) => x !== b).map((x) => x.code).join('/')}`)
    return assigned(b, inRange(b) || curEq ? 'HIGH' : 'MEDIUM', `a tara oficial (bruto − líquido = ${kg(officialTare(p)!)} kg) é a da caixa ${boxLabel(b)}${inRange(b) ? ' e o líquido está na faixa' : ` (faixa "${b.rangeText ?? ''}"; a medida não está na fila)`}`, notes)
  }
  // 5. caixa do equivalente atual
  if (curKey) {
    const same = ctx.boxes.filter((b) => b.recognized && b.code && boxKey(b) === curKey)
    if (same.length) {
      const b = preferred(same, 'SILO_BAG', spec.boxLines, spec.secondaryBoxLines)
      const consistent = W.includes(b) || M.includes(b)
      return assigned(b, consistent || tareMatch(b) ? 'HIGH' : 'MEDIUM', `caixa que o equivalente atual ${ev!.sku} já usa (${packDims(ev!.pack!)} = ${b.code}${b.line && !spec.boxLines.includes(b.line) ? `, caixa da linha ${b.line}` : ''})${consistent ? '; coerente com a faixa de peso da linha' : ''}`, [])
    }
  }
  // 6. faixa de peso da linha (medida não listada): a coluna B da tabela é a referência de peso das bolsas
  if (W.length) {
    const keys = new Set(W.map(boxKey))
    const b = keys.size > 1 ? (W.find(sameD) ?? W.find(tareMatch) ?? null) : W[0]
    if (b) return assigned(b, tareMatch(b) ? 'HIGH' : 'MEDIUM', `faixa de peso da linha ${b.line} ("${b.rangeText ?? ''}"); ${sizeTxt} não está na fila "${b.reference}"`, changeNote(b))
    return pending('AMBIGUOUS', `várias caixas da linha servem para ${kg(net)} kg: ${W.map(boxLabel).join(' / ')}`, W[0])
  }
  // 7. a caixa da própria medida, para um produto mais leve que a faixa dela
  if (M.length) {
    const b = M[0]
    if (b.netKgMin != null && net < b.netKgMin) return assigned(b, 'MEDIUM', `mesma linha e medida (${b.code}); líquido ${kg(net)} kg abaixo da faixa "${b.rangeText ?? ''}"`, changeNote(b))
    return pending('NO_BOX_RULE', `mesma linha e medida (${b.code}), mas o líquido ${kg(net)} kg passa da faixa "${b.rangeText ?? ''}"`, b)
  }
  // 8. caixa de outra linha (sem impressão / Bridon…) com a mesma medida e peso. Linha IRMÃ declarada (Probag /
  //    Ecobag → STD) com a medida listada e o líquido na faixa estrita vale mesmo sem a tara (decisão 11: 5–6 pés
  //    = 52185; um bruto oficial ruim não é evidência contra a caixa — decisão 7). As outras linhas (sem
  //    impressão, Bridon) continuam exigindo a tara oficial.
  const X = all.filter((b) => b.line != null && !spec.boxLines.includes(b.line) && inRange(b) && listed(b)).sort((a, b) => Number(spec.secondaryBoxLines.includes(b.line!)) - Number(spec.secondaryBoxLines.includes(a.line!)))
  if (X.length) {
    const xt = X.find(tareMatch)
    const xs = X.find((b) => spec.secondaryBoxLines.includes(b.line!) && strictIn(b))
    const b = xt ?? xs ?? X[0]
    const why = `a linha ${spec.boxLines.join('/')} não tem caixa para ${sizeTxt} / ${kg(net)} kg; caixa da linha ${b.line}: ${boxLabel(b)}`
    if (xt) return assigned(b, 'MEDIUM', `${why} (a tara oficial coincide)`, changeNote(b))
    if (xs) return assigned(b, 'MEDIUM', `${why} (linha irmã declarada: medida listada e líquido na faixa "${b.rangeText ?? ''}")`, changeNote(b))
    return pending('NO_BOX_RULE', why, b)
  }
  const larger = lineRows.filter((b) => b.netKgMin != null && b.netKgMin >= net).sort((a, b) => a.netKgMin! - b.netKgMin!)[0] ?? null
  const tm = all.find(tareMatch) ?? null
  const sug = tm ?? larger
  if (tm) return assigned(tm, 'MEDIUM', `a tabela não tem caixa para silo-bolsa de ${kg(net)} kg; a tara oficial coincide com ${boxLabel(tm)}`, changeNote(tm))
  return pending('NO_BOX_RULE', `a tabela de caixas não tem caixa para silo-bolsa ${spec.boxLines.join('/')} de ${kg(net)} kg${net > 450 ? ' (mais de 450 kg)' : ''}`, sug)
}

// ---------------------------------------------------------------- lonas
function assignTarp(p: OfficialProduct, cur: CurrentVariant | null, ctx: AssignContext): BoxAssignment {
  const { d } = ctx
  const net = p.netKg!
  const spec = d.lines[p.lineKey]
  const PRIM = spec.boxLines
  const SEC = spec.secondaryBoxLines
  const all = ctx.boxes.filter((b) => b.recognized && b.code && b.family === 'SILAGE_TARP')
  const ev = currentEvidence(cur, d)
  const curKey = ev ? packKey(ev.pack!) : null
  const changeNote = (b: BoxModel) => (ev && curKey !== boxKey(b) ? [`caixa muda (atual ${packDims(ev.pack!)} em ${ev.sku})`] : [])
  const { inRange, strictIn, midDist } = ranges(net, d)
  const tareMatch = tareMatcher(p, ctx)
  const big = (b: BoxModel) => b.ignoreWeightRange
  const br = d.bigTarpRule
  const bigFits = p.widthM != null && p.widthM >= br.minWidthM && p.widthM <= br.maxWidthM && p.lengthM != null && p.lengthM <= br.maxLengthM && p.thicknessUm != null && p.thicknessUm <= br.maxThicknessUm
  const weightOk = (b: BoxModel) => (big(b) ? bigFits : inRange(b))
  const weightStrict = (b: BoxModel) => (big(b) ? bigFits : strictIn(b))
  const listed = (b: BoxModel) => b.measures.some((m) => near(m.w, p.widthM, 0.01) && near(m.lenM, p.lengthM, 0.5))
  const sizeTxt = `${n2(p.widthM)} × ${n2(p.lengthM)} m`
  const bigLine = PRIM.some((l) => l === 'BIGSAFE' || l === 'BIGSILO')
  const notEsp = (b: BoxModel) => b.line !== 'ESP' && b.line !== 'ESP-EUA' && b.line !== 'SI'
  const inLines = (lines: BoxLine[]) => (b: BoxModel) => b.line != null && lines.includes(b.line)

  if (p.unitsPerPack) return pending('PACK_UNITS', `pacote "${p.measure}" (c/${p.unitsPerPack}): caixa e unidades por caixa não estão na tabela`, null, [], p.unitsPerPack)

  // medidas especiais (independem da linha)
  const special: BoxModel[] = []
  for (const b of all) {
    if (b.line === 'ESP' && listed(b) && (!b.thicknessUm || b.thicknessUm.some((t) => near(p.thicknessUm, t, 2)))) special.push(b)
    if (b.line === 'ESP-EUA' && b.measures.some((m) => near(m.w, p.widthM, 0.3) && near(m.lenM, p.lengthM, 0.5))) special.push(b)
  }
  const eStrict = all.filter((b) => inLines(PRIM)(b) && listed(b) && weightStrict(b))
  const E = (eStrict.length ? eStrict : all.filter((b) => inLines(PRIM)(b) && listed(b) && weightOk(b))).sort((a, b) => midDist(a) - midDist(b))
  const notes: string[] = []
  if (special.length && bigLine && E.length) {
    notes.push(`alternativa: medida especial ${boxLabel(special[0])}`)
    special.length = 0
  }
  if (special.length) {
    const b = special[0]
    const n = [...notes, ...changeNote(b)]
    const conflict = ev && curKey !== boxKey(b)
    return assigned(b, conflict && !tareMatch(b) ? 'MEDIUM' : 'HIGH', `medida especial da tabela de caixas ("${b.reference}")${b.line === 'ESP-EUA' ? `; ${p.measure} = ${sizeTxt}` : ''}`, n)
  }
  if (E.length) {
    const b = E[0]
    const strict = eStrict.length > 0
    const n = [...notes, ...changeNote(b)]
    let conf: 'HIGH' | 'MEDIUM' = strict ? 'HIGH' : 'MEDIUM'
    const conflict = !!ev && curKey !== boxKey(b)
    // decisão 12: BigSafe / Big Silo 16–28 × 50 m nas caixas da planilha, mesmo que o catálogo use outra
    if (conflict && !big(b) && !tareMatch(b)) conf = 'MEDIUM'
    return assigned(
      b,
      conf,
      `regra da tabela de caixas: linha ${b.line}, ${sizeTxt} listado${big(b) ? ` (faixa "${b.rangeText ?? ''}" da planilha não vale para estas lonas — decisão de 13/10/2026)` : `, líquido ${kg(net)} kg ${strict ? 'na faixa' : 'no limite da faixa'} "${b.rangeText ?? ''}"`}`,
      n,
    )
  }
  const E2 = strictFirst(
    all.filter((b) => inLines(SEC)(b) && listed(b) && weightOk(b)),
    weightStrict,
  ).sort((a, b) => SEC.indexOf(a.line!) - SEC.indexOf(b.line!))
  const e2Step = () => {
    if (!E2.length) return null
    const keys = new Set(E2.map(boxKey))
    const b = E2.find(tareMatch) ?? E2[0]
    const why = `medida e peso da fila ${b.line} (${boxLabel(b)}): a linha ${spec.productLine} não tem fila própria para ${sizeTxt}${/PLUS X3/.test(spec.namePrefix) ? '; a versão Plus X3 pesa como a versão base' : ''}`
    return keys.size === 1 || tareMatch(b) ? assigned(b, 'MEDIUM', why, [...notes, ...changeNote(b)]) : pending('AMBIGUOUS', `${why}; outras: ${E2.filter((x) => x !== b).map(boxLabel).join(' / ')}`, b)
  }
  // decisão 12: BigSafe / Big Silo 16–28 × 50 m (até 125 µm) nas caixas da planilha, mesmo que o catálogo use
  // outra — a fila da linha irmã (Big Silo 18 × 50 → fila BigSafe "16-18-20X50") vem ANTES da caixa do
  // equivalente atual (que pode ser uma "Lona medida especial" com outra caixa e outro palete)
  if (bigLine && bigFits) {
    const r = e2Step()
    if (r?.status === 'ASSIGNED') return r
  }
  if (curKey) {
    const same = ctx.boxes.filter((b) => b.recognized && b.code && boxKey(b) === curKey)
    if (same.length) {
      const b = preferred(same, 'SILAGE_TARP', PRIM, SEC)
      const lineOk = b.line != null && (PRIM.includes(b.line) || SEC.includes(b.line))
      return assigned(b, lineOk && (listed(b) || weightOk(b)) ? 'HIGH' : 'MEDIUM', `caixa que o equivalente atual ${ev!.sku} já usa (${packDims(ev!.pack!)} = ${b.code}${b.family !== 'SILAGE_TARP' ? ', caixa de outra família' : b.line && !PRIM.includes(b.line) ? `, fila da linha ${b.line}` : ''})`, notes)
    }
  }
  const W = strictFirst(
    all.filter((b) => inLines(PRIM)(b) && weightOk(b) && !listed(b)),
    weightStrict,
  )
  const M = all.filter((b) => inLines(PRIM)(b) && listed(b) && !weightOk(b))
  const steps: (() => BoxAssignment | null)[] = []
  const mLight = M.find((b) => b.netKgMin != null && net < b.netKgMin)
  const mStep = () => (mLight ? assigned(mLight, 'MEDIUM', `mesma linha e medida (${boxLabel(mLight)}); líquido ${kg(net)} kg abaixo da faixa "${mLight.rangeText ?? ''}"`, [...notes, ...changeNote(mLight)]) : null)
  const wStep = () => {
    if (!W.length) return null
    const keys = new Set(W.map(boxKey))
    const b = W.find(tareMatch) ?? (keys.size === 1 ? W[0] : null)
    if (!b) {
      const narrow = [...W].sort((x, y) => ((x.netKgMax ?? 999) - (x.netKgMin ?? 0)) - ((y.netKgMax ?? 999) - (y.netKgMin ?? 0)))
      return pending('AMBIGUOUS', `${sizeTxt} não está na tabela; várias caixas possíveis pelo peso: ${W.map(boxLabel).join(' / ')}`, narrow[0])
    }
    return assigned(
      b,
      'MEDIUM',
      big(b) ? `linha ${b.line}: ${sizeTxt} não está na fila (lista ${b.measures.map((m) => `${m.w}×${m.lenM}`).join(', ')})` : `faixa de peso da linha ${b.line} ("${b.rangeText ?? ''}"); ${sizeTxt} não está na fila${tareMatch(b) ? ' (a tara oficial coincide)' : ''}`,
      [...notes, ...changeNote(b)],
    )
  }
  steps.push(...(bigLine ? [e2Step, wStep, mStep] : [e2Step, mStep, wStep]))
  for (const s of steps) {
    const r = s()
    if (r) return r
  }
  // nada serve: pendente com a melhor sugestão
  const over = net > 100
  const code: PendingReason = over ? 'TARP_OVER_100KG' : bigLine ? 'BIGSAFE_SIZE' : 'NO_BOX_RULE'
  // sugestão pelo peso (caixa de lona cuja faixa contém o líquido; de preferência BPF e faixa estreita)
  const byWeight =
    all
      .filter((b) => notEsp(b) && !big(b) && strictIn(b) && b.netKgMax != null)
      .sort((a, b) => Number(b.line === 'BPF') - Number(a.line === 'BPF') || a.netKgMax! - (a.netKgMin ?? 0) - (b.netKgMax! - (b.netKgMin ?? 0)))[0] ?? null
  if (M.length) {
    const b = M[0]
    return pending(code, `mesma linha e medida (${b.code}), mas o líquido ${kg(net)} kg está fora da faixa da caixa${big(b) ? ' (fila pensada para 16–28 × 50 m até 125 µm)' : ` ("${b.rangeText ?? ''}")`}`, byWeight ?? b)
  }
  const X = all.filter((b) => !inLines(PRIM)(b) && !inLines(SEC)(b) && notEsp(b) && listed(b) && weightOk(b))
  if (X.length) {
    const pref = X.find(tareMatch) ?? X.find((b) => b.line === 'BPF') ?? X[0]
    return pending(code, `a linha ${spec.productLine} não tem fila na tabela; pela medida e peso serviria ${X.map(boxLabel).join(' / ')}`, pref)
  }
  return pending(code, `a tabela de caixas não tem caixa para ${spec.productLine} ${sizeTxt} de ${kg(net)} kg${over ? ' (não há caixa de lona de mais de 100 kg fora de BigSafe / Big Silo 16–28 × 50 m)' : ''}`, byWeight)
}

// ---------------------------------------------------------------- Hidrosilo / Hidroforce
function assignWaterTank(p: OfficialProduct, cur: CurrentVariant | null, ctx: AssignContext): BoxAssignment {
  const { d } = ctx
  const net = p.netKg!
  const HS = ctx.boxes.filter((b) => b.recognized && b.code && b.family === 'HIDROSILO' && b.line === 'HS')
  const maxOf = (b: BoxModel) => d.hsDesignatedMaxKg[b.code!] ?? Infinity
  if (p.unitsPerPack) return pending('PACK_UNITS', `pacote "${p.measure}" (c/${p.unitsPerPack}): a tabela não tem caixa para pacotes; unidades por caixa a definir`, null, [], p.unitsPerPack)
  const ev = currentEvidence(cur, d)
  const tareMatch = tareMatcher(p, ctx)
  const sizeTxt = `${n2(p.widthM)} × ${n2(p.lengthM)} m`

  // decisão 15: Hidrosilo 3 m fica na caixa atual do catálogo, a não ser que a tabela tenha fila para 3 m
  if (d.hidrosilo3m === 'KEEP_CURRENT_BOX_UNLESS_SHEET_ROW' && near(p.widthM, 3, 0.01)) {
    const sheet3m = HS.filter((b) => b.measures.some((m) => near(m.w, 3, 0.01)))
    if (!sheet3m.length) {
      const pk = cur?.pack ?? null
      if (pk) return { status: 'ASSIGNED', source: 'CURRENT_CATALOG', pack: pk, fromSku: cur!.sku, confidence: 'MEDIUM', reason: 'Hidrosilo 3 m: caixa atual do catálogo (não está na tabela de caixas)', notes: [`caixa de ${cur!.sku}: ${packDims(pk)}`] }
      const byW = HS.filter((x) => maxOf(x) * 1.05 >= net).sort((a, b) => maxOf(a) - maxOf(b))[0] ?? null
      return pending('NO_BOX_RULE', `Hidrosilo 3 m sem equivalente no catálogo atual e sem fila na tabela de caixas${byW ? '; sugestão pelo peso' : ''}`, byW)
    }
    const b = sheet3m.filter((x) => maxOf(x) * 1.05 >= net).sort((a, c) => maxOf(a) - maxOf(c))[0]
    if (b) return assigned(b, 'MEDIUM', `Hidrosilo 3 m: fila da tabela escolhida pelo peso (${kg(net)} kg)`, [])
  }

  const byCap = p.capacityL != null ? HS.find((b) => b.measures.some((m) => m.capacityL === p.capacityL && (m.lenM == null || near(m.lenM, p.lengthM, 0.05)))) : undefined
  const byLen = HS.find((b) => b.measures.some((m) => m.lenM != null && near(m.lenM, p.lengthM, 0.05)))
  let r: BoxModel | null = byLen ?? (byCap && (p.lengthM == null || p.lengthM <= 3) ? byCap : null)
  let how: string
  let conf: 'HIGH' | 'MEDIUM' | 'LOW'
  if (r) {
    how = byLen ? `comprimento ${n2(p.lengthM)} m na tabela de Hidrosilo ("${r.reference}")` : `capacidade ${p.capacityL} L na tabela ("${r.reference}")`
  } else if (p.lengthM != null && p.lengthM <= 3 && (p.capacityL == null || p.capacityL <= 2000)) {
    r = HS.find((x) => x.measures.some((m) => m.capacityL != null && m.capacityL <= 2000 && m.lenM == null)) ?? null
    how = `peça de ${n2(p.lengthM)} m${p.capacityL ? ` / ${p.capacityL} L` : ''}: a fila "500, 1.000 e 2.000 litros" é a única para até 3 m`
  } else how = ''
  const twoM600 = near(p.widthM, 2, 0.01) && p.thicknessUm === 600 && !p.valves && !p.imperial
  if (r) {
    const fits = net <= maxOf(r) * 1.05
    conf = fits && byLen === r && twoM600 ? 'HIGH' : 'MEDIUM'
    if (!fits) {
      conf = 'LOW'
      how += `; mas o líquido ${kg(net)} kg passa do Hidrosilo de referência dessa caixa (${kg(maxOf(r))} kg)`
    }
  } else {
    const byW = HS.filter((x) => maxOf(x) * 1.05 >= net).sort((a, b) => maxOf(a) - maxOf(b))[0] ?? null
    r = byW
    conf = r ? 'MEDIUM' : 'LOW'
    how = r ? `${n2(p.lengthM)} m não está na tabela; pelo peso equivalente (${kg(net)} kg ≤ ${kg(maxOf(r))} kg do Hidrosilo 2 m dessa caixa)` : 'nenhuma caixa da tabela comporta este peso'
  }
  if (p.imperial) how += ` (medida em pés: ${p.measure} ≈ ${sizeTxt})`
  if (p.widthBasis === 'FILM_WIDTH') how += `; largura lida como filme aberto (${n2(p.filmWidthM)} m → ${n2(p.widthM)} m plano)`
  if (!twoM600 && !near(p.widthM, 2, 0.01)) how += `; largura plana ${n2(p.widthM)} m (a tabela é pensada para 2 m)`
  const notes: string[] = []
  if (r && ev && packKey(ev.pack!) !== boxKey(r)) {
    const curRows = ctx.boxes.filter((b) => b.recognized && boxKey(b) === packKey(ev.pack!))
    notes.push(`caixa muda (atual ${packDims(ev.pack!)} em ${ev.sku}${curRows.length ? ` = ${[...new Set(curRows.map((x) => x.code))].join('/')}` : ', fora da tabela'})`)
    if (conf === 'HIGH') conf = 'MEDIUM'
    if (!curRows.length) conf = 'LOW'
  }
  if (r && !tareMatch(r)) {
    const old = ctx.boxes.filter((x) => x.family === 'HIDROSILO' && x.recognized && tareMatch(x) && boxKey(x) !== boxKey(r!))
    if (old.length) notes.push(`bruto oficial = líquido + ${kg(officialTare(p)!)} kg = tara de ${[...new Set(old.map((x) => x.code + (x.line === 'HS-OLD' ? ' (tabela antiga)' : '')))].join('/')}`)
  }
  if (!r || conf === 'LOW') return pending(r ? 'NO_BOX_RULE' : 'OTHER', how, r, notes)
  return assigned(r, conf, how, notes)
}

/** Caixa do produto (antes das correções por código). */
export function assignBox(p: OfficialProduct, cur: CurrentVariant | null, ctx: AssignContext): BoxAssignment {
  if (p.netKg == null || p.netKg <= 0) return pending('NO_NET_WEIGHT', 'sem peso líquido na planilha', null)
  switch (p.family) {
    case 'SILO_BAG':
      return assignSiloBag(p, cur, ctx)
    case 'SILAGE_TARP':
      return assignTarp(p, cur, ctx)
    case 'HIDROSILO':
    case 'HYDROFORCE':
      return assignWaterTank(p, cur, ctx)
    case 'FILM_ROLL':
      return pending('FILM', `filme fino em rolo (${p.thicknessUm ?? '—'} µm, ${n2(p.widthM)} × ${n2(p.lengthM)} m): a tabela de caixas não tem caixa para filmes`, null)
    case 'HIDROPESO':
      return pending('HIDROPESO', 'Hidropeso: a tabela de caixas não o inclui', null)
    case 'SILAGE_BAG':
      return pending('SILAGE_BAG', `bolsa para silagem em caixa coletiva${p.unitsPerPack ? ` (c/${p.unitsPerPack})` : ''}: a tabela de caixas não tem estas caixas`, null, [], p.unitsPerPack)
    default:
      return pending('ACCESSORY', `acessório (fita / caixa de fitas / adesivo): a tabela de caixas não o inclui`, null, [], p.unitsPerPack)
  }
}

/** Correções por código (verificação V.2), aplicadas por último. */
export function applyCodeOverride(p: OfficialProduct, a: BoxAssignment, ctx: AssignContext): BoxAssignment {
  const ov = ctx.d.codeOverrides[p.code]
  if (!ov) return a
  const fam = p.family === 'SILO_BAG' ? 'SILO_BAG' : p.family === 'SILAGE_TARP' ? 'SILAGE_TARP' : p.family === 'HIDROSILO' || p.family === 'HYDROFORCE' ? 'HIDROSILO' : null
  if (ov.box) {
    const b = boxByCode(ctx.boxes, ov.box, fam)
    if (b) return assigned(b, ov.confidence ?? 'MEDIUM', ov.reason ?? `caixa ${ov.box} por correção manual`, a.notes)
  }
  if (ov.suggestion && a.status === 'PENDING') {
    const b = boxByCode(ctx.boxes, ov.suggestion, fam)
    if (b) return { ...a, suggestion: b, reason: `${a.reason} — sugerida ${boxLabel(b)} pela verificação` }
  }
  return a
}
