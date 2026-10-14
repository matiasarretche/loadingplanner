import { describe, expect, it } from 'vitest'
import { cellDigits, cellNumber, cellText } from './cells'
import { classifyRow, mapBrand } from './classify'
import { DEFAULT_DECISIONS } from './decisions'
import { eanStatusOf, gtinCheckDigit } from './ean'
import { lineTextOf, parseMeasure, parseThickness } from './parseProduct'
import { normHeader, PRODUCT_SHEET_COLUMNS } from './sheetSpec'
import type { RawProductRow } from './types'

const row = (o: Partial<RawProductRow>): RawProductRow => ({ row: 2, code: 10001, group: 'SILO PLAS/RESERV SBG', measure: '9PESX60M', thickness: '210MIC', brand: 'PACIFIL', netKg: 100, grossKg: 106, ean: 7898557300178, ...o })
const ok = (o: Partial<RawProductRow>) => {
  const r = classifyRow(row(o), DEFAULT_DECISIONS)
  if (!r.ok) throw new Error(r.reason)
  return r.product
}

describe('células cruas', () => {
  it('código e EAN viram texto exato (sem notação científica nem zeros perdidos)', () => {
    expect(cellDigits(19712)).toBe('19712')
    expect(cellDigits(17898557309765)).toBe('17898557309765')
    expect(cellDigits(' 07898557 ')).toBe('07898557')
    expect(cellDigits(null)).toBeNull()
    expect(cellDigits('')).toBeNull()
  })
  it('números aceitam vírgula decimal e limpam o ruído binário', () => {
    expect(cellNumber(0.33100000000000002)).toBe(0.331)
    expect(cellNumber('55,9')).toBe(55.9)
    expect(cellNumber('1.234,5')).toBe(1234.5)
    expect(cellNumber('abc')).toBeNull()
    expect(cellText('  8MX50M   ')).toBe('8MX50M')
  })
})

describe('cabeçalhos', () => {
  it('normaliza acentos, caixa e espaços', () => {
    expect(normHeader('Peso líquido')).toBe(PRODUCT_SHEET_COLUMNS.netKg)
    expect(normHeader('Cód.EAN')).toBe(PRODUCT_SHEET_COLUMNS.ean)
    expect(normHeader('Descrição  produto')).toBe(PRODUCT_SHEET_COLUMNS.group)
    expect(normHeader('Código')).toBe(PRODUCT_SHEET_COLUMNS.code)
  })
})

describe('EAN', () => {
  it('dígito verificador GS1', () => {
    expect(gtinCheckDigit('789855730017')).toBe(8)
    expect(gtinCheckDigit('1789855730976')).toBe(5)
  })
  it('EAN-13 válido, GTIN-14 de caixa e inválidos com o motivo', () => {
    expect(eanStatusOf('7898557300178')).toEqual({ status: 'EAN13', note: null })
    expect(eanStatusOf('17898557309765').status).toBe('GTIN14')
    expect(eanStatusOf('789855730389')).toEqual({ status: 'INVALID', note: '12 dígitos' })
    expect(eanStatusOf('78985573880')).toEqual({ status: 'INVALID', note: '11 dígitos' })
    const bad = eanStatusOf('7898558303650')
    expect(bad.status).toBe('INVALID')
    expect(bad.note).toContain('esperado 7898558303659')
    expect(bad.note).toContain('7898557303650 (válido)')
    expect(eanStatusOf('17898557309764').note).toContain('dígito verificador errado')
    expect(eanStatusOf('')).toEqual({ status: null, note: null })
    expect(eanStatusOf('78985A7300178').status).toBe('INVALID')
  })
})

describe('espessura e medidas', () => {
  it('MIC, MICRAS, MIL, MILL e GAUGE em µm; acabamentos e cor', () => {
    expect(parseThickness('125 MICRAS').thicknessUm).toBe(125)
    expect(parseThickness('150MIC (NATURAL)')).toMatchObject({ thicknessUm: 150, tags: ['NATURAL'] })
    expect(parseThickness('10MILL').thicknessUm).toBe(254)
    expect(parseThickness('5MIL').thicknessUm).toBe(127)
    expect(parseThickness('20MIL').thicknessUm).toBe(508)
    expect(parseThickness('2.362 GAUGE').thicknessUm).toBe(600)
    expect(parseThickness('120 MIC C/ DESLIZANTE')).toMatchObject({ thicknessUm: 120, tags: ['C/ DESLIZANTE'] })
    expect(parseThickness('220 MICRAS / MEDIA')).toMatchObject({ thicknessUm: 220, tags: ['MEDIA'] })
    expect(parseThickness('BRANCA S/LOGO')).toMatchObject({ thicknessUm: null, color: 'BRANCA S/LOGO' })
  })
  it('medidas em pés, metros, cm; capacidade, válvulas e pacotes', () => {
    expect(parseMeasure('12PESX500PES').dims).toEqual({ kind: 'FT', a: 12, aUnit: 'ft', b: 500, bUnit: 'ft' })
    expect(parseMeasure('BPT10PESX100M PROBAG')).toMatchObject({ prefix: 'BPT', suffix: 'PROBAG', dims: { kind: 'FT', a: 10, b: 100, bUnit: 'm' } })
    expect(parseMeasure('2,15MX35M 28.000L 4V')).toMatchObject({ capacityL: 28000, valves: 4, dims: { kind: 'M', a: 2.15, b: 35 } })
    expect(parseMeasure('C/BARR. PA O2 10X50')).toMatchObject({ prefix: 'C/BARR. PA O2', dims: { a: 10, b: 50 } })
    expect(parseMeasure('BPF100 12X50 B/P')).toMatchObject({ prefix: 'BPF100', suffix: 'B/P', dims: { a: 12, b: 50 } })
    expect(parseMeasure('41CM X 5M C/ 10 UN')).toMatchObject({ unitsPerPack: 10, dims: { kind: 'CM', a: 41, b: 5, bUnit: 'm' } })
    expect(parseMeasure('2MX3M C/50 UNI')).toMatchObject({ unitsPerPack: 50, dims: { a: 2, b: 3 } })
    expect(parseMeasure('6M X 22M').dims).toMatchObject({ a: 6, b: 22 })
    expect(lineTextOf(parseMeasure('BIGSILOPLUSX3 28X100'))).toBe('BIGSILO PLUSX3')
    expect(lineTextOf(parseMeasure('BPF PLUS X3 10X100'))).toBe('BPF PLUSX3')
    expect(lineTextOf(parseMeasure('BPF 8X50 ECOBAG 110'))).toBe('BPF')
  })
})

