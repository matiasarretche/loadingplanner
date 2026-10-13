// Sem 'server-only': também é usado pelo script de linha de comando (scripts/catalog-import-dry-run.ts).
import { createHash } from 'node:crypto'
import { PassThrough, type Readable } from 'node:stream'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { BOX_SHEET_COLUMNS, BOX_SHEET_NAME, normHeader, PRODUCT_SHEET_COLUMNS, type ProductSheetField } from '@/domain/catalogImport/sheetSpec'
import type { CellValue, FileInfo, RawBoxRow, RawProductRow } from '@/domain/catalogImport/types'

/** Erro de arquivo com mensagem pronta para o usuário (pt-BR). */
export class ImportFileError extends Error {}

/** planilha de produtos: mais linhas com dados que isso = arquivo errado (a oficial tem ~670) */
export const MAX_PRODUCT_ROWS = 20_000
/** tabela de caixas: arquivo pequeno (~30 KB); maior que isso não é a tabela */
export const MAX_BOXES_BYTES = 1024 * 1024

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex')

/** .xlsx é um zip: começa com "PK\x03\x04" */
function assertXlsx(buf: Buffer, name: string, what: string) {
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04)
    throw new ImportFileError(`O arquivo “${name}” não é uma planilha .xlsx (${what}). Salve no Excel como “Pasta de Trabalho do Excel (.xlsx)”.`)
}

/**
 * Valor de célula do exceljs → texto/número cru (o motor normaliza): rich text vira texto; fórmula vira o
 * resultado; data vira texto ISO; erro (#N/A…) vira o próprio texto; vazio → null.
 */
export function rawCell(v: unknown): CellValue {
  if (v == null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') return v.trim() === '' ? null : v
  if (typeof v === 'boolean') return v ? 'VERDADEIRO' : 'FALSO'
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString()
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (Array.isArray(o.richText)) return rawCell((o.richText as { text?: string }[]).map((t) => t.text ?? '').join(''))
    if ('formula' in o || 'sharedFormula' in o || 'result' in o) return rawCell(o.result)
    if ('error' in o) return String(o.error)
    if ('text' in o) return rawCell(o.text)
  }
  return null
}

const isFormula = (v: unknown) => typeof v === 'object' && v !== null && ('formula' in v || 'sharedFormula' in v)

/** partes do .xlsx que o leitor em streaming precisa ANTES das abas */
const XLSX_FIRST = ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/workbook.xml', 'xl/sharedStrings.xml', 'xl/styles.xml']

/**
 * O .xlsx regravado em streaming com as partes na ordem que o leitor do exceljs espera (pasta de trabalho,
 * relações e strings compartilhadas antes das abas). Na ordem original (o Excel grava a aba antes das
 * strings) o exceljs copia a aba de 60 MB para um arquivo temporário (/tmp na Vercel), que fica para trás se
 * a leitura parar no meio; e em arquivos gravados por outros programas ele perde as strings. Assim não há
 * arquivo temporário e o texto vem sempre. A aba é descompactada e recompactada aos poucos (nível 1):
 * ~5 s e ~120 MB de memória na planilha oficial.
 */
async function xlsxInStreamOrder(buf: Buffer): Promise<Readable> {
  const zip = await JSZip.loadAsync(buf)
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir)
  const out = new JSZip()
  for (const n of [...XLSX_FIRST.filter((x) => names.includes(x)), ...names.filter((x) => !XLSX_FIRST.includes(x))]) out.file(n, zip.files[n].nodeStream('nodebuffer'))
  // o stream do JSZip não é um Readable nativo, o único que o exceljs aceita
  return out.generateNodeStream({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 1 } }).pipe(new PassThrough())
}

/**
 * PLANILHA DE PRODUTOS (oficial): lida em streaming — o arquivo tem ~2,8 MB, mas a aba declara ~1 milhão de
 * linhas formatadas (60 MB de XML). Só a primeira aba conta; colunas achadas pelo cabeçalho da linha 1.
 * O laço vai sempre até o fim (o stream inteiro é consumido; nada fica pendurado na instância): erros
 * encontrados no meio são guardados e lançados depois. Linhas vazias custam pouco (~5 s no total).
 */
