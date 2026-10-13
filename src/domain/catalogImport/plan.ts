/**
 * PLANO DA IMPORTAÇÃO (prévia): planilha de produtos + tabela de caixas + catálogo atual → o que será
 * criado / atualizado / desativado, com caixa, pesos, palete, nome e atributos de cada produto.
 * Puro: o servidor (src/lib/catalogImport) lê as planilhas, carrega o catálogo, grava a prévia e aplica.
 *
 * Passos: ler e classificar → descartar repetidos → para cada produto: equivalente atual, capacidade,
 * caixa, pesos, palete, nome, atributos → famílias e linhas → desativações → avisos → resumo.
 */
import { REFERENCE_PALLET_MAX_HEIGHT_MM } from '@/domain/logisticsRules'
import { isRuleLona, lonaWidthM } from '@/domain/lonaRule'
import { applyCodeOverride, assignBox, type BoxAssignment } from './assignBox'
import { boxDimsText, buildBoxModels } from './boxSheet'
import { classifyRow, type OfficialProduct } from './classify'
import { DEFAULT_DECISIONS, type ImportDecisions } from './decisions'
import { dedupe, sameSizeDifferentText } from './duplicates'
import { matchProduct } from './match'
import { productName } from './names'
import { plannedPallet } from './pallet'
import { FT_M, round } from './parseProduct'
import {
  ENGINE_VERSION,
  type BuildPlanInput,
  type CurrentVariant,
  type Deactivation,
  type FamilyChange,
  type FamilyKey,
  type ImportPlan,
  type LineChange,
  type Pending,
  type PlannedPackaging,
  type PlannedProduct,
  type PlanWarning,
  type Summary,
} from './types'
import { plannedWeights } from './weights'

const ALL_ORIENTATIONS: PlannedPackaging['allowedOrientations'] = ['LWH', 'WLH', 'LHW', 'HLW', 'WHL', 'HWL']
const near = (a: number | null | undefined, b: number | null | undefined, t: number) => a != null && b != null && Math.abs(a - b) <= t
const isWaterTank = (p: OfficialProduct) => p.family === 'HIDROSILO' || p.family === 'HYDROFORCE'
const numAttr = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null)
const dimsKey = (l: number, w: number, h: number) => `${Math.max(l, w)}x${Math.min(l, w)}x${h}`
/** lista curta de códigos para mensagens */
const codeList = (codes: string[], max = 12) => (codes.length > max ? `${codes.slice(0, max).join(', ')}… (+${codes.length - max})` : codes.join(', '))

/** Capacidade do reservatório: da medida; senão do equivalente atual; senão única entre as linhas oficiais da mesma medida. */
function fillCapacity(p: OfficialProduct, cur: CurrentVariant | null, waterTanks: OfficialProduct[]) {
  if (!isWaterTank(p) || p.capacityL != null || p.unitsPerPack) return
  const fromMatch = cur ? numAttr(cur.attrs?.capacidade_l) : null
  if (fromMatch != null && fromMatch > 0) {
    p.capacityL = fromMatch
    p.capacitySource = 'MATCH'
    p.notes.push(`capacidade ${fromMatch} L do equivalente atual ${cur!.sku} (a planilha não informa)`)
    return
  }
  const caps = new Set(waterTanks.filter((x) => x !== p && x.capacitySource === 'MEASURE' && x.capacityL != null && near(x.widthM, p.widthM, 0.01) && near(x.lengthM, p.lengthM, 0.05)).map((x) => x.capacityL!))
  if (caps.size === 1) {
    const c = [...caps][0]
    p.capacityL = c
    p.capacitySource = 'SIBLING'
    p.notes.push(`capacidade ${c} L de outra linha oficial com a mesma medida (a planilha não informa nesta)`)
  }
}

