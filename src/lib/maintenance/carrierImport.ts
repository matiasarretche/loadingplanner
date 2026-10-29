import 'server-only'
import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import { asc, eq, sql } from 'drizzle-orm'
import { db, schema as s } from '@/db'
import { rawCell } from '@/lib/catalogImport/readSheets'
import {
  CARRIER_SHEET_COLUMNS,
  type CarrierCounts,
  carrierCountsOf,
  type CarrierImportPlan,
  type CellValue,
  type CurrentCarrier,
  type ImportedCarrier,
  MAX_CARRIER_ROWS,
  type NearNameGroup,
  nearCarrierCodeMessage,
  parseCarrierSheet,
  planCarrierImport,
  type SameNameGroup,
  type SheetIssue,
  type SheetRow,
  type SpecialCarrier,
} from '@/domain/carrierImport'
import { zeroPaddedText } from '@/domain/customerImport'
import { formulaWithoutValue, type UploadedFile } from './customerImport'
import { MaintenanceError } from './deleteAllLoads'
import type { Exec } from './loadsBackup'

export type { UploadedFile }

export interface CarrierSheetFile {
  name: string
  bytes: number
  sha256: string
  sheetName: string
}

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex')

/**
 * Lê a PRIMEIRA aba do .xlsx das transportadoras: linha 1 = cabeçalho; as outras linhas com algum valor = dados
 * (células da coluna A em diante, como texto/número cru). Arquivo pequeno (~735 linhas), lido inteiro.
 *  - número inteiro com formato de zeros ("000000") vira o texto que o Excel mostra (código 000012);
 *  - marca as linhas ocultas/filtradas e as fórmulas sem valor salvo (o parse transforma em erro);
 *  - mais de MAX_CARRIER_ROWS linhas com dados → erro (nada é cortado em silêncio).
 */
export async function readCarriersXlsx(f: UploadedFile): Promise<{ header: CellValue[]; rows: SheetRow[]; file: CarrierSheetFile }> {
  const { buf, name } = f
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04)
    throw new MaintenanceError(`O arquivo “${name}” não é uma planilha .xlsx. Salve no Excel como “Pasta de Trabalho do Excel (.xlsx)”.`)
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer)
  } catch (e) {
    throw new MaintenanceError(`Não foi possível ler a planilha “${name}” (arquivo corrompido ou não é .xlsx): ${e instanceof Error ? e.message : String(e)}`)
  }
  const ws = wb.worksheets.find(Boolean)
  if (!ws) throw new MaintenanceError(`A planilha “${name}” não tem nenhuma aba.`)
  const cellOf = (cell: ExcelJS.Cell): CellValue => {
    const v = rawCell(cell.value)
    return typeof v === 'number' ? (zeroPaddedText(v, cell.numFmt) ?? v) : v
  }
  const rowOf = (row: ExcelJS.Row): SheetRow => {
    const cells: CellValue[] = []
    const noFormulaValue: number[] = []
    const last = Math.max(CARRIER_SHEET_COLUMNS.length, row.cellCount)
    for (let c = 1; c <= last; c++) {
      const cell = row.getCell(c)
      if (formulaWithoutValue(cell.value)) noFormulaValue.push(c - 1)
      cells.push(cellOf(cell))
    }
    return { row: row.number, cells, ...(row.hidden ? { hidden: true } : {}), ...(noFormulaValue.length ? { noFormulaValue } : {}) }
  }
  const header = rowOf(ws.getRow(1)).cells
  const rows: SheetRow[] = []
  let dataRows = 0
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n === 1) return
    const r = rowOf(row)
    if (!r.noFormulaValue && r.cells.every((c) => c == null)) return
    dataRows++
    if (dataRows <= MAX_CARRIER_ROWS) rows.push(r)
  })
  if (dataRows > MAX_CARRIER_ROWS)
    throw new MaintenanceError(
      `A planilha “${name}” tem ${dataRows.toLocaleString('pt-BR')} linhas com dados (máx. ${MAX_CARRIER_ROWS.toLocaleString('pt-BR')}): não parece a lista de transportadoras do ERP. Se houver fórmulas arrastadas abaixo dos dados, apague essas linhas e salve de novo.`,
    )
  return { header, rows, file: { name, bytes: buf.length, sha256: sha256(buf), sheetName: ws.name } }
}

/** transportadoras atuais, com o que o plano compara */
async function loadCurrentCarriers(exec: Exec = db): Promise<CurrentCarrier[]> {
  return exec
    .select({ id: s.transportCompanies.id, code: s.transportCompanies.code, name: s.transportCompanies.name, active: s.transportCompanies.active })
    .from(s.transportCompanies)
    .orderBy(asc(s.transportCompanies.id))
}

/** quantas transportadoras há (cartão da Manutenção) */
export async function transportCompanyCounts(exec: Exec = db): Promise<CarrierCounts> {
  const r = await exec.execute<{ total: string | number; active: string | number }>(sql`SELECT count(*) AS total, count(*) FILTER (WHERE active) AS active FROM transport_company`)
  const total = Number(r.rows[0]?.total ?? 0)
  const active = Number(r.rows[0]?.active ?? 0)
  return { total, active, inactive: total - active }
}

export interface CarrierImportPreview {
  file: CarrierSheetFile
  /** transportadoras válidas lidas da planilha */
  carriers: ImportedCarrier[]
  errors: SheetIssue[]
  warnings: SheetIssue[]
  sameName: SameNameGroup[]
  nearNames: NearNameGroup[]
  specials: SpecialCarrier[]
  current: CarrierCounts
  plan: CarrierImportPlan
}

