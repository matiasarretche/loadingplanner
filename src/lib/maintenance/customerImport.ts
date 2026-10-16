import 'server-only'
import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import { asc, eq, sql } from 'drizzle-orm'
import { db, schema as s } from '@/db'
import { rawCell } from '@/lib/catalogImport/readSheets'
import {
  type CellValue,
  type CurrentCustomer,
  CUSTOMER_SHEET_COLUMNS,
  type CustomerCounts,
  type CustomerData,
  type CustomerImportMode,
  type CustomerImportPlan,
  customerValues,
  type ImportedCustomer,
  leadingZeroMessage,
  MAX_CUSTOMER_ROWS,
  parseCustomerSheet,
  planCustomerImport,
  type SheetIssue,
  type SheetRow,
  zeroPaddedText,
} from '@/domain/customerImport'
import { assertCustomersBackup, customerCounts } from './customersBackup'
import { MaintenanceError } from './deleteAllLoads'
import type { Exec } from './loadsBackup'

export interface UploadedFile {
  name: string
  buf: Buffer
}

export interface CustomerSheetFile {
  name: string
  bytes: number
  sha256: string
  sheetName: string
}

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex')

/** fórmula sem resultado no arquivo (o ExcelJS lê igual uma fórmula nunca calculada e uma com resultado "") */
const formulaWithoutValue = (v: unknown) => typeof v === 'object' && v !== null && ('formula' in v || 'sharedFormula' in v) && (v as { result?: unknown }).result === undefined

/**
 * Lê a PRIMEIRA aba do .xlsx: linha 1 = cabeçalho; as outras linhas com algum valor = dados (células da
 * coluna A em diante, como texto/número cru). Arquivo pequeno (a carteira tem ~250 linhas), lido inteiro.
 *  - número inteiro com formato de zeros ("00000", "00000-000"…) vira o texto que o Excel mostra (CEP 02134);
 *  - marca as linhas ocultas/filtradas e as fórmulas sem valor salvo (o parse transforma em erro);
 *  - linha só com espaços ou texto vazio não é dado; mais de MAX_CUSTOMER_ROWS linhas com dados → erro (nada
 *    é cortado em silêncio).
 */
export async function readCustomersXlsx(f: UploadedFile): Promise<{ header: CellValue[]; rows: SheetRow[]; file: CustomerSheetFile }> {
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
    const last = Math.max(CUSTOMER_SHEET_COLUMNS.length, row.cellCount)
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
    if (dataRows <= MAX_CUSTOMER_ROWS) rows.push(r)
  })
  if (dataRows > MAX_CUSTOMER_ROWS)
    throw new MaintenanceError(
      `A planilha “${name}” tem ${dataRows.toLocaleString('pt-BR')} linhas com dados (máx. ${MAX_CUSTOMER_ROWS.toLocaleString('pt-BR')}): não parece a carteira de clientes. Se houver fórmulas arrastadas abaixo dos clientes, apague essas linhas e salve de novo.`,
    )
  return { header, rows, file: { name, bytes: buf.length, sha256: sha256(buf), sheetName: ws.name } }
}

/** clientes atuais, com o que o plano compara */
async function loadCurrentCustomers(exec: Exec = db): Promise<CurrentCustomer[]> {
  return exec
    .select({
      id: s.customers.id,
      code: s.customers.code,
      name: s.customers.name,
      address: s.customers.address,
      addressComplement: s.customers.addressComplement,
      district: s.customers.district,
      city: s.customers.city,
      state: s.customers.state,
      postalCode: s.customers.postalCode,
      country: s.customers.country,
      taxId: s.customers.taxId,
      notes: s.customers.notes,
      agentId: s.customers.agentId,
      active: s.customers.active,
    })
    .from(s.customers)
    .orderBy(asc(s.customers.id))
}

async function shipmentCount(exec: Exec = db): Promise<number> {
  const r = await exec.execute<{ n: string | number }>(sql`SELECT count(*) AS n FROM shipment`)
  return Number(r.rows[0]?.n ?? 0)
}

export interface CustomerImportPreview {
  file: CustomerSheetFile
  /** clientes válidos lidos da planilha */
  customers: ImportedCustomer[]
  errors: SheetIssue[]
  warnings: SheetIssue[]
  current: CustomerCounts
  /** pedidos no sistema: com algum, SUBSTITUIR fica bloqueado (é preciso excluir as cargas antes) */
  shipments: number
  plan: CustomerImportPlan
}

/** PRÉVIA (nada é gravado): lê a planilha, valida e calcula o plano dos dois modos contra os clientes de agora. */
export async function previewCustomerImport(f: UploadedFile): Promise<CustomerImportPreview> {
  const sheet = await readCustomersXlsx(f)
  const parsed = parseCustomerSheet(sheet.header, sheet.rows)
  const [current, counts, shipments] = await Promise.all([loadCurrentCustomers(), customerCounts(), shipmentCount()])
  return { file: sheet.file, customers: parsed.customers, errors: parsed.errors, warnings: parsed.warnings, current: counts, shipments, plan: planCustomerImport(parsed.customers, current) }
}

export interface CustomerApplyResult {
  mode: CustomerImportMode
  dryRun: boolean
  /** clientes apagados (só SUBSTITUIR) */
  deleted: number
  inserted: number
  updated: number
  unchanged: number
  /** clientes atuais não tocados (ATUALIZAR: sem código ou fora da planilha) */
  untouched: number
  /** o backup foi conferido (sempre na aplicação; na simulação, só se o backup já foi baixado) */
  backupChecked: boolean
}

/** sentinela para desfazer a transação da simulação levando o resultado */
class Rollback extends Error {
  constructor(readonly result: CustomerApplyResult) {
    super('rollback')
  }
}

const BATCH = 100

