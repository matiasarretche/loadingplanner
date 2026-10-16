import { describe, expect, it } from 'vitest'
import {
  type CellValue,
  type CurrentCustomer,
  CUSTOMER_SHEET_COLUMNS,
  headerProblems,
  type ImportedCustomer,
  leadingZeroMessage,
  parseCustomerSheet,
  planCustomerImport,
  REPLACE_WORD,
  rowsLabel,
  sameCustomerCounts,
  type SheetRow,
  UPDATE_WORD,
  validateCustomerApplyInput,
  zeroPaddedText,
} from './customerImport'

const HEAD: CellValue[] = CUSTOMER_SHEET_COLUMNS.map((c) => c.header)
const SHA = 'a'.repeat(64)

/** linha da planilha (a partir da linha 2): Código, Razão social, Endereço, Complemento, Bairro, Cidade, Estado, CEP, País, ID fiscal, Obs. */
const rows = (...list: CellValue[][]): SheetRow[] => list.map((cells, i) => ({ row: i + 2, cells }))
const ok = (code: CellValue, name: CellValue, country: CellValue = 'Uruguai', extra: Partial<Record<'address' | 'city' | 'notes', CellValue>> = {}): CellValue[] => {
  const pick = (k: keyof typeof extra, def: CellValue) => (k in extra ? (extra[k] ?? null) : def)
  return [code, name, pick('address', 'Camino del Jefe 2520'), null, null, pick('city', 'Montevideo'), null, null, country, null, pick('notes', null)]
}

describe('cabeçalho', () => {
  it('o modelo exato passa (espaços nas pontas e repetidos não contam)', () => {
    expect(headerProblems(HEAD)).toEqual([])
    expect(headerProblems(HEAD.map((h) => ` ${String(h).replace(' ', '  ')} `))).toEqual([])
  })

  it('coluna trocada, faltando ou a mais → erro na linha 1 e nenhum cliente lido', () => {
    const wrong = [...HEAD]
    wrong[2] = 'Endereco'
    const r = parseCustomerSheet(wrong, rows(ok(609, 'ACME')))
    expect(r.customers).toEqual([])
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].rows).toEqual([1])
    expect(r.errors[0].message).toMatch(/coluna C deveria ser “Endereço” \(está “Endereco”\)/)

    expect(headerProblems(HEAD.slice(0, 10))[0]).toMatch(/coluna K deveria ser “Observações” \(está vazia\)/)
    expect(headerProblems([...HEAD, 'Fonte'])[0]).toMatch(/coluna L \(“Fonte”\) não faz parte do modelo/)
    // ordem trocada
    const swapped = [...HEAD]
    ;[swapped[4], swapped[5]] = [swapped[5], swapped[4]]
    expect(headerProblems(swapped)).toHaveLength(2)
  })
})

