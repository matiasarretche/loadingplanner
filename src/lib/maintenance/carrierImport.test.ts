import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { getTableColumns, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { CARRIER_SHEET_COLUMNS, type CellValue, parseCarrierSheet } from '@/domain/carrierImport'

// BANCO SIMULADO em memória (fakeDb, abaixo): '@/db' devolve o banco simulado do teste atual + o esquema real
const holder = vi.hoisted(() => ({ db: {} as object }))
vi.mock('server-only', () => ({}))
vi.mock('@/db', async () => ({
  db: new Proxy({}, { get: (_t, k) => (holder.db as Record<PropertyKey, unknown>)[k] }),
  schema: await vi.importActual('@/db/schema'),
}))

const { schema: s } = await import('@/db')
const { applyCarrierImport, previewCarrierImport, readCarriersXlsx, transportCompanyCounts } = await import('./carrierImport')
const { MaintenanceError } = await import('./deleteAllLoads')
type Exec = import('./loadsBackup').Exec

const HEAD = CARRIER_SHEET_COLUMNS.map((c) => c.header)
const USER = 5
const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex')
/** formato do código na planilha real do ERP (número azul, sem zeros) */
const ERP_CODE_FMT = '[Blue]###########0;[Red]-###########0'

async function xlsx(build: (ws: ExcelJS.Worksheet) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Planilha')
  build(ws)
  wb.addWorksheet('Outra').addRow(['Código', 'x'])
  return Buffer.from(await wb.xlsx.writeBuffer())
}

/** planilha com o cabeçalho do ERP e estas linhas (a partir da linha 2) */
const sheet = (...list: CellValue[][]) =>
  xlsx((ws) => {
    ws.addRow(HEAD)
    for (const r of list) {
      const row = ws.addRow(r)
      if (typeof r[0] === 'number') row.getCell(1).numFmt = ERP_CODE_FMT
    }
  })

// ---------------------------------------------------------------------------
// Banco simulado: só o que a importação das transportadoras usa (transport_company, audit_log, LOCK, contagem)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>
type Table = typeof s.transportCompanies | typeof s.auditLog
interface Store {
  carriers: Row[]
  audit: Row[]
  nextId: number
  nextAuditId: number
}

const dialect = new PgDialect()
const columnsOf = (t: Table) => getTableColumns(t) as Record<string, { name: string }>
const propOf = (t: Table, col: unknown) => Object.entries(columnsOf(t)).find(([, c]) => c === col)?.[0] ?? ''
const project = (t: Table, fields: Record<string, unknown> | undefined, r: Row) => (fields ? Object.fromEntries(Object.entries(fields).map(([k, col]) => [k, r[propOf(t, col)]])) : { ...r })

/** WHERE do drizzle → filtro em memória (só a forma usada: coluna = valor) */
function matcher(t: Table, where: SQL | undefined): (r: Row) => boolean {
  if (!where) return () => true
  const { sql: text, params } = dialect.sqlToQuery(where)
  const m = /^"\w+"\."(\w+)" = \$(\d+)$/.exec(text)
  if (!m) throw new Error(`condição não simulada: ${text}`)
  const byName = new Map(Object.entries(columnsOf(t)).map(([prop, c]) => [c.name, prop]))
  const p = byName.get(m[1]) ?? `?${m[1]}`
  const v = params[Number(m[2]) - 1]
  return (r) => r[p] === v
}

function fakeDb() {
  let st: Store = { carriers: [], audit: [], nextId: 1, nextAuditId: 1 }
  /** ordem das operações (a trava vem antes de tudo; "rollback" quando a transação é desfeita) */
  const ops: string[] = []
  /** cada UPDATE de transportadora com o SET enviado */
  const updates: { id: number; set: Row }[] = []
  /** tamanho de cada INSERT de transportadoras (lotes) */
  const insertSizes: number[] = []
  const blank = () => ({ ...Object.fromEntries(Object.keys(columnsOf(s.transportCompanies)).map((k) => [k, null])), active: true })
  const listOf = (t: Table): 'carriers' | 'audit' => {
    if (t === s.transportCompanies) return 'carriers'
    if (t === s.auditLog) return 'audit'
    throw new Error('tabela não simulada')
  }

  const select = (fields?: Record<string, unknown>) => ({
    from: (t: Table) => {
      let where: SQL | undefined
      const run = () => st[listOf(t)].filter(matcher(t, where)).map((r) => project(t, fields, r))
      const q = {
        where: (w: SQL) => ((where = w), q),
        orderBy: () => q,
        then: (ok: (v: Row[]) => unknown, ko: (e: unknown) => unknown) => new Promise<Row[]>((res) => res(run())).then(ok, ko),
      }
      return q
    },
  })
  const insert = (t: Table) => ({
    values: async (v: Row | Row[]) => {
      const name = listOf(t)
      const list = Array.isArray(v) ? v : [v]
      ops.push(`insert ${name}`)
      if (name === 'carriers') insertSizes.push(list.length)
      for (const x of list) {
        if (name === 'audit') {
          st.audit.push({ entityId: null, diff: null, userId: null, ...x, id: st.nextAuditId++, at: new Date() })
          continue
        }
        if (st.carriers.some((c) => c.code === x.code)) throw new Error('duplicate key value violates unique constraint "transport_company_code_unique"')
        st.carriers.push({ ...blank(), ...x, id: st.nextId++ })
      }
    },
  })
  const update = (t: Table) => ({
    set: (v: Row) => ({
      where: async (w: SQL) => {
        const name = listOf(t)
        ops.push(`update ${name}`)
        const m = matcher(t, w)
        for (const r of st[name])
          if (m(r)) {
            Object.assign(r, v)
            updates.push({ id: r.id as number, set: v })
          }
      },
    }),
  })
  const execute = async (q: SQL) => {
    const text = dialect.sqlToQuery(q).sql.replace(/\s+/g, ' ').trim()
    if (text.startsWith('LOCK TABLE')) {
      ops.push(text)
      return { rows: [] }
    }
    if (/FROM transport_company$/.test(text)) return { rows: [{ total: String(st.carriers.length), active: String(st.carriers.filter((c) => c.active).length) }] }
    throw new Error(`SQL não simulado: ${text}`)
  }
  const transaction = async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const snapshot = structuredClone(st)
    try {
      return await fn(db)
    } catch (e) {
      st = snapshot
      ops.push('rollback')
      throw e
    }
  }
  const db = { select, insert, update, execute, transaction }
  holder.db = db
  return {
    db: db as unknown as Exec,
    ops,
    updates,
    insertSizes,
    get state() {
      return st
    },
  }
}
type Fake = ReturnType<typeof fakeDb>