export async function readProductsXlsx(buf: Buffer, name: string): Promise<{ rows: RawProductRow[]; info: FileInfo }> {
  assertXlsx(buf, name, 'planilha de produtos')
  const rows: RawProductRow[] = []
  let sheetName = ''
  let sheetNo = 0
  let cols: Record<ProductSheetField, number> | null = null
  let fail: string | null = null
  let lastDataRow = 0
  let declaredRows = 0
  try {
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(await xlsxInStreamOrder(buf), { sharedStrings: 'cache', styles: 'ignore', hyperlinks: 'ignore', worksheets: 'emit', entries: 'ignore' })
    for await (const ws of reader) {
      sheetNo++
      const first = sheetNo === 1
      if (first) sheetName = (ws as unknown as { name?: string }).name ?? 'Planilha1'
      for await (const row of ws) {
        // outras abas e linhas depois de um erro: só consome até o fim (ver acima)
        if (!first || fail) continue
        if (row.number > declaredRows) declaredRows = row.number
        if (!row.hasValues) continue
        if (!cols) {
          // primeira linha com conteúdo = cabeçalho (normalmente a linha 1)
          const found = mapProductHeader(row)
          if ('missing' in found) {
            fail = `A planilha de produtos não tem as colunas esperadas: faltam “${found.missing.join('”, “')}” (aba “${sheetName}”, linha ${row.number}). Confira se é a planilha oficial de produtos.`
            continue
          }
          cols = found.cols
          continue
        }
        const get = (f: ProductSheetField) => rawCell(row.getCell(cols![f]).value)
        const r: RawProductRow = { row: row.number, code: get('code'), group: get('group'), measure: get('measure'), thickness: get('thickness'), brand: get('brand'), netKg: get('netKg'), grossKg: get('grossKg'), ean: get('ean') }
        if (r.code == null && r.group == null && r.measure == null && r.thickness == null && r.brand == null && r.netKg == null && r.grossKg == null && r.ean == null) continue
        rows.push(r)
        lastDataRow = row.number
        if (rows.length > MAX_PRODUCT_ROWS) fail = `A planilha de produtos tem mais de ${MAX_PRODUCT_ROWS.toLocaleString('pt-BR')} linhas com dados — não parece a planilha oficial.`
      }
    }
  } catch (e) {
    if (e instanceof ImportFileError) throw e
    throw new ImportFileError(`Não foi possível ler a planilha de produtos “${name}” (arquivo corrompido ou não é .xlsx): ${e instanceof Error ? e.message : String(e)}`)
  }
  if (fail) throw new ImportFileError(fail)
  if (!cols) throw new ImportFileError(`A planilha de produtos “${name}” está vazia (nenhum cabeçalho na primeira aba).`)
  if (!rows.length) throw new ImportFileError(`A planilha de produtos “${name}” não tem linhas de produto abaixo do cabeçalho.`)
  return { rows, info: { name, bytes: buf.length, sha256: sha256(buf), sheetName, lastDataRow, declaredRows: declaredRows || null } }
}

/** Cabeçalho da planilha de produtos → número da coluna de cada campo (texto igual; senão, que comece igual). */
function mapProductHeader(row: ExcelJS.Row): { cols: Record<ProductSheetField, number> } | { missing: string[] } {
  const headers: { col: number; h: string }[] = []
  row.eachCell({ includeEmpty: false }, (cell, col) => {
    const t = rawCell(cell.value)
    if (t != null) headers.push({ col, h: normHeader(String(t)) })
  })
  const used = new Set<number>()
  const cols = {} as Record<ProductSheetField, number>
  const missing: string[] = []
  for (const [f, spec] of Object.entries(PRODUCT_SHEET_COLUMNS) as [ProductSheetField, string][]) {
    const hit = headers.find((x) => !used.has(x.col) && x.h === spec) ?? headers.find((x) => !used.has(x.col) && x.h.startsWith(spec))
    if (!hit) {
      missing.push(spec)
      continue
    }
    used.add(hit.col)
    cols[f] = hit.col
  }
  return missing.length ? { missing } : { cols }
}

