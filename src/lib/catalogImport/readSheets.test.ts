import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { cellDigits, cellNumber } from '@/domain/catalogImport/cells'
import { ImportFileError, rawCell, readBoxesXlsx, readProductsXlsx } from './readSheets'

const HEAD = ['Código', 'Descrição produto', 'Medidas', 'Espessura', 'Marca', 'Peso líquido', 'Peso Bruto', 'Cód.EAN']

async function productsXlsx(o: { head?: string[]; emptyFormattedRows?: number; extraSheet?: boolean } = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Planilha1')
  ws.addRow(o.head ?? HEAD)
  ws.addRow([19712, 'SILO PLAS/RESERV BPF', '8MX50M', '150MIC (NATURAL)', 'PACIFIL', 55.9, 60, 7898557304619])
  ws.addRow([18098, 'SILO PLAS/RESERV HIDROSILO', '2MX1M C/ 4 UN', { richText: [{ text: '600' }, { text: 'MIC' }] }, 'PACIFIL', 8.96, { formula: 'F3+2.645', result: 11.605 }, 17898557309765])
  ws.addRow([76794, 'FITA DE BUTIL', '41CM X 35CM', null, 'FITA', 0.331, 0.331, '7898557306262'])
  // linhas vazias só com formatação (como a planilha oficial, que declara ~1 milhão)
  for (let r = 5; r < 5 + (o.emptyFormattedRows ?? 0); r++) ws.getCell(`A${r}`).numFmt = '@'
  if (o.extraSheet) wb.addWorksheet('Outra').addRow(['x', 1, 2])
  return Buffer.from(await wb.xlsx.writeBuffer())
}

describe('readProductsXlsx', () => {
  it('lê só as linhas com dados, mesmo com milhares de linhas vazias formatadas', async () => {
    const { rows, info } = await readProductsXlsx(await productsXlsx({ emptyFormattedRows: 5000, extraSheet: true }), 'produtos.xlsx')
    expect(rows).toHaveLength(3)
    expect(info.lastDataRow).toBe(4)
    expect(info.declaredRows).toBeGreaterThanOrEqual(4)
    expect(info.sheetName).toBe('Planilha1')
    expect(info.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(rows.map((r) => r.row)).toEqual([2, 3, 4])
  })

  it('código e EAN numéricos viram o texto exato; rich text e fórmula viram valor', async () => {
    const { rows } = await readProductsXlsx(await productsXlsx(), 'produtos.xlsx')
    expect(cellDigits(rows[0].code)).toBe('19712')
    expect(cellDigits(rows[0].ean)).toBe('7898557304619')
    expect(cellDigits(rows[1].ean)).toBe('17898557309765')
    expect(rows[1].thickness).toBe('600MIC')
    expect(cellNumber(rows[1].grossKg)).toBe(11.605)
    expect(rows[2].thickness).toBeNull()
    expect(cellDigits(rows[2].ean)).toBe('7898557306262')
    expect(rows[0]).toMatchObject({ group: 'SILO PLAS/RESERV BPF', measure: '8MX50M', brand: 'PACIFIL', netKg: 55.9, grossKg: 60 })
  })

  it('coluna faltando → erro com o nome da coluna', async () => {
    const head = HEAD.map((h) => (h === 'Peso Bruto' ? 'Peso' : h))
    await expect(readProductsXlsx(await productsXlsx({ head }), 'p.xlsx')).rejects.toThrow(/faltam “peso bruto”/)
  })

  it('arquivo que não é .xlsx → ImportFileError', async () => {
    await expect(readProductsXlsx(Buffer.from('Código;Descrição\n1;x'), 'p.csv')).rejects.toBeInstanceOf(ImportFileError)
  })
})

async function boxesXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('CAIXAS PESO E MEDIDAS')
  ws.addRow(['CÓDIGO RECH', 'REFERENCIA DE PESO LIQUIDO DAS BOLSAS', 'REFERENCIA', 'PALLET', 'COMP', 'X', 'LARG', 'X', 'ALT', 'M³', 'PESO ', 'PESO KIT', 'PESO PLÁST.FITAS ', 'PESO TOTAL EMBALAGEN+CAIXA +KIT', 'DISTRIBUIÇÃO PALLETS'])
  ws.addRow([72786, '10KG A 30KG', 'BPF 6X25-8X25', '1,00X1,20', 500, 'X', 600, 'X', 130, 0.039, 0.75, 0, 0.35, { formula: 'K2+L2+M2', result: 1.1 }, 52])
  ws.addRow([75381, null, '6X25-8X25', '1,00X1,20', 600, 'X', 500, 'X', 100, 0.03, 0.75, 0, 0.35, 1.1, 40])
  ws.addRow([69491, '148KG A 175KG', '10X75', '1,00X1,20', 1000, 'X', 600, 'X', 490, 0.294, 5.9, 0.16, 0.9, 6.7, '20 ou 26'])
  ws.mergeCells('B2:B3')
  ws.getRow(3).hidden = true
  // linha vazia e, abaixo, um quadro que não faz parte da tabela
  ws.getCell('D7').value = 'PALLET'
  ws.getCell('E7').value = 'MEDIDA EXTERNAS'
  return Buffer.from(await wb.xlsx.writeBuffer())
}