describe('parseCustomerSheet', () => {
  it('lê os campos: código numérico vira texto, vazios → null, espaços removidos, país oficial', () => {
    const r = parseCustomerSheet(
      HEAD,
      rows([609, '  HENDERSON  &  CIA S/A ', 'Av. Italia 1234', 'Of. 2', 'Centro', 'Montevideo', 'Montevideo', '11300', 'Uruguai', '210000000011', 'linha 1\r\nlinha 2  ']),
    )
    expect(r.errors).toEqual([])
    expect(r.customers).toEqual<ImportedCustomer[]>([
      { row: 2, code: '609', name: 'HENDERSON & CIA S/A', address: 'Av. Italia 1234', addressComplement: 'Of. 2', district: 'Centro', city: 'Montevideo', state: 'Montevideo', postalCode: '11300', country: 'Uruguai', taxId: '210000000011', notes: 'linha 1\nlinha 2' },
    ])
  })

  it('código como texto e como número são o mesmo código (repetido = erro com as linhas)', () => {
    const r = parseCustomerSheet(HEAD, rows(ok(609, 'A'), ok('610', 'B'), ok(' 609 ', 'C'), ok(611, 'D')))
    expect(r.errors).toEqual([{ rows: [2, 4], message: expect.stringMatching(/Código 609 repetido \(2 linhas\)/) }])
    // as linhas repetidas não entram; as outras sim
    expect(r.customers.map((c) => c.code)).toEqual(['610', '611'])
  })

  it('código vazio, razão social vazia e código com casas decimais → erros com a linha', () => {
    const r = parseCustomerSheet(HEAD, rows(ok(null, 'SEM CÓDIGO'), ok(612, '   '), ok(613.5, 'X'), ok(614, 'OK')))
    expect(r.errors).toContainEqual({ rows: [2], message: 'Código vazio.' })
    expect(r.errors).toContainEqual({ rows: [3], message: 'Razão social vazia.' })
    expect(r.errors).toContainEqual({ rows: [4], message: expect.stringMatching(/Código inválido/) })
    expect(r.customers.map((c) => c.code)).toEqual(['614'])
  })

  it('país não reconhecido ou vazio → erro (agrupado por grafia); outra grafia reconhecida → aviso e nome oficial', () => {
    const r = parseCustomerSheet(HEAD, rows(ok(1, 'A', 'Estados Unidos'), ok(2, 'B', 'Países Baixos'), ok(3, 'C', 'Narnia'), ok(4, 'D', 'Narnia'), ok(5, 'E', null), ok(6, 'F', 'uruguay')))
    expect(r.errors).toContainEqual({ rows: [4, 5], message: expect.stringMatching(/País não reconhecido: “Narnia”/) })
    expect(r.errors).toContainEqual({ rows: [6], message: 'País vazio.' })
    expect(r.customers.map((c) => [c.code, c.country])).toEqual([
      ['1', 'Estados Unidos'],
      ['2', 'Países Baixos'],
      ['6', 'Uruguai'],
    ])
    expect(r.warnings).toContainEqual({ rows: [7], message: expect.stringMatching(/País “uruguay” será gravado como “Uruguai”/) })
  })

  it('linhas vazias são ignoradas; ".." vira vazio com aviso; sem cidade/endereço e nome repetido → avisos', () => {
    const r = parseCustomerSheet(HEAD, [
      { row: 2, cells: ok(1, 'TRIPLE P FEEDS', 'Estados Unidos', { city: '..' }) },
      { row: 3, cells: [null, '', '  ', null] },
      { row: 4, cells: ['..', '..', null] },
      { row: 5, cells: ok(2, 'Triple P Feeds', 'Estados Unidos', { address: null }) },
    ])
    expect(r.errors).toEqual([])
    expect(r.customers).toHaveLength(2)
    expect(r.customers[0].city).toBeNull()
    const msgs = r.warnings.map((w) => `${w.rows.join(',')}: ${w.message}`)
    expect(msgs).toContainEqual(expect.stringMatching(/^2,5: Razão social repetida \(2 linhas\)/))
    expect(msgs).toContainEqual(expect.stringMatching(/^2: 1 cliente\(s\) sem cidade/))
    expect(msgs).toContainEqual(expect.stringMatching(/^5: 1 cliente\(s\) sem endereço/))
    expect(msgs).toContainEqual(expect.stringMatching(/^2: Células só com pontos/))
  })

  it('valores depois da coluna K são ignorados com aviso', () => {
    const r = parseCustomerSheet(HEAD, rows([...ok(1, 'A'), 'sobrando']))
    expect(r.customers).toHaveLength(1)
    expect(r.warnings).toContainEqual({ rows: [2], message: expect.stringMatching(/depois da coluna K/) })
  })

  it('planilha sem dados ou com texto longo demais → erro', () => {
    expect(parseCustomerSheet(HEAD, []).errors[0].message).toMatch(/não tem clientes/)
    const r = parseCustomerSheet(HEAD, rows(ok(1, 'x'.repeat(501))))
    expect(r.errors[0]).toEqual({ rows: [2], message: expect.stringMatching(/“Razão social” com 501 caracteres/) })
    expect(r.customers).toEqual([])
  })
})

