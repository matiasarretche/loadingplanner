import { describe, expect, it } from 'vitest'
import {
  CARRIER_SHEET_COLUMNS,
  CARRIER_UPDATE_WORD,
  carrierCountsOf,
  carrierHeaderProblems,
  carrierPlanWarnings,
  type CellValue,
  type CurrentCarrier,
  type ImportedCarrier,
  MAX_CARRIER_ROWS,
  nearCarrierCodeMessage,
  parseCarrierSheet,
  planCarrierImport,
  type SheetRow,
  validateCarrierApplyInput,
} from './carrierImport'

const HEAD: CellValue[] = CARRIER_SHEET_COLUMNS.map((c) => c.header)
const SHA = 'a'.repeat(64)

/** linhas da planilha (a partir da linha 2): Código, Descr.transportador */
const rows = (...list: CellValue[][]): SheetRow[] => list.map((cells, i) => ({ row: i + 2, cells }))
const carrier = (code: string, name: string, row = 2, maybeTruncated = false, placeholderName = false): ImportedCarrier => ({ row, code, name, maybeTruncated, erpLength: name.length, placeholderName })
const cur = (id: number, code: string, name: string, active = true): CurrentCarrier => ({ id, code, name, active })

describe('cabeçalho', () => {
  it('o cabeçalho do ERP passa (com coluna C vazia); maiúsculas, acentos e pontuação não contam', () => {
    expect(carrierHeaderProblems(['Código', 'Descr.transportador', null])).toEqual([])
    expect(carrierHeaderProblems([' CODIGO ', 'Descr. Transportador'])).toEqual([])
    expect(carrierHeaderProblems(['Código', 'Transportadora'])).toEqual([])
  })

  it('coluna errada, vazia ou a mais → erro na linha 1 e nada lido', () => {
    const r = parseCarrierSheet(['Código', 'Razão social'], rows([12, 'X']))
    expect(r.carriers).toEqual([])
    expect(r.errors).toEqual([{ rows: [1], message: expect.stringMatching(/coluna B deveria ser “Descr\.transportador” \(está “Razão social”\)/) }])
    expect(carrierHeaderProblems(['Código'])[0]).toMatch(/coluna B deveria ser “Descr\.transportador” \(está vazia\)/)
    // a planilha dos clientes (11 colunas) não passa por transportadoras
    expect(carrierHeaderProblems(['Código', 'Transportadora', 'Endereço'])[0]).toMatch(/coluna C \(“Endereço”\) não faz parte do modelo/)
  })
})