describe('readBoxesXlsx', () => {
  it('lê até a primeira linha vazia; coluna B mesclada vale nas duas linhas; marca linha oculta e fórmula', async () => {
    const { rows, info } = await readBoxesXlsx(await boxesXlsx(), 'caixas.xlsx')
    expect(rows.map((r) => r.row)).toEqual([2, 3, 4])
    expect(rows[1].rangeText).toBe('10KG A 30KG')
    expect(rows[1].hidden).toBe(true)
    expect(rows[0].hidden).toBe(false)
    expect(rows[0].totalIsFormula).toBe(true)
    expect(rows[0].totalKg).toBe(1.1)
    expect(rows[2].totalIsFormula).toBe(false)
    expect(rows[2]).toMatchObject({ code: 69491, reference: '10X75', palletText: '1,00X1,20', lengthMm: 1000, widthMm: 600, heightMm: 490, boxKg: 5.9, kitKg: 0.16, plasticKg: 0.9, boxesPerPalletText: '20 ou 26' })
    expect(info).toMatchObject({ sheetName: 'CAIXAS PESO E MEDIDAS', lastDataRow: 4 })
  })

  it('cabeçalho diferente → erro; arquivo grande demais → erro', async () => {
    const wb = new ExcelJS.Workbook()
    wb.addWorksheet('X').addRow(['Código', 'Descrição'])
    await expect(readBoxesXlsx(Buffer.from(await wb.xlsx.writeBuffer()), 'x.xlsx')).rejects.toThrow(/colunas esperadas/)
    await expect(readBoxesXlsx(Buffer.alloc(1024 * 1024 + 1), 'grande.xlsx')).rejects.toThrow('Tabela de caixas inesperada (maior que 1 MB).')
  })
})

describe('rawCell', () => {
  it('converte os tipos do exceljs', () => {
    expect(rawCell(null)).toBeNull()
    expect(rawCell('  ')).toBeNull()
    expect(rawCell(' 150MIC ')).toBe(' 150MIC ')
    expect(rawCell({ formula: 'A1', result: 3 })).toBe(3)
    expect(rawCell({ sharedFormula: 'N2', result: 2.284 })).toBe(2.284)
    expect(rawCell({ error: '#N/A' })).toBe('#N/A')
    expect(rawCell({ text: 'link', hyperlink: 'http://x' })).toBe('link')
    expect(rawCell(new Date('2026-10-13T00:00:00Z'))).toBe('2026-10-13T00:00:00.000Z')
  })
})