const cur = (id: number, code: string | null, name: string, o: Partial<CurrentCustomer> = {}): CurrentCustomer => ({
  id,
  code,
  name,
  address: 'Camino del Jefe 2520',
  addressComplement: null,
  district: null,
  city: 'Montevideo',
  state: null,
  postalCode: null,
  country: 'Uruguai',
  taxId: null,
  notes: null,
  agentId: null,
  active: true,
  ...o,
})

describe('planCustomerImport', () => {
  const sheet = parseCustomerSheet(HEAD, rows(ok(609, 'ACME'), ok(610, 'BETA SA'), ok(611, 'GAMMA', 'Uruguai', { city: 'Salto' }), ok(612, 'Nova Loja'))).customers

  it('substituir: apaga todos os atuais (avisa dos agentes) e cria os da planilha', () => {
    const p = planCustomerImport(sheet, [cur(1, null, 'Velho', { agentId: 3 }), cur(2, '609', 'ACME', { active: false })])
    expect(p.replace).toEqual({ toDelete: 2, toInsert: 4, agentLinksLost: 1, inactiveDeleted: 1 })
  })

  it('atualizar pelo código: novos, alterados (com os campos), sem mudança; sem código e fora da planilha não são tocados', () => {
    const p = planCustomerImport(sheet, [cur(1, '609', 'ACME'), cur(2, '610', 'BETA'), cur(3, '611', 'GAMMA'), cur(4, null, 'NOVA LOJA'), cur(5, '999', 'Antigo')])
    expect(p.update.insertCodes).toEqual(['612'])
    expect(p.update.unchanged).toBe(1)
    expect(p.update.changes).toEqual([
      { id: 2, code: '610', row: 3, name: 'BETA SA', previousName: 'BETA', fields: ['name'], cleared: [], diff: { name: { de: 'BETA', para: 'BETA SA' } } },
      { id: 3, code: '611', row: 4, name: 'GAMMA', previousName: null, fields: ['city'], cleared: [], diff: { city: { de: 'Montevideo', para: 'Salto' } } },
    ])
    expect(p.update).toMatchObject({ toInsert: 1, toUpdate: 2, withoutCode: 1, notInSheet: 1, leadingZeroCodes: [] })
    // cliente sem código com a mesma razão social (sem acento/maiúsculas) de um código novo
    expect(p.update.sameNameWithoutCode).toEqual([{ name: 'Nova Loja', rows: [5], ids: [4] }])
  })

  it('atualizar: Observações vazias na planilha mantêm as do sistema; outros campos vazios são apagados (cleared)', () => {
    const s = parseCustomerSheet(HEAD, rows(ok(609, 'ACME', 'Uruguai', { notes: null }), ok(610, 'BETA', 'Uruguai', { notes: 'nova obs' }), ok(611, 'GAMMA', 'Uruguai', { address: null, notes: '..' }))).customers
    const p = planCustomerImport(s, [cur(1, '609', 'ACME', { notes: 'escrita em Cadastros' }), cur(2, '610', 'BETA', { notes: 'antiga' }), cur(3, '611', 'GAMMA', { notes: 'fica', taxId: 'RUT 1' })])
    // 609: só a observação difere (vazia na planilha) → sem mudança
    expect(p.update.unchanged).toBe(1)
    expect(p.update.changes).toEqual([
      { id: 2, code: '610', row: 3, name: 'BETA', previousName: null, fields: ['notes'], cleared: [], diff: { notes: { de: 'antiga', para: 'nova obs' } } },
      {
        id: 3,
        code: '611',
        row: 4,
        name: 'GAMMA',
        previousName: null,
        fields: ['address', 'taxId'],
        cleared: ['address', 'taxId'],
        diff: { address: { de: 'Camino del Jefe 2520', para: null }, taxId: { de: 'RUT 1', para: null } },
      },
    ])
  })

  it('atualizar: código que só difere de um do sistema nos zeros à esquerda é listado (bloqueia)', () => {
    const s = parseCustomerSheet(HEAD, rows(ok(609, 'ACME'), ok('0700', 'BETA'), ok('A-1', 'GAMMA'))).customers
    const p = planCustomerImport(s, [cur(1, '000609', 'ACME'), cur(2, '700', 'BETA'), cur(3, 'A-1', 'GAMMA')])
    expect(p.update.leadingZeroCodes).toEqual([
      { code: '609', row: 2, existing: '000609', id: 1 },
      { code: '0700', row: 3, existing: '700', id: 2 },
    ])
    expect(leadingZeroMessage(p.update.leadingZeroCodes)).toMatch(/^2 código\(s\).*609 \(linha 2\) × 000609 no sistema; 0700 \(linha 3\) × 700 no sistema/)
  })
})