function buildAttrs(p: OfficialProduct, cur: CurrentVariant | null, exact: boolean, a: BoxAssignment, d: ImportDecisions): Record<string, string | number | null> {
  const at: Record<string, string | number | null> = {
    tipo: p.kind,
    linha: p.lineKey,
    grupo_planilha: p.group,
    medida_planilha: p.measure,
  }
  if (p.thicknessText) at.espessura_planilha = p.thicknessText
  if (p.family === 'SILAGE_TARP' || p.family === 'FILM_ROLL') at.formato = 'rolo'
  at.silo_bolsa = p.family === 'SILO_BAG' ? 1 : 0
  const ca = cur?.attrs ?? {}
  if (p.family === 'SILO_BAG' && p.diameterFt) {
    at.diametro_m = numAttr(ca.diametro_m) ?? round(p.diameterFt * FT_M, 3)
    at.perimetro_m = numAttr(ca.perimetro_m) ?? round(Math.PI * p.diameterFt * FT_M, 3)
    const t = numAttr(ca.capacidade_t)
    if (t != null) at.capacidade_t = t
  }
  if (isWaterTank(p)) {
    if (p.capacityL != null) at.capacidade_l = p.capacityL
    if (p.filmWidthM != null) at.largura_filme_m = p.filmWidthM
  }
  if (p.valves) at.valvulas = p.valves
  if (p.tags.length) at.acabamento = p.tags.map((t) => t.toLowerCase().replace(/^media$/, 'média')).join(', ')
  if (p.color) at.cor = p.color.toLowerCase()
  if (p.unitsPerPack) at.unidades_por_caixa = p.unitsPerPack
  if (a.status === 'ASSIGNED' && a.source === 'SHEET' && a.box.code) at.codigo_caixa = a.box.code
  if (a.status === 'PENDING' && a.suggestion?.code) at.caixa_sugerida = a.suggestion.code
  if (cur) {
    if (!exact) at.codigo_anterior = cur.sku
    else if (typeof ca.codigo_anterior === 'string' && ca.codigo_anterior) at.codigo_anterior = ca.codigo_anterior
  }
  for (const r of d.companionRules) {
    if (r.family === p.family) {
      at.acessorio_sku = r.sku
      at.acessorio_qtd = r.qty
    }
  }
  return at
}