/** transportadoras iniciais (pelo próprio banco simulado: ids 1, 2, …) */
async function seed(f: Fake, ...list: Row[]) {
  await (f.db as unknown as { insert: (t: Table) => { values: (v: Row[]) => Promise<void> } }).insert(s.transportCompanies).values(list)
  f.ops.length = 0
  f.insertSizes.length = 0
}

const apply = (f: Fake, buf: Buffer, o: { dryRun?: boolean; expectedSha256?: string } = {}) =>
  applyCarrierImport({ userId: USER, file: { name: 'transportadoras.xlsx', buf }, expectedSha256: o.expectedSha256 ?? sha256(buf), dryRun: o.dryRun }, f.db)

// ---------------------------------------------------------------------------

describe('readCarriersXlsx', () => {
  it('lê a primeira aba como o ERP grava: código numérico com formato azul vira texto, coluna C vazia, espaços repetidos', async () => {
    const buf = await xlsx((ws) => {
      ws.addRow(['Código', 'Descr.transportador'])
      ws.getCell('C1').numFmt = '@' // coluna C só com formatação
      ws.addRow([12, 'RAPIDO  TRANSPAULO LTDA']).getCell(1).numFmt = ERP_CODE_FMT
      ws.addRow([])
      ws.getRow(4).values = [999, { richText: [{ text: 'A ' }, { text: 'DEFINIR' }] }]
      ws.getRow(5).values = ['  ', ' '] // só espaços: não é linha de dados
      ws.addRow([7, 'zeros']).getCell(1).numFmt = '000'
    })
    const r = await readCarriersXlsx({ name: 'transportadoras.xlsx', buf })
    expect(r.file).toMatchObject({ name: 'transportadoras.xlsx', sheetName: 'Planilha', bytes: buf.length })
    expect(r.file.sha256).toBe(sha256(buf))
    expect(r.rows.map((x) => x.row)).toEqual([2, 4, 6])
    const p = parseCarrierSheet(r.header, r.rows)
    expect(p.errors).toEqual([])
    expect(p.carriers.map((c) => [c.row, c.code, c.name])).toEqual([
      [2, '12', 'RAPIDO TRANSPAULO LTDA'],
      [4, '999', 'A DEFINIR'],
      [6, '007', 'zeros'],
    ])
  })

  it('linha oculta, erro do Excel e fórmula sem valor salvo → erros na prévia; a prévia não grava nada', async () => {
    const buf = await xlsx((ws) => {
      ws.addRow(HEAD)
      ws.addRow([1, 'ACME'])
      ws.addRow([2, 'FILTRADA'])
      ws.getRow(3).hidden = true
      ws.addRow([3, null])
      ws.getCell('B4').value = { formula: 'VLOOKUP(A4,ERP!A:B,2,0)', result: { error: '#N/A' } }
      ws.addRow([4, null])
      ws.getCell('B5').value = { formula: 'ERP!B9' } // nunca calculada
    })
    const f = fakeDb()
    await seed(f, { code: '1', name: 'ACME' })
    const prev = await previewCarrierImport({ name: 't.xlsx', buf }, f.db)
    expect(prev.errors).toEqual([
      { rows: [4], message: expect.stringMatching(/^Erro do Excel \(#N\/A\) em “Descr\.transportador”/) },
      { rows: [5], message: expect.stringMatching(/^Fórmula sem valor salvo em “Descr\.transportador”/) },
      { rows: [3], message: expect.stringMatching(/^1 linha\(s\) oculta\(s\)/) },
    ])
    expect(prev.current).toEqual({ total: 1, active: 1, inactive: 0 })
    expect(prev.plan).toMatchObject({ toInsert: 0, unchanged: 1 })
    expect(f.ops).toEqual([])
    await expect(apply(f, buf)).rejects.toThrow(/3 erro\(s\)/)
    expect(f.ops).toEqual([])
  })

  it('mais linhas com dados que o limite → erro claro; arquivo que não é .xlsx → MaintenanceError', async () => {
    const many = await xlsx((ws) => {
      ws.addRow(HEAD)
      for (let i = 1; i <= 5001; i++) ws.addRow([i, `T ${i}`])
    })
    await expect(readCarriersXlsx({ name: 'grande.xlsx', buf: many })).rejects.toThrow(/5\.001 linhas com dados \(máx\. 5\.000\)/)
    await expect(readCarriersXlsx({ name: 't.csv', buf: Buffer.from('Código;Descr.transportador\n1;x') })).rejects.toBeInstanceOf(MaintenanceError)
  }, 30_000)

  it('transportCompanyCounts conta ativas e inativas', async () => {
    const f = fakeDb()
    await seed(f, { code: '1', name: 'A' }, { code: '2', name: 'B', active: false })
    await expect(transportCompanyCounts(f.db)).resolves.toEqual({ total: 2, active: 1, inactive: 1 })
  })
})

describe('applyCarrierImport (banco simulado)', () => {
  it('arquivo diferente do da prévia → erro antes de tocar no banco', async () => {
    const f = fakeDb()
    await expect(apply(f, await sheet([1, 'ACME']), { expectedSha256: 'c'.repeat(64) })).rejects.toThrow(/não é o mesmo da prévia/)
    expect(f.ops).toEqual([])
  })

  it('banco vazio: cria TODAS (filiais com o mesmo nome incluídas), ativas, em lotes de 100, e audita', async () => {
    const f = fakeDb()
    const list: CellValue[][] = Array.from({ length: 250 }, (_, i) => [i + 1, i < 8 ? 'RAPIDO TRANSPAULO LTDA' : `TRANSP ${i + 1}`])
    const buf = await sheet(...list)
    const r = await apply(f, buf)
    expect(r).toEqual({ dryRun: false, inserted: 250, renamed: 0, unchanged: 0, keptComplete: 0, untouched: 0 })
    expect(f.ops[0]).toBe('LOCK TABLE transport_company IN SHARE ROW EXCLUSIVE MODE')
    expect(f.insertSizes).toEqual([100, 100, 50])
    expect(f.state.carriers).toHaveLength(250)
    expect(f.state.carriers.filter((c) => c.name === 'RAPIDO TRANSPAULO LTDA').map((c) => c.code)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8'])
    expect(f.state.carriers[0]).toMatchObject({ code: '1', active: true, contact: null, createdBy: USER, updatedBy: USER })
    const audit = f.state.audit.at(-1)!
    expect(audit).toMatchObject({
      entity: 'maintenance',
      entityId: null,
      action: 'update_transport_companies',
      userId: USER,
      diff: { mode: 'update', file: { name: 'transportadoras.xlsx', sha256: sha256(buf), rows: 250 }, before: { total: 0, active: 0, inactive: 0 }, counts: { inserted: 250, renamed: 0 }, changes: [] },
    })
    expect((audit.diff as { created: string[] }).created).toHaveLength(250)
  })

  it('ATUALIZAR: só o nome muda; contato/telefone/e-mail/observações/ativa intactos; nada apagado; audita de → para', async () => {
    const f = fakeDb()
    const contact = { contact: 'João', phone: '51 9999', email: 'x@y.com', notes: 'filial Caxias' }
    await seed(
      f,
      { code: '12', name: 'RAPIDO TRANSPAULO', ...contact, active: false },
      { code: '52', name: 'PLIMOR' },
      { code: '422', name: 'Intermodal Transportes e Logística Ltda' },
      { code: 'X1', name: 'Cadastrada à mão' },
    )
    const untouched = structuredClone(f.state.carriers.slice(1))
    const buf = await sheet([12, 'RAPIDO TRANSPAULO LTDA'], [52, 'PLIMOR'], [422, 'Intermodal Transportes e Logísti'], [900, 'NOVA'])
    const r = await apply(f, buf)
    expect(r).toEqual({ dryRun: false, inserted: 1, renamed: 1, unchanged: 1, keptComplete: 1, untouched: 1 })
    expect(f.state.carriers[0]).toMatchObject({ id: 1, code: '12', name: 'RAPIDO TRANSPAULO LTDA', ...contact, active: false, updatedBy: USER })
    expect(f.updates.map((u) => [u.id, Object.keys(u.set).sort()])).toEqual([[1, ['name', 'updatedAt', 'updatedBy']]])
    expect(f.state.carriers.slice(1, 4)).toEqual(untouched)
    expect(f.state.carriers.find((c) => c.code === '900')).toMatchObject({ id: 5, name: 'NOVA', active: true })
    expect(f.state.audit.at(-1)!.diff).toMatchObject({
      before: { total: 4, active: 3, inactive: 1 },
      counts: { inserted: 1, renamed: 1, unchanged: 1, keptComplete: 1, untouched: 1 },
      created: ['900'],
      changes: [{ id: 1, code: '12', name: { de: 'RAPIDO TRANSPAULO', para: 'RAPIDO TRANSPAULO LTDA' } }],
      keptComplete: [{ id: 3, code: '422', sheetName: 'Intermodal Transportes e Logísti' }],
    })
  })

  it('simulação: faz tudo e desfaz (nada gravado, sem auditoria)', async () => {
    const f = fakeDb()
    await seed(f, { code: '1', name: 'ANTIGA' })
    const before = structuredClone(f.state)
    const r = await apply(f, await sheet([1, 'NOVO NOME'], [2, 'NOVA']), { dryRun: true })
    expect(r).toEqual({ dryRun: true, inserted: 1, renamed: 1, unchanged: 0, keptComplete: 0, untouched: 0 })
    expect(f.state).toEqual(before)
    expect(f.ops).toContain('rollback')
  })

  it('código que só difere nos zeros à esquerda de um atual → erro, nada gravado (com o formato de zeros, casa)', async () => {
    const f = fakeDb()
    await seed(f, { code: '012', name: 'ACME' })
    const before = structuredClone(f.state)
    await expect(apply(f, await sheet([12, 'ACME LTDA']))).rejects.toThrow(/zeros à esquerda ou em maiúsculas: 12 \(linha 2\) × 012 no sistema/)
    expect(f.state).toEqual(before)
    expect(f.ops).toEqual(['LOCK TABLE transport_company IN SHARE ROW EXCLUSIVE MODE', 'rollback'])

    const padded = await xlsx((ws) => {
      ws.addRow(HEAD)
      ws.addRow([12, 'ACME LTDA']).getCell(1).numFmt = '000'
    })
    await expect(apply(f, padded)).resolves.toMatchObject({ inserted: 0, renamed: 1 })
    expect(f.state.carriers).toEqual([expect.objectContaining({ id: 1, code: '012', name: 'ACME LTDA' })])
  })
})