const colNo = (letter: string) => letter.toUpperCase().charCodeAt(0) - 64

/**
 * TABELA DAS CAIXAS ("CAIXAS PESO E MEDIDAS"): arquivo pequeno, lido inteiro. Colunas fixas por letra
 * (cabeçalho da linha 1 conferido por palavra-chave). Lê da linha 2 até a primeira linha toda vazia
 * (A–O): os quadros de paletes abaixo da tabela ficam de fora. Coluna B (faixa de peso) vem mesclada
 * em grupos de linhas: vale o valor da célula mestre.
 */
export async function readBoxesXlsx(buf: Buffer, name: string): Promise<{ rows: RawBoxRow[]; info: FileInfo }> {
  if (buf.length > MAX_BOXES_BYTES) throw new ImportFileError('Tabela de caixas inesperada (maior que 1 MB).')
  assertXlsx(buf, name, 'tabela de caixas')
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer)
  } catch (e) {
    throw new ImportFileError(`Não foi possível ler a tabela de caixas “${name}” (arquivo corrompido ou não é .xlsx): ${e instanceof Error ? e.message : String(e)}`)
  }
  const ws = wb.getWorksheet(BOX_SHEET_NAME) ?? wb.worksheets[0]
  if (!ws) throw new ImportFileError(`A tabela de caixas “${name}” não tem nenhuma aba.`)
  const head = ws.getRow(1)
  const wrong = Object.values(BOX_SHEET_COLUMNS).filter(({ col, header }) => !normHeader(String(rawCell(head.getCell(colNo(col)).value) ?? '')).startsWith(header))
  if (wrong.length)
    throw new ImportFileError(`A tabela de caixas não tem as colunas esperadas (aba “${ws.name}”, linha 1): ${wrong.map((w) => `coluna ${w.col} deveria ser “${w.header}”`).join('; ')}. Confira se é a tabela “${BOX_SHEET_NAME}”.`)

  const rows: RawBoxRow[] = []
  const last = Math.max(ws.rowCount, 1)
  let lastDataRow = 1
  for (let r = 2; r <= last; r++) {
    const row = ws.getRow(r)
    const cell = (k: keyof typeof BOX_SHEET_COLUMNS) => {
      const c = row.getCell(colNo(BOX_SHEET_COLUMNS[k].col))
      return c.isMerged && c.master.address !== c.address ? c.master.value : c.value
    }
    // fim da tabela: primeira linha sem nada de A a O
    let empty = true
    for (let c = 1; c <= 15 && empty; c++) if (rawCell(row.getCell(c).value) != null) empty = false
    if (empty) break
    const total = cell('totalKg')
    rows.push({
      row: r,
      hidden: Boolean(row.hidden),
      code: rawCell(cell('code')),
      rangeText: rawCell(cell('rangeText')),
      reference: rawCell(cell('reference')),
      palletText: rawCell(cell('palletText')),
      lengthMm: rawCell(cell('lengthMm')),
      widthMm: rawCell(cell('widthMm')),
      heightMm: rawCell(cell('heightMm')),
      boxKg: rawCell(cell('boxKg')),
      kitKg: rawCell(cell('kitKg')),
      plasticKg: rawCell(cell('plasticKg')),
      totalKg: rawCell(total),
      totalIsFormula: isFormula(total),
      boxesPerPalletText: rawCell(cell('boxesPerPalletText')),
    })
    lastDataRow = r
  }
  if (!rows.length) throw new ImportFileError(`A tabela de caixas “${name}” não tem linhas abaixo do cabeçalho.`)
  return { rows, info: { name, bytes: buf.length, sha256: sha256(buf), sheetName: ws.name, lastDataRow, declaredRows: ws.rowCount || null } }
}