describe('zeroPaddedText (formato de zeros do Excel)', () => {
  it('aplica os zeros à esquerda e os separadores do formato', () => {
    expect(zeroPaddedText(2134, '00000')).toBe('02134')
    expect(zeroPaddedText(609, '000000')).toBe('000609')
    expect(zeroPaddedText(1234567, '0000000000')).toBe('0001234567')
    expect(zeroPaddedText(1310100, '00000-000')).toBe('01310-100')
    expect(zeroPaddedText(1234567890, '000"."000"."000\\-00')).toBe('012.345.678-90')
    // CEP americano (formato especial do Excel): condição escolhe a seção
    expect(zeroPaddedText(2134, '[<=99999]00000;00000-0000')).toBe('02134')
    expect(zeroPaddedText(21341234, '[<=99999]00000;00000-0000')).toBe('02134-1234')
    // dígitos a mais ficam no primeiro marcador, como no Excel
    expect(zeroPaddedText(1234567, '00000')).toBe('1234567')
  })

  it('outros formatos (Geral, decimais, #, texto) e números que não são inteiros ≥ 0 → null', () => {
    for (const fmt of ['General', '0', '0.00', '#,##0', '@', 'dd/mm/yyyy', '', null, undefined]) expect(zeroPaddedText(2134, fmt)).toBeNull()
    expect(zeroPaddedText(2134.5, '00000')).toBeNull()
    expect(zeroPaddedText(-5, '00000')).toBeNull()
  })
})

