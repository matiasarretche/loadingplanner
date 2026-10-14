/**
 * Classifica cada linha da planilha de produtos: família, tipo, linha, medidas em metros, marca, EAN.
 * Ordem das regras = scripts/normalize.js da análise (acessórios → silo-bolsa em pés → reservatórios →
 * Hidropeso → bolsas para silagem → filmes → lonas), com as decisões do dono (decisions.ts).
 */
import { calcLengthM, perimeterFor, siloBagFormulaText, siloBagNetKg, theoreticalPerimeterM, type SiloPerimeter } from '@/domain/siloPerimeter'
import { cellDigits, cellNumber, cellText } from './cells'
import type { ImportDecisions } from './decisions'
import { eanStatusOf, PACIFIL_GS1_PREFIX } from './ean'
import { FT_M, lineTextOf, parseMeasure, parseThickness, PE_DENSITY, round } from './parseProduct'
import type { EanStatus, FamilyKey, LineKey, ProductKindKey, RawProductRow } from './types'

export interface OfficialProduct {
  row: number
  code: string
  group: string
  measure: string
  thicknessText: string | null
  brandRaw: string | null
  /** marca do catálogo (decisão: FITA e EXT. B → Pacifil) */
  brand: string
  brandKnown: boolean
  netKg: number | null
  grossKg: number | null
  ean: string | null
  eanStatus: EanStatus | null
  eanNote: string | null
  kind: ProductKindKey
  family: FamilyKey
  lineKey: LineKey
  /** sub-linha escrita na medida (silo-bolsa BPT / BPM / BBT / B/P) */
  subLine: string | null
  diameterFt: number | null
  widthM: number | null
  lengthM: number | null
  lengthFt: number | null
  /** largura em pés quando a medida veio em pés (lonas / reservatórios) */
  widthFt: number | null
  /** reservatórios: largura do filme aberto (2 × a largura plana) */
  filmWidthM: number | null
  widthBasis: 'LAY_FLAT' | 'FILM_WIDTH' | 'AS_WRITTEN' | null
  widthCm: number | null
  lengthCm: number | null
  capacityL: number | null
  capacitySource: 'MEASURE' | 'MATCH' | 'SIBLING' | null
  valves: number | null
  unitsPerPack: number | null
  thicknessUm: number | null
  tags: string[]
  color: string | null
  imperial: boolean
  /** silo-bolsa: perímetro REAL cadastrado para o diâmetro (null = sem; vale o peso da planilha) */
  realPerimeterM: number | null
  /**
   * silo-bolsa: líquido pelo perímetro real (domain/siloPerimeter). Só muda o peso GRAVADO: o líquido da planilha
   * (netKg) continua decidindo repetidos, faixa de peso da caixa, tara e bruto.
   */
  calcNetKg: number | null
  /** fórmula do líquido calculado: "8,70 m × 75 m × 208 µm × 0,932 g/cm³" */
  calcNetFormula: string | null
  theoreticalNetKg: number | null
  netVsTheory: number | null
  /** problemas dos dados (vão para a prévia) */
  issues: string[]
  /** observações da leitura */
  notes: string[]
}

export type ClassifyResult = { ok: true; product: OfficialProduct } | { ok: false; reason: string }

const kgText = (x: number) => String(round(x, 3)).replace('.', ',')
const titleCase = (s: string) => s.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase())

/** Marca da planilha → marca do catálogo. */
export function mapBrand(raw: string | null, d: ImportDecisions): { brand: string; known: boolean } {
  const k = (raw ?? '').toUpperCase().replace(/\s+/g, ' ').trim()
  if (!k) return { brand: 'Pacifil', known: false }
  const b = d.brandMap[k]
  return b ? { brand: b, known: true } : { brand: titleCase(k), known: false }
}