export function buildImportPlan(input: BuildPlanInput): ImportPlan {
  const d: ImportDecisions = input.decisions ?? DEFAULT_DECISIONS
  const now = input.now ?? new Date()
  const warnings: PlanWarning[] = []
  const current = input.current

  // ---------------------------------------------------------------- caixas
  const { boxes, warnings: boxWarnings, sheetTotalByRow } = buildBoxModels(input.boxes, d)
  warnings.push(...boxWarnings)

  // ---------------------------------------------------------------- produtos: ler e classificar
  const parsed: OfficialProduct[] = []
  const skipped: { row: number; code: string | null; reason: string }[] = []
  for (const raw of input.products) {
    const r = classifyRow(raw, d)
    if (r.ok) parsed.push(r.product)
    else skipped.push({ row: raw.row, code: raw.code == null ? null : String(raw.code), reason: r.reason })
  }
  if (skipped.length)
    warnings.push({
      level: 'WARN',
      code: 'UNPARSED_ROW',
      message: `${skipped.length} linha(s) da planilha não foram entendidas e ficam de fora: ${skipped.slice(0, 8).map((s) => `linha ${s.row}${s.code ? ` (${s.code})` : ''}: ${s.reason}`).join('; ')}${skipped.length > 8 ? '…' : ''}`,
      codes: skipped.map((s) => s.code).filter((c): c is string => !!c),
    })
  if (!parsed.length) warnings.push({ level: 'BLOCKER', code: 'NO_PRODUCTS', message: 'A planilha de produtos não tem nenhum produto reconhecido.' })
  const byCode = new Map<string, OfficialProduct[]>()
  for (const p of parsed) byCode.set(p.code, [...(byCode.get(p.code) ?? []), p])
  const dupCodes = [...byCode.entries()].filter(([, l]) => l.length > 1)
  if (dupCodes.length)
    warnings.push({ level: 'BLOCKER', code: 'DUPLICATE_CODE', message: `Código repetido na planilha de produtos: ${dupCodes.map(([c, l]) => `${c} (linhas ${l.map((x) => x.row).join(', ')})`).join('; ')}. Corrija a planilha.`, codes: dupCodes.map(([c]) => c) })
  const unknownBrands = new Map<string, string[]>()
  for (const p of parsed) if (!p.brandKnown && p.brandRaw) unknownBrands.set(p.brandRaw, [...(unknownBrands.get(p.brandRaw) ?? []), p.code])
  for (const [b, codes] of unknownBrands) warnings.push({ level: 'WARN', code: 'UNKNOWN_BRAND', message: `Marca "${b}" desconhecida (${codes.length} produto(s)): importada como "${parsed.find((p) => p.brandRaw === b)!.brand}".`, codes })

  // ---------------------------------------------------------------- repetidos
  const dd = dedupe(parsed, d)
  const waterTanks = parsed.filter(isWaterTank)

  // ---------------------------------------------------------------- catálogo atual
  const bySku = new Map(current.variants.map((v) => [v.sku, v]))
  const ctx = { d, boxes, sheetTotalByRow }
  const products: PlannedProduct[] = []
  const pendingList: Pending[] = []
  const usedPallets = new Set<string>()
  const palletReplaced: string[] = []
  const palletTooTall: string[] = []

  for (const p of dd.kept) {
    const m = matchProduct(p, current.variants, bySku, d)
    const cur = m.variant
    const exact = m.match?.lineRelation === 'EXACT_CODE'
    if (m.weak) p.notes.push(m.weak)
    fillCapacity(p, cur, waterTanks)
    const a = applyCodeOverride(p, assignBox(p, cur, ctx), ctx)
    // problemas dos dados (vão também para as observações do cadastro) + observações da leitura (só na prévia)
    const problems = [...p.issues]
    let packaging: PlannedPackaging | null = null
    if (a.status === 'ASSIGNED') {
      const dims = a.source === 'SHEET' ? { l: a.box.lengthMm, w: a.box.widthMm, h: a.box.heightMm } : { l: Math.max(a.pack.lengthMm, a.pack.widthMm), w: Math.min(a.pack.lengthMm, a.pack.widthMm), h: a.pack.heightMm }
      const tare = a.source === 'SHEET' ? a.box.tareKg : round(Math.max(0, a.pack.grossKg - a.pack.netKg), 3)
      const wgt = plannedWeights(p, tare, d)
      const pal = plannedPallet(a, cur, d, current.palletTypes)
      if (pal.palletTypeCode) usedPallets.add(pal.palletTypeCode)
      if (pal.catalogPalletReplaced) palletReplaced.push(p.code)
      if (pal.tooTall) palletTooTall.push(p.code)
      const pk = cur?.pack ?? null
      const verified = !!pk && pk.verification === 'VERIFIED' && dimsKey(pk.lengthMm, pk.widthMm, pk.heightMm) === dimsKey(dims.l, dims.w, dims.h) && pk.netKg > 0 && Math.abs(wgt.netKg - pk.netKg) / pk.netKg <= 0.02
      packaging = {
        boxCode: a.source === 'SHEET' ? a.box.code : null,
        boxSheetRow: a.source === 'SHEET' ? a.box.sheetRow : null,
        boxSource: a.source,
        lengthMm: dims.l,
        widthMm: dims.w,
        heightMm: dims.h,
        boxTareKg: tare,
        netKg: wgt.netKg,
        grossKg: wgt.grossKg,
        grossSource: wgt.grossSource,
        grossNote: wgt.grossNote,
        unitsPerPackage: 1,
        palletTypeCode: pal.palletTypeCode,
        unitsPerPallet: pal.unitsPerPallet,
        palletSource: pal.palletSource,
        palletNote: pal.palletNote,
        palletHeightMm: pal.palletHeightMm,
        allowedOrientations: [...ALL_ORIENTATIONS],
        verification: verified ? 'VERIFIED' : 'ESTIMATED',
        confidence: a.confidence,
        reason: a.reason,
        notes: [...a.notes, ...(a.source === 'SHEET' && a.box.tareNote ? [a.box.tareNote] : [])],
      }
    }
    const name = productName(p, d)
    const spec = d.lines[p.lineKey]
    if (a.status === 'PENDING') {
      pendingList.push({
        code: p.code,
        row: p.row,
        name,
        family: p.family,
        reasonCode: a.reasonCode,
        reason: a.reason,
        suggestion: a.suggestion?.code ? { boxCode: a.suggestion.code, sheetRow: a.suggestion.sheetRow, dims: boxDimsText(a.suggestion) } : null,
        unitsPerPackHint: a.unitsPerPackHint,
      })
    }
    if (dd.keptWithBadData.includes(p.code)) problems.push('descrição repetida em que todos os códigos têm dados ruins: mantido o mais recente')
    products.push({
      code: p.code,
      row: p.row,
      action: exact ? 'UPDATE' : 'CREATE',
      existingVariantId: exact ? cur!.variantId : null,
      family: p.family,
      productLine: spec.productLine,
      name,
      brand: p.brand,
      kind: p.kind,
      lineKey: p.lineKey,
      thicknessUm: p.thicknessUm,
      diameterFt: p.diameterFt,
      widthM: p.widthM,
      lengthM: p.lengthM,
      lengthFt: p.lengthFt,
      ean: p.ean,
      eanStatus: p.eanStatus,
      eanNote: p.eanNote,
      attrs: buildAttrs(p, cur, exact, a, d),
      notes: problems.length ? `Catálogo oficial (planilha, linha ${p.row}): ${problems.join('; ')}` : null,
      match: m.match,
      packaging,
      dataIssues: [...problems, ...p.notes],
      source: { group: p.group, measure: p.measure, thickness: p.thicknessText, brand: p.brandRaw, netKg: p.netKg, grossKg: p.grossKg },
    })
  }

  // ---------------------------------------------------------------- famílias e linhas
  const usedFamilies = [...new Set(products.map((x) => x.family))]
  const famByCode = new Map(current.families.map((f) => [f.code, f]))
  let maxSort = Math.max(0, ...current.families.map((f) => f.sort))
  const order: FamilyKey[] = ['SILO_BAG', 'SILAGE_TARP', 'HIDROSILO', 'HYDROFORCE', 'SILAGE_BAG', 'ACCESSORY', ...d.newFamilies]
  const families: FamilyChange[] = []
  for (const key of [...new Set(order)].filter((k) => usedFamilies.includes(k))) {
    const spec = d.families[key]
    const ex = famByCode.get(spec.code)
    if (ex) families.push({ key, code: spec.code, name: ex.name, action: 'EXISTS', sort: ex.sort })
    else families.push({ key, code: spec.code, name: spec.name, action: 'CREATE', sort: ++maxSort })
  }
  const lines: LineChange[] = []
  const seenLine = new Set<string>()
  for (const x of products) {
    const k = `${x.family}|${x.productLine}`
    if (seenLine.has(k)) continue
    seenLine.add(k)
    const fam = famByCode.get(d.families[x.family].code)
    const exists = !!fam && current.lines.some((l) => l.familyId === fam.id && l.name === x.productLine)
    lines.push({ family: x.family, name: x.productLine, action: exists ? 'EXISTS' : 'CREATE' })
  }

  // ---------------------------------------------------------------- desativações
  const plannedCodes = new Set(products.map((x) => x.code))
  const replaced = new Map<string, string[]>()
  for (const x of products) if (x.match && x.match.lineRelation !== 'EXACT_CODE') replaced.set(x.match.sku, [...(replaced.get(x.match.sku) ?? []), x.code])
  // repetido descartado que já está no catálogo (reimportação): sai em favor do código mantido
  for (const x of dd.discarded) if (bySku.has(x.code) && !replaced.has(x.code)) replaced.set(x.code, [x.keptCode])
  const keep = new Set(d.keepActiveSkus)
  const deactivated: Deactivation[] = current.variants
    .filter((v) => v.active && !plannedCodes.has(v.sku) && !keep.has(v.sku))
    .map((v) => ({ variantId: v.variantId, sku: v.sku, name: v.name, family: v.familyName, replacedBy: replaced.get(v.sku) ?? [] }))
    .sort((a, b) => a.family.localeCompare(b.family) || a.sku.localeCompare(b.sku))
  const keptActive = d.keepActiveSkus.map((sku) => {
    const rule = d.companionRules.find((r) => r.sku === sku)
    return { sku, reason: rule ? `acompanhante obrigatório: 1 ${sku} por caixa de ${d.families[rule.family].name} (regra do kit)` : 'mantido ativo por decisão (fora da planilha oficial)' }
  })
  for (const sku of d.keepActiveSkus) if (!bySku.has(sku)) warnings.push({ level: 'WARN', code: 'KEEP_ACTIVE_MISSING', message: `${sku} deveria continuar ativo, mas não existe no catálogo atual.`, codes: [sku] })

  // ---------------------------------------------------------------- avisos
  const deactSet = new Set(deactivated.map((x) => x.sku))
  const familiesWithoutActiveProducts = current.families
    .filter((f) => f.active)
    .filter((f) => {
      const stillActive = current.variants.some((v) => v.active && v.familyCode === f.code && !deactSet.has(v.sku))
      const planned = products.some((x) => d.families[x.family].code === f.code)
      return !stillActive && !planned
    })
    .map((f) => f.name)
  for (const f of familiesWithoutActiveProducts) warnings.push({ level: 'INFO', code: 'FAMILY_EMPTY', message: `A família "${f}" fica sem produtos ativos depois da importação.` })

  // regra comercial das lonas (domain/lonaRule): exportação = Lona padrão, mercado interno = Lona BPF. Uma
  // importação que deixa a exportação quase sem Lona padrão (as duas séries na mesma linha) não pode ser aplicada.
  const ruleCount = (prefix: string) => products.filter((x) => x.name.startsWith(prefix) && isRuleLona(x.name) && (lonaWidthM(x.name) ?? 99) <= 14).length
  const nPadrao = ruleCount('Lona padrão')
  const nBpf = ruleCount('Lona BPF')
  if (nBpf > 0 && nPadrao < nBpf / 2)
    warnings.push({
      level: 'BLOCKER',
      code: 'LONA_RULE_EXPORT',
      message: `Após a importação só ${nPadrao} “Lona padrão” até 14 m ficariam ativas (contra ${nBpf} “Lona BPF”): pela regra das lonas, pedidos de EXPORTAÇÃO que não citam a linha não encontrariam as lonas. Confira a linha de cada grupo de lonas (decisão 4, decisions.ts › tarpGroupLine) e gere a prévia de novo.`,
    })
  const exportLoss = deactivated.filter((v) => isRuleLona(v.name) && /^lona padr[aã]o/i.test(v.name) && !v.replacedBy.some((c) => products.find((x) => x.code === c)?.name.startsWith('Lona padrão')))
  if (exportLoss.length)
    warnings.push({
      level: 'WARN',
      code: 'LONA_EXPORT_NO_REPLACEMENT',
      message: `${exportLoss.length} “Lona padrão” até 14 m (exportação) saem sem uma Lona padrão equivalente na planilha: ${exportLoss.map((v) => `${v.sku}${v.replacedBy.length ? ` (→ ${v.replacedBy.join('/')}, outra linha)` : ''}`).join(', ')}. Pedidos de exportação dessas medidas que não citam a linha ficam sem produto.`,
      codes: exportLoss.map((v) => v.sku),
    })

  const invalidEan = products.filter((x) => x.eanStatus === 'INVALID')
  if (invalidEan.length) warnings.push({ level: 'INFO', code: 'EAN_INVALID', message: `${invalidEan.length} EAN inválido(s), gravados como vieram e marcados como inválidos: ${codeList(invalidEan.map((x) => x.code))}.`, codes: invalidEan.map((x) => x.code) })
  const gtin = products.filter((x) => x.eanStatus === 'GTIN14')
  if (gtin.length) warnings.push({ level: 'INFO', code: 'GTIN14', message: `${gtin.length} código(s) de barras são GTIN-14 (código da caixa / pacote, não da unidade): ${codeList(gtin.map((x) => x.code))}.`, codes: gtin.map((x) => x.code) })
  if (dd.discarded.length)
    warnings.push({
      level: 'INFO',
      code: 'DUPLICATES',
      message: `${dd.groups} descrições repetidas: ${dd.discarded.length} código(s) não entram (fica o mais recente com dados bons). Ver a aba "Repetidos descartados".${dd.keptNotHighest.length ? ` Em ${dd.keptNotHighest.length} grupo(s) o mais recente tinha dados ruins: ${dd.keptNotHighest.map((g) => `${g.skipped.join('/')} → ${g.kept}`).join('; ')}.` : ''}`,
      codes: dd.discarded.map((x) => x.code),
    })
  const same = sameSizeDifferentText(dd.kept)
  if (same.length)
    warnings.push({
      level: 'INFO',
      code: 'SAME_SIZE_DIFFERENT_TEXT',
      message: `${same.length} grupo(s) com a mesma medida, espessura e marca mantidos separados (grupos diferentes da planilha, ou uma linha só com a largura do filme aberto e outra com a capacidade): ${same.slice(0, 10).map((g) => g.join('/')).join('; ')}${same.length > 10 ? '…' : ''}. Confira se são o mesmo produto.`,
      codes: same.flat(),
    })
  const grossReplaced = products.filter((x) => x.packaging?.grossSource === 'NET_PLUS_BOX_TARE')
  if (grossReplaced.length) warnings.push({ level: 'INFO', code: 'GROSS_REPLACED', message: `${grossReplaced.length} produto(s) com bruto oficial inutilizável: bruto = líquido + tara da caixa. ${codeList(grossReplaced.map((x) => x.code))}.`, codes: grossReplaced.map((x) => x.code) })
  const anomalies = dd.kept.filter((p) => p.netVsTheory != null && (p.netVsTheory < 0.85 || p.netVsTheory > 1.2))
  if (anomalies.length) warnings.push({ level: 'INFO', code: 'WEIGHT_ANOMALY', message: `${anomalies.length} produto(s) com peso líquido fora de 85–120% do teórico pela medida e espessura: ${codeList(anomalies.map((p) => p.code))}.`, codes: anomalies.map((p) => p.code) })
  for (const rule of d.companionRules) {
    const fam = products.filter((x) => x.family === rule.family)
    if (fam.length) warnings.push({ level: 'INFO', code: 'HF_COMPANION', message: `Os ${fam.length} produtos ${d.families[rule.family].name} recebem a regra do kit: ${rule.qty} ${rule.sku} por caixa.`, codes: fam.map((x) => x.code) })
  }
  if (palletReplaced.length)
    warnings.push({
      level: 'INFO',
      code: 'PALLET_FROM_SHEET',
      message: `${palletReplaced.length} produto(s) com equivalente no catálogo usam o palete da tabela de caixas: o palete do catálogo não serve para a caixa planejada (menos caixas por camada ou mais de ${REFERENCE_PALLET_MAX_HEIGHT_MM.toLocaleString('pt-BR')} mm de altura): ${codeList(palletReplaced)}.`,
      codes: palletReplaced,
    })
  if (palletTooTall.length)
    warnings.push({
      level: 'WARN',
      code: 'PALLET_TOO_TALL',
      message: `${palletTooTall.length} palete(s) padrão passam de ${REFERENCE_PALLET_MAX_HEIGHT_MM.toLocaleString('pt-BR')} mm de altura (porta do contêiner 20'/40' Dry) sem alternativa na tabela de caixas — confira no Catálogo: ${codeList(palletTooTall)}.`,
      codes: palletTooTall,
    })
  const palletCodes = new Set(current.palletTypes.map((pt) => pt.code))
  const missingPallets = [...usedPallets].filter((c) => !palletCodes.has(c))
  if (missingPallets.length)
    warnings.push({ level: 'BLOCKER', code: 'PALLET_TYPE_MISSING', message: `Tipo de palete inexistente no programa: ${missingPallets.join(', ')}. Cadastre o palete ou ajuste a tabela de caixas.`, codes: products.filter((x) => x.packaging?.palletTypeCode && missingPallets.includes(x.packaging.palletTypeCode)).map((x) => x.code) })

  // ---------------------------------------------------------------- resumo
  const withPackaging = products.filter((x) => x.packaging).length
  const famName = (k: FamilyKey) => families.find((f) => f.key === k)?.name ?? d.families[k].name
  const boxesUsed = new Map<string, { boxCode: string; dims: string; products: number }>()
  for (const x of products) {
    const pk = x.packaging
    if (!pk) continue
    const code = pk.boxCode ?? '—'
    const dims = `${pk.lengthMm}×${pk.widthMm}×${pk.heightMm}`
    const k = `${code}|${dims}`
    const cur = boxesUsed.get(k) ?? { boxCode: code, dims, products: 0 }
    cur.products++
    boxesUsed.set(k, cur)
  }
  const byLine = new Map<string, number>()
  for (const x of products) byLine.set(x.productLine, (byLine.get(x.productLine) ?? 0) + 1)
  const summary: Summary = {
    sheetRows: input.products.length,
    parsedRows: parsed.length,
    skippedRows: skipped.length,
    duplicateGroups: dd.groups,
    duplicatesDiscarded: dd.discarded.length,
    planned: products.length,
    toCreate: products.filter((x) => x.action === 'CREATE').length,
    toUpdate: products.filter((x) => x.action === 'UPDATE').length,
    withPackaging,
    pending: products.length - withPackaging,
    confidence: { HIGH: products.filter((x) => x.packaging?.confidence === 'HIGH').length, MEDIUM: products.filter((x) => x.packaging?.confidence === 'MEDIUM').length },
    byFamily: families.map((f) => {
      const l = products.filter((x) => x.family === f.key)
      const wp = l.filter((x) => x.packaging).length
      return { family: f.key, name: famName(f.key), total: l.length, withPackaging: wp, pending: l.length - wp }
    }),
    byLine: [...byLine.entries()].map(([line, total]) => ({ line, total })).sort((a, b) => b.total - a.total || a.line.localeCompare(b.line)),
    ean: {
      EAN13: products.filter((x) => x.eanStatus === 'EAN13').length,
      GTIN14: gtin.length,
      INVALID: invalidEan.length,
      missing: products.filter((x) => x.eanStatus == null).length,
    },
    grossReplaced: grossReplaced.length,
    deactivations: deactivated.length,
    newFamilies: families.filter((f) => f.action === 'CREATE').map((f) => f.name),
    newLines: lines.filter((l) => l.action === 'CREATE').map((l) => l.name),
    boxesUsed: [...boxesUsed.values()].sort((a, b) => b.products - a.products || a.boxCode.localeCompare(b.boxCode)),
    refPalletsEstimate: products.filter((x) => x.packaging && x.packaging.palletTypeCode && x.packaging.unitsPerPallet).length,
    familiesWithoutActiveProducts,
  }

  return {
    engineVersion: ENGINE_VERSION,
    generatedAt: now.toISOString(),
    decisionsId: d.id,
    files: input.files,
    catalogFingerprint: input.catalogFingerprint,
    boxes,
    families,
    lines,
    products,
    pending: pendingList,
    discarded: dd.discarded,
    deactivations: { variants: deactivated, keptActive },
    warnings,
    summary,
  }
}