describe('classificação', () => {
  it('marcas: FITA e EXT. B viram Pacifil; desconhecida em título', () => {
    expect(mapBrand('FITA', DEFAULT_DECISIONS)).toEqual({ brand: 'Pacifil', known: true })
    expect(mapBrand('EXT. B', DEFAULT_DECISIONS)).toEqual({ brand: 'Pacifil', known: true })
    expect(mapBrand('AGRO MAX', DEFAULT_DECISIONS)).toEqual({ brand: 'Agro Max', known: false })
  })
  it('linhas de lona pelo grupo e pelo nome (decisão 4: grupo BPF = Lona padrão, exportação; "BPF 8X50" do grupo SILO PLASTICO/RESERV = Lona BPF)', () => {
    expect(ok({ group: 'SILO PLAS/RESERV BPF', measure: '8MX50M', thickness: '150MIC' }).lineKey).toBe('TARP_STD')
    expect(ok({ group: 'SILO PLAS/RESERV BPF PLUS', measure: '14MX50M', thickness: '120MIC' }).lineKey).toBe('TARP_PLUS')
    expect(ok({ group: 'SILO PLASTICO/RESERV', measure: 'BPF 8X50', thickness: '125 MICRAS' }).lineKey).toBe('TARP_BPF')
    expect(ok({ group: 'SILO PLASTICO/RESERV', measure: 'BPF 8X50 ECOBAG 110', thickness: '110 MICRAS', brand: 'ECOBAG' }).lineKey).toBe('TARP_BPF')
    expect(ok({ group: 'SILO PLASTICO/RESERV', measure: 'BPF PLUS X3 10X100', thickness: '125 MICRAS' }).lineKey).toBe('TARP_BPF_PLUSX3')
    expect(ok({ group: 'SILO PLASTICO/RESERV', measure: 'BIGSILOPLUSX3 28X100', thickness: '125 MICRAS' }).lineKey).toBe('TARP_BIGSILO_PLUSX3')
    expect(ok({ group: 'PROTECAO PLAST MULTICAMADAS', measure: 'BIGFORT 8,60X40', thickness: '500 MICRAS' }).lineKey).toBe('TARP_BIGFORT')
    expect(ok({ group: 'PROTECAO PLAST MULTICAMADAS', measure: 'BIGSAFE 2,3X100', thickness: '240MIC' })).toMatchObject({ family: 'SILAGE_TARP', lineKey: 'TARP_BIGSAFE' })
    expect(ok({ group: 'SILO PLAS/RESERV SBG', measure: '8MX100M', thickness: '120MIC' }).lineKey).toBe('TARP_STD')
  })
  it('lona até 80 µm e o grupo SILO PLAS/RESERV são filme em rolo', () => {
    expect(ok({ group: 'SILO PLAS/RESERV BPF', measure: '11MX100M', thickness: '70MIC' })).toMatchObject({ kind: 'FILM_ROLL', family: 'FILM_ROLL', lineKey: 'FILM_BPF' })
    expect(ok({ group: 'SILO PLAS/RESERV', measure: 'BPF 2M X 400M', thickness: '30 MIC' })).toMatchObject({ family: 'FILM_ROLL', widthM: 2, lengthM: 400 })
  })
  it('reservatório: largura do filme aberto decidida pelo peso', () => {
    const film = ok({ group: 'SILO PLAS/RESERV/HIDROSILO', measure: '4,3MX20M 4V', thickness: '500MIC', netKg: 40.08, grossKg: 47.708 })
    expect(film).toMatchObject({ widthM: 2.15, filmWidthM: 4.3, widthBasis: 'FILM_WIDTH', valves: 4 })
    const flat = ok({ group: 'SILO PLAS/RESERV/HIDROSILO', measure: '2MX10M 10.000L', thickness: '600MIC', netKg: 22.37, grossKg: 28.13 })
    expect(flat).toMatchObject({ widthM: 2, filmWidthM: 4, widthBasis: 'LAY_FLAT', capacityL: 10000, capacitySource: 'MEASURE' })
  })
  it('linhas sem código, grupo desconhecido ou medida ilegível ficam de fora com o motivo', () => {
    expect(classifyRow(row({ code: null }), DEFAULT_DECISIONS)).toEqual({ ok: false, reason: 'sem código (coluna A)' })
    expect(classifyRow(row({ group: 'OUTRA COISA', measure: '8X50' }), DEFAULT_DECISIONS)).toMatchObject({ ok: false })
    expect(classifyRow(row({ group: 'PROTECAO PLAST MULTICAMADAS', measure: 'BIGSAFE' }), DEFAULT_DECISIONS)).toMatchObject({ ok: false })
  })
})