function tarpLine(group: string, lineText: string | null, d: ImportDecisions): LineKey | null {
  const l = (lineText ?? '').toUpperCase()
  const g = d.tarpGroupLine
  if (group === 'SILO PLAS/RESERV BPF') return g['SILO PLAS/RESERV BPF']
  if (group === 'SILO PLAS/RESERV BPF PLUS') return g['SILO PLAS/RESERV BPF PLUS']
  if (group === 'PROTECAO PLAST MULTICAMADAS') {
    if (l.startsWith('BIGSAFE PLUSX3')) return 'TARP_BIGSAFE_PLUSX3'
    if (l.startsWith('BIGFORT')) return 'TARP_BIGFORT'
    return g.multilayer
  }
  if (group === 'SILO PLASTICO/RESERV') {
    if (l.startsWith('BIGSILO PLUSX3')) return 'TARP_BIGSILO_PLUSX3'
    if (l.startsWith('BIGSILO')) return 'TARP_BIGSILO'
    if (l.startsWith('BPF PLUSX3')) return 'TARP_BPF_PLUSX3'
    if (l.includes('B/P')) return 'TARP_BPF_BP'
    if (l.startsWith('C/BARR')) return 'TARP_BARRIER_PA'
    if (l.startsWith('BPF')) return g.namedBpfPrefix
    return g.otherPlain
  }
  if (/SBG$/.test(group)) return g.otherPlain
  return null
}

/**
 * Uma linha crua da planilha → produto oficial classificado (ou o motivo de não importar).
 * `sku`: produto fora da planilha (decisions.extraProducts) — o SKU dado é o código, sem a regra do código numérico.
 * `siloPerimeters`: perímetros reais da família Silo-bolsa (vazio = peso da planilha para todos).
 */
