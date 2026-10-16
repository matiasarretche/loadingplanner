import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { getTableColumns, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { type CellValue, CUSTOMER_SHEET_COLUMNS, parseCustomerSheet } from '@/domain/customerImport'

// BANCO SIMULADO em memória (fakeDb, abaixo): '@/db' devolve o banco simulado do teste atual + o esquema real
const holder = vi.hoisted(() => ({ db: {} as object }))
vi.mock('server-only', () => ({}))
vi.mock('@/db', async () => ({
  db: new Proxy({}, { get: (_t, k) => (holder.db as Record<PropertyKey, unknown>)[k] }),
  schema: await vi.importActual('@/db/schema'),
}))

const { schema: s } = await import('@/db')
const { applyCustomerImport, previewCustomerImport, readCustomersXlsx } = await import('./customerImport')
const { assertCustomersBackup, customerCounts, customerFingerprint, CUSTOMERS_BACKUP_ACTION } = await import('./customersBackup')
const { MaintenanceError } = await import('./deleteAllLoads')
type Exec = import('./loadsBackup').Exec

const HEAD = CUSTOMER_SHEET_COLUMNS.map((c) => c.header)
const USER = 5
const BACKUP_SHA = 'b'.repeat(64)
const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex')

async function xlsx(build: (ws: ExcelJS.Worksheet) => void, o: { first?: string } = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(o.first ?? 'Clientes')
  build(ws)
  wb.addWorksheet('Outra').addRow(['Código', 'x'])
  return Buffer.from(await wb.xlsx.writeBuffer())
}

/** planilha com o cabeçalho do modelo e estas linhas (a partir da linha 2) */
const sheet = (...list: CellValue[][]) =>
  xlsx((ws) => {
    ws.addRow(HEAD)
    for (const r of list) ws.addRow(r)
  })

/** linha da planilha: Código, Razão social, Endereço, Complemento, Bairro, Cidade, Estado, CEP, País, ID fiscal, Obs. */
const line = (code: CellValue, name: string, o: { city?: string; taxId?: string | null; notes?: string | null } = {}): CellValue[] => [
  code,
  name,
  'Camino del Jefe 2520',
  null,
  null,
  o.city ?? 'Montevideo',
  null,
  null,
  'Uruguai',
  o.taxId ?? null,
  o.notes ?? null,
]

// ---------------------------------------------------------------------------
// Banco simulado: só o que a importação dos clientes usa (customer, audit_log e as consultas SQL cruas)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>
type Table = typeof s.customers | typeof s.auditLog
interface Store {
  customers: Row[]
  audit: Row[]
  shipments: number
  nextCustomerId: number
  nextAuditId: number
}

const dialect = new PgDialect()
const columnsOf = (t: Table) => getTableColumns(t) as Record<string, { name: string }>
const propOf = (t: Table, col: unknown) => Object.entries(columnsOf(t)).find(([, c]) => c === col)?.[0] ?? ''
const project = (t: Table, fields: Record<string, unknown> | undefined, r: Row) => (fields ? Object.fromEntries(Object.entries(fields).map(([k, col]) => [k, r[propOf(t, col)]])) : { ...r })

/** WHERE do drizzle → filtro em memória (só as formas usadas: coluna = valor, at > now() - N min, diff->>'x' = valor) */
function matcher(t: Table, where: SQL | undefined): (r: Row) => boolean {
  if (!where) return () => true
  const { sql: text, params } = dialect.sqlToQuery(where)
  const byName = new Map(Object.entries(columnsOf(t)).map(([prop, c]) => [c.name, prop]))
  const prop = (name: string) => byName.get(name) ?? `?${name}`
  const param = (i: string) => params[Number(i) - 1]
  const tests = text
    .replace(/^\(([\s\S]*)\)$/, '$1')
    .split(' and ')
    .map((part): ((r: Row) => boolean) => {
      let m = /^"\w+"\."(\w+)" = \$(\d+)$/.exec(part)
      if (m) {
        const [p, v] = [prop(m[1]), param(m[2])]
        return (r) => r[p] === v
      }
      m = /^"\w+"\."(\w+)" > now\(\) - make_interval\(mins => \$(\d+)\)$/.exec(part)
      if (m) {
        const [p, mins] = [prop(m[1]), Number(param(m[2]))]
        return (r) => (r[p] as Date).getTime() > Date.now() - mins * 60_000
      }
      m = /^"\w+"\."(\w+)"->>'(\w+)' = \$(\d+)$/.exec(part)
      if (m) {
        const [p, key, v] = [prop(m[1]), m[2], param(m[3])]
        return (r) => (r[p] as Row | null)?.[key] === v
      }
      throw new Error(`condição não simulada: ${part}`)
    })
  return (r) => tests.every((f) => f(r))
}

function fakeDb() {
  let st: Store = { customers: [], audit: [], shipments: 0, nextCustomerId: 1, nextAuditId: 1 }
  /** ordem das operações (a trava vem antes de tudo; "rollback" quando a transação é desfeita) */
  const ops: string[] = []
  /** cada UPDATE de cliente com o SET enviado */
  const updates: { id: number; set: Row }[] = []
  const blankCustomer = () => ({ ...Object.fromEntries(Object.keys(columnsOf(s.customers)).map((k) => [k, null])), active: true })
  const listOf = (t: Table): 'customers' | 'audit' => {
    if (t === s.customers) return 'customers'
    if (t === s.auditLog) return 'audit'
    throw new Error('tabela não simulada')
  }

  const select = (fields?: Record<string, unknown>) => ({
    from: (t: Table) => {
      let where: SQL | undefined
      let limit = Infinity
      const run = () => {
        const name = listOf(t)
        let list = st[name].filter(matcher(t, where))
        if (name === 'audit') list = [...list].sort((a, b) => (b.at as Date).getTime() - (a.at as Date).getTime())
        return list.slice(0, limit).map((r) => project(t, fields, r))
      }
      const q = {
        where: (w: SQL) => ((where = w), q),
        orderBy: () => q,
        limit: (n: number) => ((limit = n), q),
        then: (ok: (v: Row[]) => unknown, ko: (e: unknown) => unknown) => new Promise<Row[]>((res) => res(run())).then(ok, ko),
      }
      return q
    },
  })
  const insert = (t: Table) => ({
    values: async (v: Row | Row[]) => {
      const name = listOf(t)
      ops.push(`insert ${name}`)
      for (const x of Array.isArray(v) ? v : [v]) {
        if (name === 'audit') {
          st.audit.push({ entityId: null, diff: null, userId: null, ...x, id: st.nextAuditId++, at: new Date() })
          continue
        }
        if (x.code != null && st.customers.some((c) => c.code === x.code)) throw new Error('duplicate key value violates unique constraint "customer_code_unique"')
        st.customers.push({ ...blankCustomer(), ...x, id: st.nextCustomerId++ })
      }
    },
  })
  const del = (t: Table) => ({
    returning: async (fields: Record<string, unknown>) => {
      const name = listOf(t)
      ops.push(`delete ${name}`)
      const gone = st[name]
      st[name] = []
      return gone.map((r) => project(t, fields, r))
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
      ops.push('lock')
      return { rows: [] }
    }
    if (/FROM shipment$/.test(text)) return { rows: [{ n: String(st.shipments) }] }
    const c = st.customers
    if (text.includes('with_code'))
      return { rows: [{ customers: String(c.length), with_code: String(c.filter((x) => x.code != null).length), with_agent: String(c.filter((x) => x.agentId != null).length), inactive: String(c.filter((x) => !x.active).length) }] }
    if (text.includes('string_agg(md5')) return { rows: [{ fp: createHash('md5').update(JSON.stringify(c)).digest('hex') }] }
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
  const db = { select, insert, delete: del, update, execute, transaction }
  holder.db = db
  return {
    db: db as unknown as Exec,
    ops,
    updates,
    get state() {
      return st
    },
  }
}
type Fake = ReturnType<typeof fakeDb>

/** clientes iniciais (pelo próprio banco simulado: ids 1, 2, …) */
async function seed(f: Fake, ...list: Row[]) {
  await (f.db as unknown as { insert: (t: Table) => { values: (v: Row[]) => Promise<void> } }).insert(s.customers).values(list.map((c) => ({ address: 'Camino del Jefe 2520', city: 'Montevideo', country: 'Uruguai', ...c })))
  f.ops.length = 0
}

/** registra o backup como a rota /clientes/backup (quantidades + impressão digital de agora) */
async function seedBackup(f: Fake, o: { userId?: number; sha?: string; minutesAgo?: number } = {}) {
  const counts = await customerCounts(f.db)
  const fingerprint = await customerFingerprint(f.db)
  await (f.db as unknown as { insert: (t: Table) => { values: (v: Row) => Promise<void> } })
    .insert(s.auditLog)
    .values({ entity: 'maintenance', action: CUSTOMERS_BACKUP_ACTION, userId: o.userId ?? USER, diff: { sha256: o.sha ?? BACKUP_SHA, counts, fingerprint } })
  if (o.minutesAgo) f.state.audit[f.state.audit.length - 1].at = new Date(Date.now() - o.minutesAgo * 60_000)
  f.ops.length = 0
}

const apply = (f: Fake, buf: Buffer, o: { mode?: 'replace' | 'update'; backupSha256?: string | null; dryRun?: boolean; expectedSha256?: string } = {}) =>
  applyCustomerImport(
    { userId: USER, file: { name: 'clientes.xlsx', buf }, expectedSha256: o.expectedSha256 ?? sha256(buf), mode: o.mode ?? 'replace', backupSha256: o.backupSha256 === undefined ? BACKUP_SHA : o.backupSha256, dryRun: o.dryRun },
    f.db,
  )

const auditActions = (f: Fake) => f.state.audit.map((a) => a.action)

// ---------------------------------------------------------------------------

describe('readCustomersXlsx', () => {
  it('lê a primeira aba: cabeçalho, números, rich text, fórmula; pula linhas vazias', async () => {
    const buf = await xlsx((ws) => {
      ws.addRow(HEAD)
      ws.addRow([609, { richText: [{ text: 'HENDERSON ' }, { text: '& CIA' }] }, 'Av. Italia 1234', null, null, 'Montevideo', null, 11300, 'Uruguai', null, null])
      ws.getCell('A4').numFmt = '@' // linha só com formatação
      ws.addRow([])
      ws.getRow(5).values = ['A-7', 'ACME', null, null, null, { formula: '"Sal"&"to"', result: 'Salto' }, null, null, 'Uruguai']
      ws.getRow(6).values = ['   ', '', null, '  '] // só espaços: não é linha de dados
    })
    const r = await readCustomersXlsx({ name: 'clientes.xlsx', buf })
    expect(r.file).toMatchObject({ name: 'clientes.xlsx', sheetName: 'Clientes', bytes: buf.length })
    expect(r.file.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(r.header.slice(0, 11)).toEqual(HEAD)
    expect(r.rows.map((x) => x.row)).toEqual([2, 5])
    const p = parseCustomerSheet(r.header, r.rows)
    expect(p.errors).toEqual([])
    expect(p.customers.map((c) => [c.row, c.code, c.name, c.city, c.postalCode])).toEqual([
      [2, '609', 'HENDERSON & CIA', 'Montevideo', '11300'],
      [5, 'A-7', 'ACME', 'Salto', null],
    ])
  })

  it('número com formato de zeros mantém os zeros à esquerda (código, CEP, ID fiscal)', async () => {
    const buf = await xlsx((ws) => {
      ws.addRow(HEAD)
      ws.addRow([609, 'ACME', 'Rua 1', null, null, 'Boston', 'MA', 2134, 'Estados Unidos', 1234567, null])
      ws.getCell('A2').numFmt = '000000'
      ws.getCell('H2').numFmt = '00000'
      ws.getCell('J2').numFmt = '0000000000'
      ws.addRow([610, 'BETA', 'Rua 2', null, null, 'São Paulo', 'SP', 1310100, 'Brasil', null, null])
      ws.getCell('H3').numFmt = '00000-000'
    })
    const p = parseCustomerSheet(...(await readCustomersXlsx({ name: 'c.xlsx', buf }).then((r) => [r.header, r.rows] as const)))
    expect(p.errors).toEqual([])
    expect(p.customers.map((c) => [c.code, c.postalCode, c.taxId])).toEqual([
      ['000609', '02134', '0001234567'],
      ['610', '01310-100', null],
    ])
    // sem formato de zeros nada chega como número aqui
    expect(p.warnings.filter((w) => /gravado como número/.test(w.message))).toEqual([])
  })

  it('linha oculta/filtrada, erro do Excel e fórmula sem valor salvo → erros na prévia (bloqueiam)', async () => {
    const buf = await xlsx((ws) => {
      ws.addRow(HEAD)
      ws.addRow(line(1, 'ACME'))
      ws.addRow(line(2, 'FILTRADO'))
      ws.getRow(3).hidden = true
      ws.addRow(line(3, 'X'))
      ws.getCell('B4').value = { formula: 'VLOOKUP(A4,ERP!A:B,2,0)', result: { error: '#N/A' } }
      ws.addRow(line(4, 'Y'))
      ws.getCell('F5').value = { error: '#REF!' }
      ws.addRow(line(5, 'Z'))
      ws.getCell('J6').value = { formula: 'ERP!C9' } // nunca calculada (arquivo gerado por programa)
    })
    const f = fakeDb()
    const prev = await previewCustomerImport({ name: 'c.xlsx', buf })
    expect(prev.errors).toEqual([
      { rows: [4], message: expect.stringMatching(/^Erro do Excel \(#N\/A\) em “Razão social”/) },
      { rows: [5], message: expect.stringMatching(/^Erro do Excel \(#REF!\) em “Cidade”/) },
      { rows: [6], message: expect.stringMatching(/^Fórmula sem valor salvo em “ID fiscal”/) },
      { rows: [3], message: expect.stringMatching(/^1 linha\(s\) oculta\(s\) ou filtrada\(s\) no Excel/) },
    ])
    expect(prev.customers.map((c) => c.code)).toEqual(['1'])
    // a prévia não grava nada
    expect(f.ops).toEqual([])
    // a aplicação recusa a mesma planilha
    await seedBackup(f)
    await expect(apply(f, buf)).rejects.toThrow(/4 erro\(s\)/)
  })

  it('mais linhas com dados que o limite → erro claro (nada é cortado em silêncio); linhas só com espaços não contam', async () => {
    const many = await xlsx((ws) => {
      ws.addRow(HEAD)
      ws.addRow(['..', '..']) // descartada no parse, mas conta no limite
      for (let i = 1; i <= 5000; i++) ws.addRow([i, `Cliente ${i}`, null, null, null, null, null, null, 'Uruguai'])
    })
    await expect(readCustomersXlsx({ name: 'grande.xlsx', buf: many })).rejects.toThrow(/5\.001 linhas com dados \(máx\. 5\.000\)/)

    const blanks = await xlsx((ws) => {
      ws.addRow(HEAD)
      ws.addRow(line(1, 'ACME'))
      for (let i = 0; i < 5100; i++) ws.addRow(['  ', ' '])
    })
    const r = await readCustomersXlsx({ name: 'c.xlsx', buf: blanks })
    expect(r.rows.map((x) => x.row)).toEqual([2])
  }, 30_000)

  it('arquivo que não é .xlsx → MaintenanceError', async () => {
    await expect(readCustomersXlsx({ name: 'c.csv', buf: Buffer.from('Código;Razão social\n1;x') })).rejects.toBeInstanceOf(MaintenanceError)
  })
})

describe('applyCustomerImport (banco simulado)', () => {
  it('arquivo diferente do da prévia → erro antes de tocar no banco', async () => {
    const f = fakeDb()
    const buf = await sheet(line(1, 'ACME'))
    await expect(apply(f, buf, { expectedSha256: 'c'.repeat(64) })).rejects.toThrow(/não é o mesmo da prévia/)
    expect(f.ops).toEqual([])
  })

  it('SUBSTITUIR com pedidos no sistema → erro; nenhum cliente apagado e sem auditoria', async () => {
    const f = fakeDb()
    await seed(f, { code: '609', name: 'ACME' }, { code: null, name: 'Sem código' })
    f.state.shipments = 3
    await seedBackup(f)
    const before = structuredClone(f.state.customers)
    await expect(apply(f, await sheet(line(1, 'NOVO')))).rejects.toThrow(/Há 3 pedido\(s\) no sistema/)
    expect(f.state.customers).toEqual(before)
    expect(auditActions(f)).toEqual([CUSTOMERS_BACKUP_ACTION])
    expect(f.ops[0]).toBe('lock')
    expect(f.ops).toContain('rollback')
  })

  it('backup: ausente, de outro usuário, vencido, outro sha256 ou clientes alterados depois → erro e nada gravado', async () => {
    const buf = await sheet(line(1, 'NOVO'))
    const cases: { name: string; prep: (f: Fake) => Promise<void>; backupSha256?: string | null; error: RegExp }[] = [
      { name: 'sem backup', prep: async () => {}, backupSha256: null, error: /Baixe o backup/ },
      { name: 'nunca baixado', prep: async () => {}, error: /Backup dos clientes não encontrado/ },
      { name: 'outro usuário', prep: (f) => seedBackup(f, { userId: 99 }), error: /não encontrado/ },
      { name: 'vencido (61 min)', prep: (f) => seedBackup(f, { minutesAgo: 61 }), error: /não encontrado/ },
      { name: 'outro sha256', prep: (f) => seedBackup(f, { sha: 'd'.repeat(64) }), error: /não encontrado/ },
      {
        name: 'cliente editado depois',
        prep: async (f) => {
          await seedBackup(f)
          f.state.customers[0].notes = 'editado em Cadastros'
        },
        error: /Houve alterações nos clientes desde o backup/,
      },
      {
        name: 'cliente criado depois',
        prep: async (f) => {
          await seedBackup(f)
          await seed(f, { code: null, name: 'Criado em Nova carga' })
        },
        error: /Houve alterações/,
      },
    ]
    for (const c of cases) {
      const f = fakeDb()
      await seed(f, { code: '609', name: 'ACME' })
      await c.prep(f)
      const before = structuredClone(f.state.customers)
      const audits = auditActions(f)
      await expect(apply(f, buf, { backupSha256: c.backupSha256 }), c.name).rejects.toThrow(c.error)
      expect(f.state.customers, c.name).toEqual(before)
      expect(auditActions(f), c.name).toEqual(audits)
    }
  })

  it('assertCustomersBackup: backup válido → devolve as quantidades de agora', async () => {
    const f = fakeDb()
    await seed(f, { code: '609', name: 'ACME', agentId: 7 }, { code: null, name: 'Sem código', active: false })
    await seedBackup(f)
    await expect(assertCustomersBackup(f.db, USER, BACKUP_SHA)).resolves.toEqual({ customers: 2, withCode: 1, withAgent: 1, inactive: 1 })
    await expect(assertCustomersBackup(f.db, USER, 'e'.repeat(64))).rejects.toBeInstanceOf(MaintenanceError)
  })

  it('SUBSTITUIR: apaga todos, cria os da planilha (ids continuam) e audita', async () => {
    const f = fakeDb()
    await seed(f, { code: '609', name: 'ACME', agentId: 7 }, { code: null, name: 'Sem código' })
    await seedBackup(f)
    const buf = await sheet(line(609, 'ACME SA'), line('A-7', 'BETA'))
    const r = await apply(f, buf)
    expect(r).toEqual({ mode: 'replace', dryRun: false, deleted: 2, inserted: 2, updated: 0, unchanged: 0, untouched: 0, backupChecked: true })
    expect(f.ops[0]).toBe('lock')
    expect(f.state.customers.map((c) => [c.id, c.code, c.name, c.agentId, c.createdBy])).toEqual([
      [3, '609', 'ACME SA', null, USER],
      [4, 'A-7', 'BETA', null, USER],
    ])
    const audit = f.state.audit[f.state.audit.length - 1]
    expect(audit).toMatchObject({
      entity: 'maintenance',
      action: 'replace_customers',
      userId: USER,
      diff: {
        mode: 'replace',
        file: { name: 'clientes.xlsx', sha256: sha256(buf), rows: 2 },
        before: { customers: 2, withCode: 1, withAgent: 1, inactive: 0 },
        counts: { deleted: 2, inserted: 2, updated: 0 },
        backupSha256: BACKUP_SHA,
      },
    })
  })

  it('simulação: faz tudo e desfaz (nada gravado, sem auditoria); sem backup não confere', async () => {
    const f = fakeDb()
    await seed(f, { code: '609', name: 'ACME' }, { code: null, name: 'Sem código' })
    const before = structuredClone(f.state)
    const r = await apply(f, await sheet(line(1, 'NOVO')), { dryRun: true, backupSha256: null })
    expect(r).toMatchObject({ mode: 'replace', dryRun: true, deleted: 2, inserted: 1, backupChecked: false })
    expect(f.state).toEqual(before)
    expect(f.ops).toContain('rollback')
  })

  it('ATUALIZAR não apaga: grava só os campos que mudam, Observações vazias ficam, agente/ativo/sem código intactos; audita de → para', async () => {
    const f = fakeDb()
    await seed(
      f,
      { code: '609', name: 'ACME', taxId: 'RUT 1', notes: 'escrita em Cadastros', agentId: 7, active: false },
      { code: null, name: 'Sem código' },
      { code: '700', name: 'Fora da planilha', notes: 'x' },
    )
    await seedBackup(f)
    const untouched = structuredClone(f.state.customers.slice(1))
    // 609: cidade muda, ID fiscal e Observações vazios na planilha; 800: código novo
    const buf = await sheet(line(609, 'ACME', { city: 'Salto' }), line(800, 'NOVO'))
    const r = await apply(f, buf, { mode: 'update' })
    expect(r).toEqual({ mode: 'update', dryRun: false, deleted: 0, inserted: 1, updated: 1, unchanged: 0, untouched: 2, backupChecked: true })

    const acme = f.state.customers.find((c) => c.code === '609')!
    expect(acme).toMatchObject({ id: 1, name: 'ACME', city: 'Salto', taxId: null, notes: 'escrita em Cadastros', agentId: 7, active: false, updatedBy: USER })
    expect(f.updates.map((u) => [u.id, Object.keys(u.set).sort()])).toEqual([[1, ['city', 'taxId', 'updatedAt', 'updatedBy']]])
    expect(f.state.customers.slice(1, 3)).toEqual(untouched)
    expect(f.state.customers.find((c) => c.code === '800')).toMatchObject({ id: 4, name: 'NOVO', agentId: null, active: true })

    const audit = f.state.audit[f.state.audit.length - 1]
    expect(audit.action).toBe('update_customers')
    expect(audit.diff).toMatchObject({
      counts: { inserted: 1, updated: 1, unchanged: 0, untouched: 2 },
      created: ['800'],
      changes: [{ id: 1, code: '609', fields: { city: { de: 'Montevideo', para: 'Salto' }, taxId: { de: 'RUT 1', para: null } } }],
    })
  })

  it('ATUALIZAR: código que só difere nos zeros à esquerda → erro (com o formato de zeros, casa)', async () => {
    const f = fakeDb()
    await seed(f, { code: '000609', name: 'ACME' })
    await seedBackup(f)
    const before = structuredClone(f.state.customers)
    // 609 em formato Geral: "609" ≠ "000609"
    await expect(apply(f, await sheet(line(609, 'ACME', { city: 'Salto' })), { mode: 'update' })).rejects.toThrow(/zeros à esquerda: 609 \(linha 2\) × 000609 no sistema/)
    expect(f.state.customers).toEqual(before)

    // a mesma célula com formato "000000" chega como "000609" e atualiza o cliente certo
    const padded = await xlsx((ws) => {
      ws.addRow(HEAD)
      ws.addRow(line(609, 'ACME', { city: 'Salto' }))
      ws.getCell('A2').numFmt = '000000'
    })
    await expect(apply(f, padded, { mode: 'update' })).resolves.toMatchObject({ inserted: 0, updated: 1 })
    expect(f.state.customers).toEqual([expect.objectContaining({ id: 1, code: '000609', city: 'Salto' })])
  })
})