describe('parseCarrierSheet', () => {
  it('código numérico vira texto, texto mantém zeros e maiúsculas; nome com espaços repetidos reduzidos, sem forçar maiúsculas', () => {
    const r = parseCarrierSheet(HEAD, rows([12, '  RAPIDO  TRANSPAULO LTDA '], ['0007', 'Intermodal Transportes e Logísti'], ['a-9', 'transp minúscula']))
    expect(r.errors).toEqual([])
    expect(r.carriers).toEqual([
      // erpLength: sem os espaços das pontas, antes de juntar os repetidos
      { row: 2, code: '12', name: 'RAPIDO TRANSPAULO LTDA', maybeTruncated: false, erpLength: 23, placeholderName: false },
      { row: 3, code: '0007', name: 'Intermodal Transportes e Logísti', maybeTruncated: true, erpLength: 32, placeholderName: false },
      { row: 4, code: 'a-9', name: 'transp minúscula', maybeTruncated: false, erpLength: 16, placeholderName: false },
    ])
  })

  it('erros que bloqueiam: código/nome vazio, código repetido, zeros à esquerda, decimal, erro do Excel, fórmula sem valor, oculta', () => {
    const list: SheetRow[] = [
      ...rows([null, 'SEM CODIGO'], [5, null], [7, 'A'], [7, 'B'], ['012', 'C'], [12, 'D'], [3.5, 'E'], [8, '#N/A']),
      { row: 10, cells: [9, null], noFormulaValue: [1] },
      { row: 11, cells: [10, 'OCULTA'], hidden: true },
      { row: 12, cells: ['..', '..'] }, // só pontos: não é linha de dados
      { row: 13, cells: [11, 'OK'] },
    ]
    const r = parseCarrierSheet(HEAD, list)
    expect(r.errors.map((e) => [e.rows, e.message.slice(0, 40)])).toEqual([
      [[2], 'Código vazio.'],
      [[8], 'Código inválido (número negativo ou com '],
      [[4, 5], 'Código 7 repetido (2 linhas): cada trans'],
      [[6, 7], 'Códigos que só diferem nos zeros à esque'],
      [[3], 'Nome da transportadora (Descr.transporta'],
      [[9], 'Erro do Excel (#N/A) em “Descr.transport'],
      [[10], 'Fórmula sem valor salvo em “Descr.transp'],
      [[11], '1 linha(s) oculta(s) ou filtrada(s) no E'],
    ])
    expect(r.carriers.map((c) => c.code)).toEqual(['11'])
  })

  it('texto longo demais, planilha vazia e linhas demais → erro', () => {
    expect(parseCarrierSheet(HEAD, rows([1, 'x'.repeat(201)])).errors[0].message).toMatch(/“Descr\.transportador” com 201 caracteres \(máx\. 200\)/)
    expect(parseCarrierSheet(HEAD, rows(['1'.repeat(41), 'x'])).errors[0].message).toMatch(/“Código” com 41 caracteres/)
    expect(parseCarrierSheet(HEAD, rows([null, null], ['  ', '..'])).errors).toEqual([{ rows: [], message: 'A planilha não tem transportadoras abaixo do cabeçalho.' }])
    const many = Array.from({ length: MAX_CARRIER_ROWS + 1 }, (_, i) => [i + 1, `T ${i}`])
    expect(parseCarrierSheet(HEAD, rows(...many)).errors[0].message).toMatch(/mais de 5\.000 linhas/)
  })

  it('nomes repetidos (filiais) entram TODOS, com aviso; nomes quase iguais e valores fora das colunas também avisam', () => {
    const r = parseCarrierSheet(
      HEAD,
      rows(
        [12, 'RAPIDO TRANSPAULO LTDA'],
        [232, 'RAPIDO TRANSPAULO LTDA'],
        [52, 'PLIMOR'],
        [182, 'Plimor'],
        [185, 'PLIMOR'],
        [191, 'EXPRESSO MERCURIO SA'],
        [263, 'EXPRESSO MERCURIO S A', 'sobra'],
      ),
    )
    expect(r.errors).toEqual([])
    expect(r.carriers).toHaveLength(7)
    expect(r.sameName).toEqual([
      { name: 'PLIMOR', codes: ['52', '182', '185'], rows: [4, 5, 6] },
      { name: 'RAPIDO TRANSPAULO LTDA', codes: ['12', '232'], rows: [2, 3] },
    ])
    expect(r.nearNames).toEqual([{ names: ['EXPRESSO MERCURIO SA', 'EXPRESSO MERCURIO S A'], codes: ['191', '263'], rows: [7, 8] }])
    const msgs = r.warnings.map((w) => w.message)
    expect(msgs[0]).toMatch(/^2 nome\(s\) aparecem com mais de um código \(5 linhas\): são filiais e TODAS serão importadas/)
    expect(msgs[0]).toContain('“PLIMOR · cód. 52”')
    expect(msgs[1]).toMatch(/^Nomes quase iguais .*“EXPRESSO MERCURIO SA” × “EXPRESSO MERCURIO S A” — códigos 191, 263/)
    expect(r.warnings.at(-1)).toEqual({ rows: [8], message: 'Valores depois da coluna B (fora do modelo) foram ignorados.' })
  })

  it('especiais do ERP (destinatário, a definir, próprio, correios) e nomes no limite de 32 caracteres → avisos', () => {
    const r = parseCarrierSheet(
      HEAD,
      rows(
        [64, 'DESTINATARIO'],
        [995, 'DESTINATARIO'],
        [999, 'A DEFINIR'],
        [94, 'PROPRIO'],
        [81, 'SEDEX'],
        [476, 'PAC CORREIO'],
        [248, 'TRANSP INTERNACIONAIS  BRASIL LT'], // 32 no ERP, 31 depois de juntar os espaços
        [432, 'PATRUS TRANSPORTES URGENTES LTDA'],
      ),
    )
    expect(r.errors).toEqual([])
    expect(r.specials.map((x) => [x.code, x.kind])).toEqual([
      ['64', 'customer_pickup'],
      ['995', 'customer_pickup'],
      ['999', 'to_define'],
      ['94', 'own'],
      ['81', 'postal'],
      ['476', 'postal'],
    ])
    const special = r.warnings.find((w) => /especial/.test(w.message))!
    expect(special.rows).toEqual([2, 3, 4, 5, 6, 7])
    expect(special.message).toContain('Retirada pelo cliente (destinatário): DESTINATARIO (64), DESTINATARIO (995)')
    expect(r.carriers.filter((c) => c.maybeTruncated).map((c) => [c.code, c.name])).toEqual([
      ['248', 'TRANSP INTERNACIONAIS BRASIL LT'],
      ['432', 'PATRUS TRANSPORTES URGENTES LTDA'],
    ])
    expect(r.warnings.find((w) => /limite do ERP/.test(w.message))?.rows).toEqual([8, 9])
  })

  it('nome só com pontos (o ERP tem 139 = "..") entra tal qual, com aviso; código só com pontos = vazio', () => {
    const r = parseCarrierSheet(HEAD, rows([138, 'HEITOR'], [139, ' .. '], [140, '..'], ['..', 'SEM CODIGO']))
    expect(r.carriers.map((c) => [c.code, c.name, c.placeholderName])).toEqual([
      ['138', 'HEITOR', false],
      ['139', '..', true],
      ['140', '..', true],
    ])
    // não viram filiais de um nome vazio
    expect(r.sameName).toEqual([])
    expect(r.errors).toEqual([{ rows: [5], message: 'Código vazio.' }])
    expect(r.warnings).toEqual([
      { rows: [3, 4], message: expect.stringMatching(/^2 transportadora\(s\) sem nome no ERP \(só pontos ou traços\), código\(s\) 139, 140: entram com o nome “\.\.”, tal qual/) },
      { rows: [5], message: 'Códigos só com pontos ou traços (ex.: “..”) foram tratados como vazios.' },
    ])
  })
})