export function classifyRow(raw: RawProductRow, d: ImportDecisions, sku?: string, siloPerimeters: readonly SiloPerimeter[] = []): ClassifyResult {
  const code = sku ?? cellDigits(raw.code)
  const group = (cellText(raw.group) ?? '').toUpperCase()
  const measure = cellText(raw.measure) ?? ''
  if (!code) return { ok: false, reason: 'sem código (coluna A)' }
  if (!sku && !/^\d{1,12}$/.test(code)) return { ok: false, reason: `código "${code}" não é numérico` }
  if (!group) return { ok: false, reason: 'sem descrição do produto (coluna B)' }

  const thicknessText = cellText(raw.thickness)
  const brandRaw = cellText(raw.brand)
  const netKg = cellNumber(raw.netKg)
  const grossKg = cellNumber(raw.grossKg)
  const ean = cellDigits(raw.ean)
  const eanInfo = eanStatusOf(ean)
  const { brand, known } = mapBrand(brandRaw, d)
  const th = parseThickness(thicknessText)
  const pm = parseMeasure(measure)
  const issues: string[] = []
  const notes: string[] = [...th.notes, ...pm.notes]
  const dm = pm.dims

  const p: OfficialProduct = {
    row: raw.row,
    code,
    group,
    measure,
    thicknessText,
    brandRaw,
    brand,
    brandKnown: known,
    netKg: netKg == null ? null : round(netKg, 3),
    grossKg: grossKg == null ? null : round(grossKg, 3),
    ean,
    eanStatus: eanInfo.status,
    eanNote: eanInfo.note,
    kind: 'TARP',
    family: 'SILAGE_TARP',
    lineKey: 'TARP_STD',
    subLine: null,
    diameterFt: null,
    widthM: null,
    lengthM: null,
    lengthFt: null,
    widthFt: null,
    filmWidthM: null,
    widthBasis: null,
    widthCm: null,
    lengthCm: null,
    capacityL: pm.capacityL,
    capacitySource: pm.capacityL != null ? 'MEASURE' : null,
    valves: pm.valves,
    unitsPerPack: pm.unitsPerPack,
    thicknessUm: th.thicknessUm,
    tags: th.tags,
    color: th.color,
    imperial: false,
    realPerimeterM: null,
    calcNetKg: null,
    calcNetFormula: null,
    theoreticalNetKg: null,
    netVsTheory: null,
    issues,
    notes,
  }

  const metres = (v: number, u: 'cm' | 'ft' | 'm') => (u === 'ft' ? round(v * FT_M, 3) : u === 'cm' ? v / 100 : v)

  if (/^FITA |^CAIXA DE FITAS|^ADESIVO/.test(group)) {
    const base: ProductKindKey = /BUTIL/.test(group) ? 'TAPE_BUTYL' : /^ADESIVO/.test(group) ? 'REPAIR_PATCH_PVC' : 'TAPE_PE'
    p.kind = /^CAIXA/.test(group) && base !== 'REPAIR_PATCH_PVC' ? (`${base}_BOX` as ProductKindKey) : base
    p.family = 'ACCESSORY'
    p.lineKey = base === 'TAPE_BUTYL' ? 'TAPE_BUTYL' : base === 'REPAIR_PATCH_PVC' ? 'PATCH' : 'TAPE_PE'
    if (dm && dm.kind === 'CM') {
      p.widthCm = dm.a
      if (dm.bUnit === 'cm') p.lengthCm = dm.b
      else p.lengthM = dm.b
    } else return { ok: false, reason: `medidas do acessório não reconhecidas ("${measure}")` }
  } else if (dm && dm.kind === 'FT' && /SBG|SILO PLASTICO\/RESERV/.test(group)) {
    p.kind = 'SILO_BAG'
    p.family = 'SILO_BAG'
    p.lineKey = brand === 'Ecobag' ? 'SB_ECO' : brand === 'Probag' ? 'SB_PRO' : 'SB_STD'
    p.diameterFt = dm.a
    if (dm.bUnit === 'ft') {
      p.lengthFt = dm.b
      p.lengthM = round(dm.b * FT_M, 3)
    } else p.lengthM = dm.b
    p.subLine = /SBG/.test(group) ? null : lineTextOf(pm)
    // sigla de espessura da fábrica (BPT / BBT = tradicional, BPM = média): a espessura já está na medida — fora do nome
    const tier = [p.subLine, ...p.tags].filter((x): x is string => !!x && (d.siloBagThicknessCodes.includes(x.toUpperCase()) || d.siloBagThicknessTags.includes(x.toUpperCase())))
    if (tier.length) {
      if (p.subLine && d.siloBagThicknessCodes.includes(p.subLine.toUpperCase())) p.subLine = null
      p.tags = p.tags.filter((t) => !d.siloBagThicknessTags.includes(t.toUpperCase()))
      p.notes.push(`sigla de espessura da fábrica (${tier.join(', ')}) fora do nome: a espessura já está na medida`)
    }
  } else if (/HIDROSILO|HIDROFORCE/.test(group)) {
    p.kind = /HIDROFORCE/.test(group) ? 'HYDROFORCE' : 'HIDROSILO'
    p.family = p.kind === 'HYDROFORCE' ? 'HYDROFORCE' : 'HIDROSILO'
    p.lineKey = p.kind === 'HYDROFORCE' ? 'HF' : /^PLUS\s*X3/.test(pm.prefix ?? '') ? 'HS_PLUSX3' : 'HS'
    if (!dm || dm.kind === 'CM') return { ok: false, reason: `medidas do reservatório não reconhecidas ("${measure}")` }
    const w = metres(dm.a, dm.aUnit)
    const l = metres(dm.b, dm.bUnit)
    if (dm.aUnit === 'ft') {
      p.imperial = true
      p.widthFt = dm.a
      p.lengthFt = dm.bUnit === 'ft' ? dm.b : null
      notes.push('medidas em pés convertidas para metros')
    }
    p.lengthM = round(l, 3)
    // largura em pés convertida: 2 casas, como no nome (6,56 pés = 2 m, não 1,999)
    const wd = dm.aUnit === 'ft' ? 2 : 3
    // a largura escrita é a do tubo plano ou a do filme aberto? decide pelo peso oficial
    const units = pm.unitsPerPack ?? 1
    if (th.thicknessUm && netKg) {
      const tube = 2 * w * l * th.thicknessUm * 1e-6 * PE_DENSITY * units
      const film = w * l * th.thicknessUm * 1e-6 * PE_DENSITY * units
      const ok = (x: number) => x >= 0.85 && x <= 1.2
      if (ok(netKg / film) && !ok(netKg / tube)) {
        p.widthBasis = 'FILM_WIDTH'
        p.widthM = round(w / 2, wd)
        p.filmWidthM = round(w, wd)
        notes.push(`${String(dm.a).replace('.', ',')} m só fecha com o peso oficial como largura do FILME aberto (largura plana ${String(round(w / 2, wd)).replace('.', ',')} m)`)
      } else {
        p.widthBasis = 'LAY_FLAT'
        p.widthM = round(w, wd)
        p.filmWidthM = round(2 * w, wd)
      }
    } else {
      p.widthBasis = 'AS_WRITTEN'
      p.widthM = round(w, wd)
      p.filmWidthM = round(2 * w, wd)
    }
  } else if (/HIDROPESO/.test(group)) {
    p.kind = 'HIDROPESO'
    p.family = 'HIDROPESO'
    p.lineKey = 'HIDROPESO'
    if (dm && dm.kind !== 'CM') {
      p.widthM = metres(dm.a, dm.aUnit)
      p.lengthM = metres(dm.b, dm.bUnit)
    }
  } else if (/RESERV BS$/.test(group)) {
    p.kind = 'SILAGE_BAG_BOX'
    p.family = 'SILAGE_BAG'
    p.lineKey = 'SILAGE_BAG'
    if (dm && dm.kind !== 'CM') {
      p.widthM = metres(dm.a, dm.aUnit)
      p.lengthM = metres(dm.b, dm.bUnit)
    }
  } else if (group === d.filmGroup) {
    p.kind = 'FILM_ROLL'
    p.family = 'FILM_ROLL'
    p.lineKey = 'FILM_BPF'
    if (!dm || dm.kind === 'CM') return { ok: false, reason: `medidas do filme não reconhecidas ("${measure}")` }
    p.widthM = metres(dm.a, dm.aUnit)
    p.lengthM = metres(dm.b, dm.bUnit)
  } else {
    // lonas: BPF, BPF PLUS, SILO PLASTICO/RESERV (metros), PROTECAO PLAST MULTICAMADAS (BigSafe/BigFort), SBG em metros
    const line = tarpLine(group, lineTextOf(pm), d)
    if (!line) return { ok: false, reason: `grupo "${group}" desconhecido` }
    if (!dm || dm.kind === 'CM') return { ok: false, reason: `medidas da lona não reconhecidas ("${measure}")` }
    p.kind = 'TARP'
    p.family = 'SILAGE_TARP'
    p.lineKey = line
    if (dm.aUnit === 'ft') {
      p.imperial = true
      p.widthFt = dm.a
      notes.push('largura em pés convertida para metros')
    }
    p.widthM = metres(dm.a, dm.aUnit)
    if (dm.bUnit === 'ft') {
      p.lengthFt = dm.b
      p.lengthM = round(dm.b * FT_M, 3)
    } else p.lengthM = dm.b
    if (/SBG$/.test(group)) issues.push('grupo de silo-bolsa (SBG), mas a medida é de lona (m × m): importada como lona')
    if (th.thicknessUm != null && th.thicknessUm <= d.thinFilmMaxUm) {
      p.kind = 'FILM_ROLL'
      p.family = 'FILM_ROLL'
      p.lineKey = group === 'PROTECAO PLAST MULTICAMADAS' ? 'FILM_BIGSAFE' : 'FILM_BPF'
      notes.push(`${th.thicknessUm} µm: filme fino em rolo, não lona de silagem`)
    }
  }

  // espessura / marca escritas dentro da medida
  const mU = measure.toUpperCase()
  for (const b of ['ECOBAG', 'PROBAG']) if (mU.includes(b) && (brandRaw ?? '').toUpperCase() !== b) issues.push(`a medida cita ${b}, mas a marca (coluna E) é ${brandRaw ?? '—'}`)
  let hint: number | null = null
  const hm = pm.suffix ? /(?:^|\s|ECOBAG)\s*(\d{2,3})$/.exec(pm.suffix) : null
  if (hm) hint = Number(hm[1])
  if (pm.prefix && /^BPF(\d{2,3})$/.test(pm.prefix)) hint = Number(pm.prefix.slice(3))
  if (hint && p.thicknessUm && hint !== p.thicknessUm) issues.push(`a medida sugere ${hint} µm, mas a espessura (coluna D) é ${p.thicknessUm} µm`)
  if (!thicknessText && !/BUTIL|^ADESIVO/.test(group)) issues.push('espessura vazia (coluna D)')
  if (!known && brandRaw) issues.push(`marca "${brandRaw}" desconhecida`)

  // silo-bolsa com perímetro real cadastrado (decisão de 14/10/2026): líquido = perímetro real × comprimento ×
  // espessura × 0,932 g/cm³ — o mesmo que a tela Catálogo grava ao recalcular os pesos
  if (p.kind === 'SILO_BAG' && !p.unitsPerPack) {
    const perimeterM = perimeterFor(siloPerimeters, p.diameterFt)
    const lengthM = calcLengthM(p)
    p.realPerimeterM = perimeterM
    p.calcNetKg = siloBagNetKg({ perimeterM, lengthM, thicknessUm: p.thicknessUm })
    if (p.calcNetKg != null && perimeterM != null && lengthM != null && p.thicknessUm) {
      p.calcNetFormula = siloBagFormulaText({ perimeterM, lengthM, thicknessUm: p.thicknessUm })
      // produto fora da planilha: a observação vai junto com a origem do pedido (plan.ts)
      if (!sku) notes.push(`líquido pelo perímetro real ${p.calcNetFormula} = ${kgText(p.calcNetKg)} kg (planilha ${p.netKg != null ? `${kgText(p.netKg)} kg` : 'sem peso líquido'})`)
    }
  }

  // peso teórico (geometria × espessura × densidade) — só para avisar; silo-bolsa pelo perímetro real, se houver
  const units = p.unitsPerPack ?? 1
  const t = p.thicknessUm
  if (t && p.netKg) {
    let area: number | null = null
    if (p.kind === 'SILO_BAG' && p.diameterFt && p.lengthM) area = (p.realPerimeterM ?? theoreticalPerimeterM(p.diameterFt)) * p.lengthM
    else if ((p.kind === 'HIDROSILO' || p.kind === 'HYDROFORCE') && p.filmWidthM && p.lengthM) area = p.filmWidthM * p.lengthM
    else if (p.kind === 'SILAGE_BAG_BOX' && p.widthM && p.lengthM) area = 2 * p.widthM * p.lengthM
    else if ((p.kind === 'TARP' || p.kind === 'FILM_ROLL') && p.widthM && p.lengthM) area = p.widthM * p.lengthM
    if (area) {
      p.theoreticalNetKg = round(area * t * 1e-6 * PE_DENSITY * units, 2)
      p.netVsTheory = round(p.netKg / p.theoreticalNetKg, 3)
      if (p.netVsTheory < 0.85 || p.netVsTheory > 1.2) {
        const pct = Math.round((p.netVsTheory - 1) * 100)
        issues.push(`peso líquido ${p.netKg} kg ${pct > 0 ? '+' : ''}${pct}% do teórico (${p.theoreticalNetKg} kg ${p.realPerimeterM != null ? 'pelo perímetro real, comprimento e espessura' : 'pela medida e espessura'}): o peso fecharia com ≈${Math.round(t * p.netVsTheory)} µm`)
      }
    }
  }

  // EAN
  if (p.eanStatus === 'INVALID') issues.push(`EAN ${ean} inválido: ${p.eanNote}`)
  else if (p.eanStatus === null) issues.push('sem EAN (coluna H)')
  else if (p.eanStatus === 'GTIN14' && !p.unitsPerPack) issues.push('GTIN-14 (código de caixa) numa linha sem "C/ n UN"')
  if (p.eanStatus === 'EAN13' && ean && !ean.startsWith(PACIFIL_GS1_PREFIX)) issues.push(`EAN ${ean}: dígito verificador certo, mas prefixo da empresa diferente de ${PACIFIL_GS1_PREFIX}`)
  if (p.unitsPerPack) notes.push(`pacote com ${p.unitsPerPack} unidades: pesos da linha são do pacote`)

  return { ok: true, product: p }
}
