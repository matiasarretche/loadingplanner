/**
 * TABELA DAS CAIXAS → modelos de caixa. Cada fila é interpretada pela REFERÊNCIA (coluna C, normalizada),
 * não pelo número da linha: se a planilha ganhar filas novas, as conhecidas continuam reconhecidas e as
 * desconhecidas aparecem na prévia (nunca são atribuídas automaticamente).
 */
import { cellDigits, cellNumber, cellText } from './cells'
import type { ImportDecisions } from './decisions'
import { round } from './parseProduct'
import type { BoxModel, PlanWarning, RawBoxRow } from './types'

/** Chave da referência: sem acentos, maiúsculas, espaços colapsados. */
export function refKeyOf(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim()
}

const plain = (s: string) => refKeyOf(s)

/** Faixa de peso líquido da coluna B: "ATÉ 55KG" → 0–55; "10KG A 30KG" → 10–30; outros textos → sem faixa. */
export function parseRange(s: string | null): { min: number | null; max: number | null } {
  if (!s) return { min: null, max: null }
  const t = plain(s)
  const n = [...t.matchAll(/(\d+)\s*KG/g)].map((m) => Number(m[1]))
  if (/\bATE\b/.test(t) && n.length) return { min: 0, max: n[0] }
  if (n.length >= 2) return { min: n[0], max: n[1] }
  return { min: null, max: null }
}

/** Texto do palete normalizado ("1,00 x 1,20" → "1,00X1,20"). */
export const palletKey = (s: string) => plain(s).replace(/\s+/g, '')

export const boxDimsText = (b: { lengthMm: number; widthMm: number; heightMm: number }) => `${b.lengthMm}×${b.widthMm}×${b.heightMm}`

export function buildBoxModels(rows: RawBoxRow[], d: ImportDecisions): { boxes: BoxModel[]; warnings: PlanWarning[]; sheetTotalByRow: Map<number, number> } {
  const boxes: BoxModel[] = []
  const warnings: PlanWarning[] = []
  // coluna N quando difere de K+L+M (os brutos oficiais às vezes usam a N)
  const sheetTotalByRow = new Map<number, number>()
  const fmt = (x: number) => String(round(x, 3)).replace('.', ',')
  for (const r of rows) {
    const reference = cellText(r.reference)
    if (!reference) continue
    const code = cellDigits(r.code)
    if (!code) {
      warnings.push({ level: 'INFO', code: 'BOX_ROW_NO_CODE', message: `Tabela de caixas, linha ${r.row} ("${reference}"${r.hidden ? ', oculta' : ''}): sem código de caixa — ignorada.` })
      continue
    }
    const refKey = refKeyOf(reference)
    const spec = d.boxReferenceSpecs[refKey]
    const notes: string[] = []
    if (spec?.note) notes.push(spec.note)
    const e = cellNumber(r.lengthMm) ?? 0
    const g = cellNumber(r.widthMm) ?? 0
    let lengthMm = Math.round(Math.max(e, g))
    let widthMm = Math.round(Math.min(e, g))
    let heightMm = Math.round(cellNumber(r.heightMm) ?? 0)
    if (e && g && e < g) notes.push(`A planilha escreve ${e}×${g}: guardado como ${lengthMm}×${widthMm} (comprimento ≥ largura).`)
    const ov = d.boxDimOverrides[code]
    if (ov) {
      const before = `${lengthMm}×${widthMm}×${heightMm}`
      lengthMm = ov.lengthMm ?? lengthMm
      widthMm = ov.widthMm ?? widthMm
      heightMm = ov.heightMm ?? heightMm
      const after = `${lengthMm}×${widthMm}×${heightMm}`
      if (before !== after) notes.push(`Medidas corrigidas por decisão: ${before} → ${after}.`)
    }
    const k = cellNumber(r.boxKg)
    const l = cellNumber(r.kitKg)
    const m = cellNumber(r.plasticKg)
    const n = cellNumber(r.totalKg)
    const components = k == null && l == null && m == null ? null : round((k ?? 0) + (l ?? 0) + (m ?? 0), 3)
    let tareKg: number
    let tareNote: string | null = null
    if (d.boxTare === 'COMPONENTS' && components != null) {
      tareKg = components
      if (n != null && Math.abs(n - components) > 0.0005) sheetTotalByRow.set(r.row, round(n, 3))
      if (n != null && Math.abs(n - components) > 0.0005) tareNote = `Coluna N (${fmt(n)} kg) ≠ K+L+M (${fmt(components)} kg)${r.totalIsFormula ? '' : ': N foi digitado, não é fórmula'}; usada K+L+M.`
    } else tareKg = round(n ?? components ?? 0, 3)
    if (tareNote) notes.push(tareNote)
    const rangeText = cellText(r.rangeText)
    const range = parseRange(rangeText)
    const palletRaw = cellText(r.palletText)
    const palletText = palletRaw ? palletKey(palletRaw) : null
    const palletTypeCode = palletText ? (d.palletTextToCode[palletText] ?? null) : null
    if (palletText && !palletTypeCode) notes.push(`Palete "${palletRaw}" não existe no programa.`)
    const bppText = cellText(r.boxesPerPalletText)
    const options = bppText ? [...bppText.matchAll(/\d+/g)].map((x) => Number(x[0])) : []
    const boxesPerPallet = options.length ? (d.boxesPerPalletChoice === 'MAX' ? Math.max(...options) : Math.min(...options)) : null
    if (options.length > 1) notes.push(`Caixas por palete com opções ("${bppText}"): usado ${boxesPerPallet}.`)
    if (r.hidden) notes.push('Fila oculta na planilha.')
    if (!spec) {
      notes.push('Referência não reconhecida: a caixa não é atribuída automaticamente.')
      warnings.push({ level: 'WARN', code: 'UNRECOGNIZED_BOX_ROW', message: `Tabela de caixas, linha ${r.row}: referência "${reference}" (caixa ${code}) não reconhecida — nenhum produto recebe esta caixa automaticamente.`, codes: [code] })
    }
    boxes.push({
      sheetRow: r.row,
      code,
      reference,
      refKey,
      recognized: !!spec,
      family: spec?.family ?? null,
      line: spec?.line ?? null,
      measures: spec?.measures ?? [],
      thicknessUm: spec?.thicknessUm ?? null,
      lengthMm,
      widthMm,
      heightMm,
      tareKg,
      tareNote,
      rangeText,
      netKgMin: range.min,
      netKgMax: range.max,
      ignoreWeightRange: !!spec?.ignoreWeightRange,
      palletText,
      palletTypeCode,
      boxesPerPalletText: bppText,
      boxesPerPallet,
      hidden: !!r.hidden,
      notes,
    })
  }
  return { boxes, warnings, sheetTotalByRow }
}