/**
 * APLICA a planilha numa transação só:
 *  - confere que o arquivo é o MESMO da prévia (sha256) e que não tem erros;
 *  - LOCK TABLE customer, shipment (ninguém cria cliente nem pedido enquanto isso);
 *  - exige o backup dos clientes (mesmo usuário, até 60 min, nada alterado depois) — na simulação, só se veio;
 *  - SUBSTITUIR: com qualquer pedido no sistema → erro; senão apaga TODOS os clientes e cria os da planilha
 *    (a sequência de id NÃO volta a 1: os ids antigos da auditoria e do backup continuam únicos);
 *  - ATUALIZAR PELO CÓDIGO: cria os códigos novos e grava nos códigos existentes SÓ os campos que mudam
 *    (Observações vazias na planilha mantêm as do sistema); não apaga nada e não toca nos clientes sem código
 *    (nem no agente e no "ativo" de ninguém). Código que só difere de um atual nos zeros à esquerda → erro;
 *  - auditoria 'replace_customers' / 'update_customers' com as quantidades e, ao atualizar, os códigos
 *    criados e os campos alterados de cada cliente (de → para).
 * Agentes, preços, catálogo e configurações não são tocados. `dryRun`: faz tudo e desfaz no fim.
 * `exec`: banco ou transação onde rodar (os testes passam um banco simulado).
 */
export async function applyCustomerImport(
  o: { userId: number; file: UploadedFile; expectedSha256: string; mode: CustomerImportMode; backupSha256: string | null; dryRun?: boolean },
  exec: Exec = db,
): Promise<CustomerApplyResult> {
  const fileSha = sha256(o.file.buf)
  if (fileSha !== o.expectedSha256) throw new MaintenanceError('O arquivo enviado não é o mesmo da prévia. Gere a prévia de novo com a planilha que será aplicada.')
  const sheet = await readCustomersXlsx(o.file)
  const parsed = parseCustomerSheet(sheet.header, sheet.rows)
  if (parsed.errors.length) throw new MaintenanceError(`A planilha tem ${parsed.errors.length} erro(s) (veja a prévia). Corrija e gere a prévia de novo.`)
  if (!parsed.customers.length) throw new MaintenanceError('A planilha não tem clientes.')
  const dryRun = Boolean(o.dryRun)
  try {
    return await (exec as typeof db).transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE customer, shipment IN SHARE ROW EXCLUSIVE MODE`)
      let before: CustomerCounts
      const backupChecked = !dryRun || Boolean(o.backupSha256)
      if (backupChecked) {
        if (!o.backupSha256) throw new MaintenanceError('Baixe o backup dos clientes atuais antes de aplicar.')
        before = await assertCustomersBackup(tx, o.userId, o.backupSha256)
      } else before = await customerCounts(tx)

      const now = new Date()
      const stamp = { createdBy: o.userId, updatedBy: o.userId, createdAt: now, updatedAt: now }
      const insertAll = async (list: ImportedCustomer[]) => {
        for (let i = 0; i < list.length; i += BATCH) await tx.insert(s.customers).values(list.slice(i, i + BATCH).map((c) => ({ ...customerValues(c), ...stamp })))
      }

      let result: CustomerApplyResult
      /** detalhes do modo atualizar para a auditoria */
      let details: Record<string, unknown> = {}
      if (o.mode === 'replace') {
        const shipments = await shipmentCount(tx)
        if (shipments > 0) throw new MaintenanceError(`Há ${shipments.toLocaleString('pt-BR')} pedido(s) no sistema, ligados aos clientes atuais. Exclua antes todas as cargas (botão acima).`)
        const deleted = await tx.delete(s.customers).returning({ id: s.customers.id })
        await insertAll(parsed.customers)
        result = { mode: 'replace', dryRun, deleted: deleted.length, inserted: parsed.customers.length, updated: 0, unchanged: 0, untouched: 0, backupChecked }
      } else {
        const current = await loadCurrentCustomers(tx)
        const plan = planCustomerImport(parsed.customers, current).update
        if (plan.leadingZeroCodes.length) throw new MaintenanceError(leadingZeroMessage(plan.leadingZeroCodes))
        const bySheetCode = new Map(parsed.customers.map((c) => [c.code, c]))
        await insertAll(plan.insertCodes.map((code) => bySheetCode.get(code)!))
        // só os campos que mudam (o código é o mesmo: o cliente foi achado por ele); Observações vazias não entram
        for (const ch of plan.changes) {
          const sheetValues = customerValues(bySheetCode.get(ch.code)!)
          const changed = Object.fromEntries(ch.fields.map((f) => [f, sheetValues[f]])) as Partial<CustomerData>
          await tx
            .update(s.customers)
            .set({ ...changed, updatedBy: o.userId, updatedAt: now })
            .where(eq(s.customers.id, ch.id))
        }
        result = { mode: 'update', dryRun, deleted: 0, inserted: plan.toInsert, updated: plan.toUpdate, unchanged: plan.unchanged, untouched: plan.withoutCode + plan.notInSheet, backupChecked }
        details = { created: plan.insertCodes, changes: plan.changes.map((c) => ({ id: c.id, code: c.code, fields: c.diff })) }
      }

      await tx.insert(s.auditLog).values({
        entity: 'maintenance',
        entityId: null,
        action: o.mode === 'replace' ? 'replace_customers' : 'update_customers',
        userId: o.userId,
        diff: {
          mode: o.mode,
          file: { name: o.file.name, sha256: fileSha, bytes: o.file.buf.length, rows: parsed.customers.length },
          before,
          counts: { deleted: result.deleted, inserted: result.inserted, updated: result.updated, unchanged: result.unchanged, untouched: result.untouched },
          backupSha256: o.backupSha256,
          ...details,
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