/** PRÉVIA (nada é gravado): lê a planilha, valida e calcula o plano contra as transportadoras de agora. */
export async function previewCarrierImport(f: UploadedFile, exec: Exec = db): Promise<CarrierImportPreview> {
  const sheet = await readCarriersXlsx(f)
  const parsed = parseCarrierSheet(sheet.header, sheet.rows)
  const current = await loadCurrentCarriers(exec)
  return {
    file: sheet.file,
    carriers: parsed.carriers,
    errors: parsed.errors,
    warnings: parsed.warnings,
    sameName: parsed.sameName,
    nearNames: parsed.nearNames,
    specials: parsed.specials,
    current: carrierCountsOf(current),
    plan: planCarrierImport(parsed.carriers, current),
  }
}

export interface CarrierApplyResult {
  dryRun: boolean
  inserted: number
  /** transportadoras existentes com o nome atualizado */
  renamed: number
  unchanged: number
  /** nome cortado pelo ERP que no sistema foi completado: mantido */
  keptComplete: number
  /** cadastradas fora da planilha: não tocadas */
  untouched: number
}

/** sentinela para desfazer a transação da simulação levando o resultado */
class Rollback extends Error {
  constructor(readonly result: CarrierApplyResult) {
    super('rollback')
  }
}

const BATCH = 100

/**
 * APLICA a planilha (ATUALIZAR PELO CÓDIGO) numa transação só:
 *  - confere que o arquivo é o MESMO da prévia (sha256) e que não tem erros;
 *  - LOCK TABLE transport_company (ninguém cadastra transportadora enquanto isso);
 *  - cria os códigos novos (ativos), em lotes; nos existentes grava SÓ o nome, e só quando muda (nome cortado
 *    pelo ERP que foi completado no sistema fica); não apaga nada e não toca em contato, telefone, e-mail,
 *    observações nem "ativa". Código que só difere de um atual nos zeros à esquerda/maiúsculas → erro;
 *  - auditoria 'update_transport_companies' com as quantidades, os códigos criados e os nomes alterados (de → para).
 * `dryRun`: faz tudo e desfaz no fim. `exec`: banco ou transação onde rodar (os testes passam um banco simulado).
 */
export async function applyCarrierImport(o: { userId: number; file: UploadedFile; expectedSha256: string; dryRun?: boolean }, exec: Exec = db): Promise<CarrierApplyResult> {
  const fileSha = sha256(o.file.buf)
  if (fileSha !== o.expectedSha256) throw new MaintenanceError('O arquivo enviado não é o mesmo da prévia. Gere a prévia de novo com a planilha que será aplicada.')
  const sheet = await readCarriersXlsx(o.file)
  const parsed = parseCarrierSheet(sheet.header, sheet.rows)
  if (parsed.errors.length) throw new MaintenanceError(`A planilha tem ${parsed.errors.length} erro(s) (veja a prévia). Corrija e gere a prévia de novo.`)
  if (!parsed.carriers.length) throw new MaintenanceError('A planilha não tem transportadoras.')
  const dryRun = Boolean(o.dryRun)
  try {
    return await (exec as typeof db).transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE transport_company IN SHARE ROW EXCLUSIVE MODE`)
      const current = await loadCurrentCarriers(tx)
      const plan = planCarrierImport(parsed.carriers, current)
      if (plan.nearCodes.length) throw new MaintenanceError(nearCarrierCodeMessage(plan.nearCodes))

      const now = new Date()
      const bySheetCode = new Map(parsed.carriers.map((c) => [c.code, c]))
      const toInsert = plan.insertCodes.map((code) => bySheetCode.get(code)!)
      for (let i = 0; i < toInsert.length; i += BATCH)
        await tx.insert(s.transportCompanies).values(toInsert.slice(i, i + BATCH).map((c) => ({ code: c.code, name: c.name, active: true, createdBy: o.userId, updatedBy: o.userId, createdAt: now, updatedAt: now })))
      // só o nome (o código é o mesmo: a transportadora foi achada por ele)
      for (const r of plan.renames) await tx.update(s.transportCompanies).set({ name: r.para, updatedBy: o.userId, updatedAt: now }).where(eq(s.transportCompanies.id, r.id))

      const result: CarrierApplyResult = { dryRun, inserted: plan.toInsert, renamed: plan.toRename, unchanged: plan.unchanged, keptComplete: plan.keptComplete.length, untouched: plan.notInSheet.length }
      await tx.insert(s.auditLog).values({
        entity: 'maintenance',
        entityId: null,
        action: 'update_transport_companies',
        userId: o.userId,
        diff: {
          mode: 'update',
          file: { name: o.file.name, sha256: fileSha, bytes: o.file.buf.length, rows: parsed.carriers.length },
          before: carrierCountsOf(current),
          counts: { inserted: result.inserted, renamed: result.renamed, unchanged: result.unchanged, keptComplete: result.keptComplete, untouched: result.untouched },
          created: plan.insertCodes,
          changes: plan.renames.map((r) => ({ id: r.id, code: r.code, name: { de: r.de, para: r.para } })),
          keptComplete: plan.keptComplete.map((k) => ({ id: k.id, code: k.code, sheetName: k.sheetName })),
        },
      })
      if (dryRun) throw new Rollback(result)
      return result
    })
  } catch (e) {
    if (e instanceof Rollback) return e.result
    throw e
  }
}