describe('planCarrierImport', () => {
  it('nome só com pontos não sobrescreve o nome do sistema (mas entra se o código é novo)', () => {
    const p = planCarrierImport([carrier('139', '..', 2, false, true), carrier('140', '..', 3, false, true)], [cur(1, '139', 'Transportadora 139 (nome dado em Cadastros)')])
    expect(p).toMatchObject({ toInsert: 1, toRename: 0, unchanged: 1, insertCodes: ['140'] })
  })


  it('cria códigos novos, renomeia só quando o nome muda, mantém nome completado, lista inativas e fora da planilha', () => {
    const sheet = [
      carrier('12', 'RAPIDO TRANSPAULO LTDA', 2),
      carrier('52', 'PLIMOR', 3),
      carrier('422', 'Intermodal Transportes e Logísti', 4, true),
      carrier('7', 'ACME', 5),
      carrier('8', 'TRANSPORTES NOVOS', 6),
      carrier('900', 'NOVA', 7),
    ]
    const current = [
      cur(1, '12', 'RAPIDO TRANSPAULO LTDA'),
      cur(2, '52', 'PLIMOR TRANSPORTES', false), // começa com o nome da planilha, mas a planilha não está no limite: renomeia
      cur(3, '422', 'Intermodal Transportes e Logística Ltda'),
      cur(4, '7', 'Acme'),
      cur(5, '8', 'Cadastrada à mão'),
      cur(6, '1000', 'Fora da planilha', false),
      cur(7, '2', 'Outra fora'),
    ]
    const p = planCarrierImport(sheet, current)
    expect(p).toMatchObject({ toInsert: 1, toRename: 3, unchanged: 1, insertCodes: ['900'], nearCodes: [] })
    expect(p.renames).toEqual([
      { id: 2, code: '52', row: 3, de: 'PLIMOR TRANSPORTES', para: 'PLIMOR', otherCompany: false },
      { id: 4, code: '7', row: 5, de: 'Acme', para: 'ACME', otherCompany: false },
      { id: 5, code: '8', row: 6, de: 'Cadastrada à mão', para: 'TRANSPORTES NOVOS', otherCompany: true },
    ])
    expect(p.keptComplete).toEqual([{ id: 3, code: '422', row: 4, sheetName: 'Intermodal Transportes e Logísti', name: 'Intermodal Transportes e Logística Ltda' }])
    expect(p.inactiveInSheet).toEqual([{ id: 2, code: '52', name: 'PLIMOR TRANSPORTES', row: 3 }])
    // ordem numérica do código
    expect(p.notInSheet.map((c) => c.code)).toEqual(['2', '1000'])

    const w = carrierPlanWarnings(p)
    expect(w.map((x) => x.rows)).toEqual([[6], [3], [4]])
    expect(w[0].message).toMatch(/1 transportadora\(s\) do sistema passam a ter OUTRO nome \(ex\.: código 8: “Cadastrada à mão” → “TRANSPORTES NOVOS”\)/)
    expect(w[1].message).toMatch(/INATIVAS no sistema e continuam inativas/)
    expect(w[2].message).toMatch(/completados no sistema/)
  })

  it('nome completado no sistema fica: corte do ERP num espaço (30–31 caracteres) e completado com acentos/maiúsculas (casos reais)', () => {
    const sheet = parseCarrierSheet(
      HEAD,
      rows(
        [348, 'HALLMAQ MAQUINAS E EQUIPAMENTOS'], // 31: o ERP cortou em 32 no espaço antes de " LTDA"
        [93, 'TRANSCAXIAS TRANSPORTE RAPIDO LT'], // 32, completado com acento
        [500, 'TRANSPORTADORA LOGISTICA SAO PAU'], // 32, completado com acentos e minúsculas
        [30, 'FASTCARGO AG CARGAS NAC INTL LTD'], // 32, completado sem acento
        [160, 'TRANSPORTADORA RAPIDO VALESINOS'], // 31, completado com espaços repetidos
        [700, 'RODOVIARIO  SANTA MARIA EXPRESS'], // 31 no ERP (espaço duplo), 30 depois de juntar
        [702, 'EXPRESSO SAO MIGUEL TRANSPORTE'], // 30
        [614, 'TRANSPRIMER TRANSPORT LOGISTICS'], // 31, mas o "completado" não segue com espaço: não é corte
        [701, 'RODOVIARIO SANTA MARIA CARGAS'], // 29: não é corte do ERP
        [52, 'PLIMOR'],
      ),
    )
    expect(sheet.errors).toEqual([])
    const current = [
      cur(1, '348', 'HALLMAQ MAQUINAS E EQUIPAMENTOS LTDA'),
      cur(2, '93', 'TRANSCAXIAS TRANSPORTE RÁPIDO LTDA'),
      cur(3, '500', 'Transportadora Logística São Paulo Ltda'),
      cur(4, '30', 'FASTCARGO AG CARGAS NAC INTL LTDA'),
      cur(5, '160', 'TRANSPORTADORA  RAPIDO VALESINOS  LTDA'),
      cur(6, '700', 'Rodoviário Santa Maria Express Ltda'),
      cur(10, '702', 'Expresso São Miguel Transporte e Logística'),
      cur(7, '614', 'TRANSPRIMER TRANSPORT LOGISTICSS'),
      cur(8, '701', 'RODOVIARIO SANTA MARIA CARGAS LTDA'),
      cur(9, '52', 'PLIMOR TRANSPORTES'),
    ]
    const p = planCarrierImport(sheet.carriers, current)
    expect(p.keptComplete.map((k) => [k.code, k.name])).toEqual([
      ['348', 'HALLMAQ MAQUINAS E EQUIPAMENTOS LTDA'],
      ['93', 'TRANSCAXIAS TRANSPORTE RÁPIDO LTDA'],
      ['500', 'Transportadora Logística São Paulo Ltda'],
      ['30', 'FASTCARGO AG CARGAS NAC INTL LTDA'],
      ['160', 'TRANSPORTADORA  RAPIDO VALESINOS  LTDA'],
      ['700', 'Rodoviário Santa Maria Express Ltda'],
      ['702', 'Expresso São Miguel Transporte e Logística'],
    ])
    expect(p.renames.map((r) => [r.code, r.para, r.otherCompany])).toEqual([
      ['614', 'TRANSPRIMER TRANSPORT LOGISTICS', false],
      ['701', 'RODOVIARIO SANTA MARIA CARGAS', false],
      ['52', 'PLIMOR', false],
    ])
    // o aviso do limite do ERP lembra que os de 30–31 também ficam
    expect(sheet.warnings.find((w) => /limite do ERP/.test(w.message))?.message).toMatch(/nomes de 30–31 caracteres, que o ERP pode ter cortado num espaço/)
  })

  it('código que só difere nos zeros à esquerda ou maiúsculas de um atual → nearCodes (bloqueia)', () => {
    const p = planCarrierImport([carrier('12', 'X', 2), carrier('A7', 'Y', 3)], [cur(1, '012', 'X'), cur(2, 'a7', 'Y')])
    expect(p.insertCodes).toEqual(['12', 'A7'])
    expect(p.nearCodes).toEqual([
      { code: '12', row: 2, existing: '012', id: 1 },
      { code: 'A7', row: 3, existing: 'a7', id: 2 },
    ])
    expect(nearCarrierCodeMessage(p.nearCodes)).toMatch(/^2 código\(s\) .*12 \(linha 2\) × 012 no sistema; A7 \(linha 3\) × a7 no sistema\. Atualizar criaria/)
  })

  it('banco vazio: tudo novo', () => {
    const p = planCarrierImport([carrier('1', 'A', 2), carrier('2', 'A', 3)], [])
    expect(p).toMatchObject({ toInsert: 2, toRename: 0, unchanged: 0, notInSheet: [], keptComplete: [] })
    expect(carrierPlanWarnings(p)).toEqual([])
  })
})

describe('confirmação', () => {
  it('exige o sha256 da prévia e, fora da simulação, a palavra ATUALIZAR', () => {
    expect(validateCarrierApplyInput(null)).toBe('Pedido inválido.')
    expect(validateCarrierApplyInput({ fileSha256: 'x', dryRun: true, confirm: '' })).toMatch(/Gere a prévia/)
    expect(validateCarrierApplyInput({ fileSha256: SHA, dryRun: true, confirm: '' })).toBeNull()
    expect(validateCarrierApplyInput({ fileSha256: SHA, dryRun: false, confirm: 'atualizar' })).toMatch(/Digite ATUALIZAR/)
    expect(validateCarrierApplyInput({ fileSha256: SHA, dryRun: false, confirm: ` ${CARRIER_UPDATE_WORD} ` })).toBeNull()
  })

  it('contagens', () => {
    expect(carrierCountsOf([{ active: true }, { active: false }, { active: true }])).toEqual({ total: 3, active: 2, inactive: 1 })
  })
})