describe('parseCustomerSheet: erros do Excel, fórmulas sem valor e linhas ocultas', () => {
  it('erro do Excel em qualquer coluna → erro na linha (agrupado por coluna); sem "Código vazio" duplicado', () => {
    const r = parseCustomerSheet(HEAD, rows(ok('#N/A', 'ACME'), ok(2, '#REF!'), ok(3, 'GAMMA', '#n/d'), ok(4, 'DELTA', 'Uruguai', { city: '#VALUE!' }), ok(5, 'OK')))
    expect(r.errors).toEqual([
      { rows: [2], message: expect.stringMatching(/^Erro do Excel \(#N\/A\) em “Código”/) },
      { rows: [3], message: expect.stringMatching(/^Erro do Excel \(#REF!\) em “Razão social”/) },
      { rows: [4], message: expect.stringMatching(/^Erro do Excel \(#N\/D\) em “País”/) },
      { rows: [5], message: expect.stringMatching(/^Erro do Excel \(#VALUE!\) em “Cidade”/) },
    ])
    expect(r.customers.map((c) => c.code)).toEqual(['5'])
    // "#1 FEEDS" não é erro do Excel
    expect(parseCustomerSheet(HEAD, rows(ok(1, '#1 FEEDS'))).errors).toEqual([])
  })

  it('fórmula sem valor salvo → erro na linha, mesmo se a linha não tiver outro valor', () => {
    const r = parseCustomerSheet(HEAD, [
      { row: 2, cells: ok(1, 'ACME', 'Uruguai', { city: null }), noFormulaValue: [5] },
      { row: 3, cells: [null, null, null, null, null, null, null, null, 'Uruguai'], noFormulaValue: [0, 1] },
      { row: 4, cells: ok(2, 'BETA'), noFormulaValue: [12] }, // fora do modelo: não importa
    ])
    expect(r.errors).toEqual([
      { rows: [2], message: expect.stringMatching(/^Fórmula sem valor salvo em “Cidade”/) },
      { rows: [3], message: expect.stringMatching(/^Fórmula sem valor salvo em “Código”/) },
      { rows: [3], message: expect.stringMatching(/^Fórmula sem valor salvo em “Razão social”/) },
    ])
    expect(r.customers.map((c) => c.code)).toEqual(['2'])
  })

  it('linha oculta/filtrada com dados → erro (bloqueia) e fica fora dos clientes; vazia não conta', () => {
    const r = parseCustomerSheet(HEAD, [
      { row: 2, cells: ok(1, 'ACME') },
      { row: 3, cells: ok(2, 'FILTRADO'), hidden: true },
      { row: 4, cells: [null, '..'], hidden: true },
    ])
    expect(r.errors).toEqual([{ rows: [3], message: expect.stringMatching(/^1 linha\(s\) oculta\(s\) ou filtrada\(s\) no Excel/) }])
    expect(r.customers.map((c) => c.code)).toEqual(['1'])
  })

  it('código postal ou ID fiscal gravado como número → aviso (zero à esquerda pode ter se perdido)', () => {
    const r = parseCustomerSheet(HEAD, rows([1, 'A', 'Rua 1', null, null, 'Boston', 'MA', 2134, 'Estados Unidos', null, null], [2, 'B', 'Rua 2', null, null, 'Boston', 'MA', '02134', 'Estados Unidos', 123, null], [3, 'C', 'Rua 3', null, null, 'Boston', 'MA', '02134', 'Estados Unidos', null, null]))
    expect(r.errors).toEqual([])
    expect(r.warnings).toContainEqual({ rows: [2, 3], message: expect.stringMatching(/gravado como número no Excel/) })
  })
})

describe('confirmação e backup', () => {
  const base = { mode: 'replace' as const, fileSha256: SHA, dryRun: false, confirm: REPLACE_WORD, savedBackup: true, backupSha256: SHA }

  it('aplicar exige a palavra do modo, a caixa e o backup', () => {
    expect(validateCustomerApplyInput(base)).toBeNull()
    expect(validateCustomerApplyInput({ ...base, mode: 'update', confirm: UPDATE_WORD })).toBeNull()
    expect(validateCustomerApplyInput({ ...base, mode: 'update' })).toMatch(/Digite ATUALIZAR/)
    expect(validateCustomerApplyInput({ ...base, confirm: 'substituir' })).toMatch(/Digite SUBSTITUIR/)
    expect(validateCustomerApplyInput({ ...base, savedBackup: false })).toMatch(/Baixei e guardei/)
    expect(validateCustomerApplyInput({ ...base, backupSha256: null })).toMatch(/Baixe o backup/)
    expect(validateCustomerApplyInput({ ...base, fileSha256: 'x' })).toMatch(/Gere a prévia/)
    expect(validateCustomerApplyInput({ ...base, mode: 'x' as never })).toMatch(/Escolha o modo/)
    expect(validateCustomerApplyInput(null)).toBe('Pedido inválido.')
  })

  it('simular não exige palavra nem backup, mas confere um backup informado', () => {
    expect(validateCustomerApplyInput({ ...base, dryRun: true, confirm: '', savedBackup: false, backupSha256: null })).toBeNull()
    expect(validateCustomerApplyInput({ ...base, dryRun: true, backupSha256: 'zz' })).toMatch(/Backup inválido/)
  })

  it('sameCustomerCounts', () => {
    const c = { customers: 3, withCode: 1, withAgent: 0, inactive: 0 }
    expect(sameCustomerCounts(c, c)).toBe(true)
    expect(sameCustomerCounts({ ...c, withCode: 2 }, c)).toBe(false)
    expect(sameCustomerCounts({ customers: 3 }, c)).toBe(false)
    expect(sameCustomerCounts(null, c)).toBe(false)
  })

  it('rowsLabel', () => {
    expect(rowsLabel([3])).toBe('linha 3')
    expect(rowsLabel([3, 5, 9])).toBe('linhas 3, 5 e 9')
    expect(rowsLabel([1, 2, 3, 4], 2)).toBe('linhas 1, 2, … (mais 2)')
    expect(rowsLabel([])).toBe('')
  })
})
