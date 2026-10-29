/**
 * IMPORTAÇÃO DAS TRANSPORTADORAS pela planilha do ERP (Manutenção › Transportadoras): leitura das linhas já
 * tiradas do .xlsx, validação, plano contra as transportadoras atuais e regras da confirmação.
 * Puro (sem banco nem arquivo): a tela, o servidor e os testes usam as mesmas regras.
 *
 * Contrato da planilha: primeira aba, linha 1 = cabeçalho (colunas A–B, nesta ordem):
 *   Código | Descr.transportador
 * (colunas vazias à direita são ignoradas; maiúsculas, acentos e pontuação do cabeçalho não importam).
 * Código e nome obrigatórios; código único na planilha, gravado como TEXTO (número inteiro do Excel → "12";
 * texto mantém os zeros à esquerda; maiúsculas não são forçadas); nome numa linha só, espaços repetidos
 * reduzidos a um. Nomes REPETIDOS com códigos diferentes são filiais: todas entram, cada uma com o seu código.
 * Nome só com pontos/traços (o ERP tem "..") entra tal qual, mas não sobrescreve o nome de uma já cadastrada.
 * Bloqueiam a planilha: código/nome vazio, código repetido, erro do Excel (#N/A…), fórmula sem valor salvo,
 * linha oculta/filtrada e mais de MAX_CARRIER_ROWS linhas.
 *
 * Um modo só, ATUALIZAR PELO CÓDIGO: cria os códigos novos (ativos) e, nos existentes, grava só o NOME quando
 * muda. Nunca apaga, nunca toca em contato, telefone, e-mail, observações nem em "ativa".
 */
import { type CellValue, cellText, EXCEL_ERROR, group, headText, letter, nameKey, type SheetIssue, type SheetRow } from '@/domain/customerImport'
import { SPECIAL_TRANSPORT_LABEL, specialTransportCompany, transportCompanyLabel } from '@/domain/transportCompany'

export type { CellValue, SheetIssue, SheetRow }

/** colunas da planilha, na ordem (A–B), com o cabeçalho do ERP e as outras grafias aceitas (comparadas sem acento/pontuação) */
export const CARRIER_SHEET_COLUMNS = [
  { field: 'code', header: 'Código', accepted: ['codigo', 'cod', 'codtransportador', 'codigotransportador'] },
  { field: 'name', header: 'Descr.transportador', accepted: ['descrtransportador', 'descricaotransportador', 'transportador', 'transportadora', 'nometransportador', 'nome'] },
] as const

const COLS = CARRIER_SHEET_COLUMNS.length

/** mais linhas de dados que isso = arquivo errado (o ERP tem ~735) */
export const MAX_CARRIER_ROWS = 5000
/** tamanho máximo do arquivo enviado (navegador e servidor): a planilha do ERP tem ~30 KB */
export const CARRIER_IMPORT_MAX_BYTES = 1024 * 1024
export const MAX_CODE = 40
export const MAX_NAME = 200
/** o ERP corta o nome da transportadora nesse tamanho */
export const ERP_NAME_MAX = 32
/** o ERP grava o nome cortado sem os espaços do fim: com 30–31 caracteres o corte em 32 pode ter caído num espaço */
export const ERP_CUT_MIN = ERP_NAME_MAX - 2

/** transportadora lida da planilha (com a linha, para as mensagens) */
export interface ImportedCarrier {
  row: number
  code: string
  name: string
  /** nome com o tamanho máximo do ERP (32): pode ter sido cortado */
  maybeTruncated: boolean
  /** tamanho do nome no ERP (sem os espaços das pontas, antes de juntar os repetidos) */
  erpLength: number
  /** nome só com pontos/traços no ERP (ex.: ".."): entra assim, mas não sobrescreve o nome de uma já cadastrada */
  placeholderName: boolean
}

export type SpecialCarrierKind = NonNullable<ReturnType<typeof specialTransportCompany>>

/** mesmo nome com mais de um código (filiais) */
export interface SameNameGroup {
  name: string
  codes: string[]
  rows: number[]
}

/** nomes que só diferem em espaços/pontuação (ex.: "EXPRESSO MERCURIO SA" × "EXPRESSO MERCURIO S A") */
export interface NearNameGroup {
  names: string[]
  codes: string[]
  rows: number[]
}

/** pseudo-transportadora do ERP (cliente retira, a definir, transporte próprio, correios) */
export interface SpecialCarrier {
  row: number
  code: string
  name: string
  kind: SpecialCarrierKind
  label: string
}

export interface ParsedCarrierSheet {
  carriers: ImportedCarrier[]
  errors: SheetIssue[]
  warnings: SheetIssue[]
  sameName: SameNameGroup[]
  nearNames: NearNameGroup[]
  specials: SpecialCarrier[]
}

/** chave do cabeçalho: sem acento, pontuação nem espaços, minúsculas ("Descr.transportador" → "descrtransportador") */
const headerKey = (v: CellValue | undefined) => nameKey(headText(v)).replace(/ /g, '')

/** Problemas do cabeçalho (linha 1). Lista vazia = cabeçalho reconhecido. */
export function carrierHeaderProblems(header: CellValue[]): string[] {
  const out: string[] = []
  CARRIER_SHEET_COLUMNS.forEach((c, i) => {
    const got = headText(header[i])
    if (!(c.accepted as readonly string[]).includes(headerKey(header[i]))) out.push(`coluna ${letter(i)} deveria ser “${c.header}” (${got ? `está “${got}”` : 'está vazia'})`)
  })
  for (let i = COLS; i < header.length; i++) {
    const got = headText(header[i])
    if (got) out.push(`coluna ${letter(i)} (“${got}”) não faz parte do modelo`)
  }
  return out
}

/** chave do código para achar códigos "iguais" escritos de outro jeito: sem zeros à esquerda, minúsculas */
export const carrierCodeKey = (code: string) => code.toLowerCase().replace(/^0+(?=.)/, '')

const numberSort = (a: string, b: string) => a.localeCompare(b, 'pt-BR', { numeric: true })

/**
 * LÊ a planilha (cabeçalho + linhas de dados): devolve as transportadoras válidas, os ERROS (bloqueiam:
 * cabeçalho diferente, código vazio/inválido/repetido, nome vazio, texto longo demais, erro do Excel,
 * fórmula sem valor salvo, linha oculta/filtrada, linhas demais) e os AVISOS (nomes repetidos = filiais,
 * nomes quase iguais, transportadoras especiais, nomes no limite do ERP, células "..", valores fora das colunas).
 */
export function parseCarrierSheet(header: CellValue[], rows: SheetRow[]): ParsedCarrierSheet {
  const errors: SheetIssue[] = []
  const warnings: SheetIssue[] = []
  const empty = (): ParsedCarrierSheet => ({ carriers: [], errors, warnings, sameName: [], nearNames: [], specials: [] })
  const head = carrierHeaderProblems(header)
  if (head.length) {
    errors.push({ rows: [1], message: `Cabeçalho diferente do modelo: ${head.join('; ')}. A linha 1 da primeira aba deve ser: ${CARRIER_SHEET_COLUMNS.map((c) => c.header).join(' | ')}.` })
    return empty()
  }

  // linha sem nenhum valor (ou só com "..") não conta; com fórmula sem valor salvo nas colunas do modelo, conta
  const data = rows.filter((r) => r.cells.some((c) => cellText(c, false).value != null) || (r.noFormulaValue ?? []).some((i) => i < COLS))
  if (!data.length) {
    errors.push({ rows: [], message: 'A planilha não tem transportadoras abaixo do cabeçalho.' })
    return empty()
  }
  if (data.length > MAX_CARRIER_ROWS) {
    errors.push({ rows: [], message: `A planilha tem mais de ${MAX_CARRIER_ROWS.toLocaleString('pt-BR')} linhas com dados — não parece a lista de transportadoras do ERP.` })
    return empty()
  }

  const noCode: number[] = []
  const badCode: number[] = []
  const noName: number[] = []
  const tooLong: SheetIssue[] = []
  const placeholders: number[] = []
  const outside: number[] = []
  const hidden: number[] = []
  /** chave = cabeçalho da coluna */
  const excelErrors: { key: string; row: number }[] = []
  const errorTexts = new Map<string, Set<string>>()
  const noValue: { key: string; row: number }[] = []
  const codes: { key: string; row: number }[] = []
  const valid: ImportedCarrier[] = []

  for (const r of data) {
    const v: Record<'code' | 'name', string | null> = { code: null, name: null }
    let placeholderName = false
    /** colunas com erro do Excel ou fórmula sem valor (não viram "vazio" nas outras mensagens) */
    const flagged = new Set<'code' | 'name'>()
    let rowOk = true
    if (r.hidden) {
      hidden.push(r.row)
      rowOk = false
    }
    CARRIER_SHEET_COLUMNS.forEach((c, i) => {
      const t = cellText(r.cells[i], false)
      v[c.field] = t.value
      if (r.noFormulaValue?.includes(i)) {
        noValue.push({ key: c.header, row: r.row })
        flagged.add(c.field)
        v[c.field] = null
        rowOk = false
        return
      }
      if (t.value && EXCEL_ERROR.test(t.value)) {
        excelErrors.push({ key: c.header, row: r.row })
        errorTexts.set(c.header, (errorTexts.get(c.header) ?? new Set()).add(t.value.toUpperCase()))
        flagged.add(c.field)
        v[c.field] = null
        rowOk = false
        return
      }
      if (t.placeholder && c.field === 'name') {
        // o ERP tem transportadora com nome "..": entra tal qual (o código é o vínculo)
        v.name = String(r.cells[i]).normalize('NFC').replace(/\s+/g, ' ').trim()
        placeholderName = true
      } else if (t.placeholder) placeholders.push(r.row)
      const max = c.field === 'code' ? MAX_CODE : MAX_NAME
      if (t.value && t.value.length > max) {
        tooLong.push({ rows: [r.row], message: `“${c.header}” com ${t.value.length.toLocaleString('pt-BR')} caracteres (máx. ${max.toLocaleString('pt-BR')}).` })
        rowOk = false
      }
    })
    if (r.cells.slice(COLS).some((c) => cellText(c, false).value != null)) outside.push(r.row)

    const rawCode = r.cells[0]
    if (v.code == null) {
      if (!flagged.has('code')) noCode.push(r.row)
      rowOk = false
    } else if (typeof rawCode === 'number' && (!Number.isInteger(rawCode) || rawCode < 0)) {
      badCode.push(r.row)
      rowOk = false
    } else codes.push({ key: v.code, row: r.row })

    if (v.name == null) {
      if (!flagged.has('name')) noName.push(r.row)
      rowOk = false
    }

    if (rowOk && v.code != null && v.name != null) {
      // o tamanho que o ERP gravou (antes de juntar os espaços repetidos)
      const rawName = r.cells[1]
      const erpLength = typeof rawName === 'string' ? rawName.normalize('NFC').trim().length : v.name.length
      valid.push({ row: r.row, code: v.code, name: v.name, maybeTruncated: !placeholderName && erpLength >= ERP_NAME_MAX, erpLength, placeholderName })
    }
  }

  // ERROS
  if (noCode.length) errors.push({ rows: noCode, message: 'Código vazio.' })
  if (badCode.length) errors.push({ rows: badCode, message: 'Código inválido (número negativo ou com casas decimais).' })
  const dupCodes = new Set<string>()
  for (const [code, at] of group(codes)) {
    if (at.length < 2) continue
    dupCodes.add(code)
    errors.push({ rows: at, message: `Código ${code} repetido (${at.length} linhas): cada transportadora precisa de um código único.` })
  }
  // "012" × "12" (ou "a7" × "A7") na mesma planilha: para o ERP é o mesmo código
  const byKey = new Map<string, { codes: Set<string>; rows: number[] }>()
  for (const c of codes) {
    const k = carrierCodeKey(c.key)
    const g = byKey.get(k) ?? { codes: new Set<string>(), rows: [] }
    g.codes.add(c.key)
    g.rows.push(c.row)
    byKey.set(k, g)
  }
  const nearDup = new Set<string>()
  for (const g of byKey.values()) {
    if (g.codes.size < 2) continue
    for (const c of g.codes) nearDup.add(c)
    errors.push({ rows: g.rows, message: `Códigos que só diferem nos zeros à esquerda ou em maiúsculas: ${[...g.codes].join(' × ')}. Deixe um código só para cada transportadora.` })
  }
  if (noName.length) errors.push({ rows: noName, message: 'Nome da transportadora (Descr.transportador) vazio.' })
  errors.push(...tooLong)
  for (const [col, at] of group(excelErrors))
    errors.push({ rows: at, message: `Erro do Excel (${[...(errorTexts.get(col) ?? [])].join(', ')}) em “${col}”: corrija a fórmula ou digite o valor certo.` })
  for (const [col, at] of group(noValue))
    errors.push({
      rows: at,
      message: `Fórmula sem valor salvo em “${col}” (ou com resultado vazio, que o leitor não distingue): no Excel, copie a planilha e cole como valores (Colar especial › Valores), salve e gere a prévia de novo.`,
    })
  if (hidden.length)
    errors.push({
      rows: hidden,
      message: `${hidden.length} linha(s) oculta(s) ou filtrada(s) no Excel. Para importá-las, limpe o filtro e reexiba as linhas; para deixá-las de fora, exclua essas linhas da planilha. Depois salve e gere a prévia de novo.`,
    })

  // linhas com código repetido não entram (o erro já bloqueia)
  const carriers = valid.filter((c) => !dupCodes.has(c.code) && !nearDup.has(c.code))

  // AVISOS
  // nomes só com pontos não são agrupados (a chave fica vazia)
  const named = carriers.filter((c) => !c.placeholderName)
  const byName = new Map<string, SameNameGroup>()
  for (const c of named) {
    const k = nameKey(c.name)
    const g = byName.get(k) ?? { name: c.name, codes: [], rows: [] }
    g.codes.push(c.code)
    g.rows.push(c.row)
    byName.set(k, g)
  }
  const sameName = [...byName.values()].filter((g) => g.codes.length > 1).sort((a, b) => b.codes.length - a.codes.length || a.name.localeCompare(b.name, 'pt-BR'))
  if (sameName.length) {
    const rowsOf = sameName.flatMap((g) => g.rows).sort((a, b) => a - b)
    const top = sameName
      .slice(0, 4)
      .map((g) => `${g.name} (${g.codes.length})`)
      .join(', ')
    const ex = sameName[0]
    warnings.push({
      rows: rowsOf,
      message: `${sameName.length} nome(s) aparecem com mais de um código (${rowsOf.length} linhas): são filiais e TODAS serão importadas, cada uma com o seu código. Na escolha da transportadora elas se distinguem pelo código (ex.: “${transportCompanyLabel({ code: ex.codes[0], name: ex.name })}”). Mais repetidos: ${top}${sameName.length > 4 ? ', …' : ''}.`,
    })
  }

  // mesmo nome sem espaços, mas grafado diferente (nameKey diferente): pode ser a mesma empresa
  const compact = new Map<string, { keys: Map<string, string>; codes: string[]; rows: number[] }>()
  for (const c of named) {
    const k = nameKey(c.name)
    const ck = k.replace(/ /g, '')
    const g = compact.get(ck) ?? { keys: new Map<string, string>(), codes: [], rows: [] }
    if (!g.keys.has(k)) g.keys.set(k, c.name)
    g.codes.push(c.code)
    g.rows.push(c.row)
    compact.set(ck, g)
  }
  const nearNames: NearNameGroup[] = [...compact.values()].filter((g) => g.keys.size > 1).map((g) => ({ names: [...g.keys.values()], codes: g.codes, rows: g.rows }))
  for (const g of nearNames)
    warnings.push({ rows: g.rows, message: `Nomes quase iguais (podem ser a mesma empresa): ${g.names.map((x) => `“${x}”`).join(' × ')} — códigos ${g.codes.join(', ')}. Todos entram como estão.` })

  const specials: SpecialCarrier[] = []
  for (const c of named) {
    const kind = specialTransportCompany({ code: c.code, name: c.name })
    if (kind) specials.push({ row: c.row, code: c.code, name: c.name, kind, label: SPECIAL_TRANSPORT_LABEL[kind] })
  }
  if (specials.length) {
    const byKind = new Map<string, SpecialCarrier[]>()
    for (const sp of specials) byKind.set(sp.label, [...(byKind.get(sp.label) ?? []), sp])
    const list = [...byKind.entries()].map(([label, l]) => `${label}: ${l.map((x) => `${x.name} (${x.code})`).join(', ')}`).join('; ')
    warnings.push({
      rows: specials.map((x) => x.row),
      message: `${specials.length} transportadora(s) especial(is) do ERP (não são empresas de transporte) entram como estão e aparecem à parte na escolha da transportadora — ${list}.`,
    })
  }

  const cut = carriers.filter((c) => c.maybeTruncated)
  if (cut.length)
    warnings.push({
      rows: cut.map((c) => c.row),
      message: `${cut.length} nome(s) com ${ERP_NAME_MAX} caracteres, o limite do ERP: podem estar cortados (ex.: “${cut[0].name}”). Se completar um nome em Cadastros › Transportadoras, as próximas importações mantêm o nome completado (vale também para nomes de ${ERP_CUT_MIN}–${ERP_NAME_MAX - 1} caracteres, que o ERP pode ter cortado num espaço).`,
    })
  const noNameList = carriers.filter((c) => c.placeholderName)
  if (noNameList.length)
    warnings.push({
      rows: noNameList.map((c) => c.row),
      message: `${noNameList.length} transportadora(s) sem nome no ERP (só pontos ou traços), código(s) ${noNameList.map((c) => c.code).join(', ')}: entram com o nome “${noNameList[0].name}”, tal qual. Para dar um nome, edite em Cadastros › Transportadoras: as próximas importações não o sobrescrevem.`,
    })
  if (placeholders.length) warnings.push({ rows: [...new Set(placeholders)], message: 'Códigos só com pontos ou traços (ex.: “..”) foram tratados como vazios.' })
  if (outside.length) warnings.push({ rows: outside, message: `Valores depois da coluna ${letter(COLS - 1)} (fora do modelo) foram ignorados.` })

  return { carriers, errors, warnings, sameName, nearNames, specials }
}

// ---------------------------------------------------------------------------
// Plano (ATUALIZAR PELO CÓDIGO)
// ---------------------------------------------------------------------------

/** transportadora atual no banco (o que o plano precisa) */
export interface CurrentCarrier {
  id: number
  code: string
  name: string
  active: boolean
}

/** nome que muda (de → para) numa transportadora existente */
export interface CarrierRename {
  id: number
  code: string
  row: number
  de: string
  para: string
  /** outro nome de verdade (não só maiúsculas, acentos, pontuação ou um pedaço a mais/a menos): conferir o código */
  otherCompany: boolean
}

/** código da planilha que não existe no sistema, mas só difere de um código atual nos zeros à esquerda ou em maiúsculas */
export interface NearCarrierCode {
  code: string
  row: number
  /** código atual no sistema (ex.: planilha "12", sistema "012") */
  existing: string
  id: number
}

export interface CarrierImportPlan {
  toInsert: number
  toRename: number
  /** códigos da planilha já cadastrados com o mesmo nome */
  unchanged: number
  /** códigos novos (criados ativos), na ordem da planilha */
  insertCodes: string[]
  renames: CarrierRename[]
  /** nome cortado pelo ERP (30–32 caracteres) que no sistema foi COMPLETADO: o nome do sistema fica */
  keptComplete: { id: number; code: string; row: number; sheetName: string; name: string }[]
  /** cadastradas no sistema que estão na planilha, mas INATIVAS: continuam inativas */
  inactiveInSheet: { id: number; code: string; name: string; row: number }[]
  /** cadastradas no sistema com código fora da planilha: não são tocadas */
  notInSheet: { id: number; code: string; name: string; active: boolean }[]
  /** BLOQUEIAM a aplicação: a mesma transportadora seria criada de novo com outro código */
  nearCodes: NearCarrierCode[]
}

/** nome para comparar: sem acentos, minúsculas, espaços repetidos reduzidos a um (a pontuação conta) */
const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

/**
 * o nome do sistema é o nome da planilha, cortado pelo ERP, COMPLETADO: começa com ele e é mais longo (acentos,
 * maiúsculas e espaços repetidos não contam). Com 32 caracteres no ERP o corte pode cair no meio de uma palavra;
 * com 30–31 só num espaço (o ERP grava sem os espaços do fim), então o completado tem de seguir com um espaço.
 */
const completes = (current: string, s: ImportedCarrier) => {
  if (s.placeholderName || s.erpLength < ERP_CUT_MIN) return false
  const a = fold(current)
  const b = fold(s.name)
  return a.length > b.length && a.startsWith(s.erpLength >= ERP_NAME_MAX ? b : `${b} `)
}

/** outro nome de verdade: as chaves (sem acento/pontuação) diferem e uma não é o começo da outra */
const otherName = (a: string, b: string) => {
  const x = nameKey(a)
  const y = nameKey(b)
  return !(x === y || x.startsWith(y) || y.startsWith(x))
}

/**
 * PLANO do modo "atualizar pelo código" a partir das transportadoras válidas da planilha e das atuais:
 * código novo → cria (ativa); código existente → grava o NOME só se mudou (exceto nome cortado pelo ERP que
 * no sistema foi completado); nunca apaga, nunca muda "ativa", contato, telefone, e-mail nem observações.
 */
export function planCarrierImport(sheet: ImportedCarrier[], current: CurrentCarrier[]): CarrierImportPlan {
  const byCode = new Map(current.map((c) => [c.code, c]))
  const byKey = new Map(current.map((c) => [carrierCodeKey(c.code), c]))
  const insertCodes: string[] = []
  const renames: CarrierRename[] = []
  const keptComplete: CarrierImportPlan['keptComplete'] = []
  const inactiveInSheet: CarrierImportPlan['inactiveInSheet'] = []
  const nearCodes: NearCarrierCode[] = []
  let unchanged = 0
  for (const s of sheet) {
    const cur = byCode.get(s.code)
    if (!cur) {
      insertCodes.push(s.code)
      const near = byKey.get(carrierCodeKey(s.code))
      if (near) nearCodes.push({ code: s.code, row: s.row, existing: near.code, id: near.id })
      continue
    }
    if (!cur.active) inactiveInSheet.push({ id: cur.id, code: cur.code, name: cur.name, row: s.row })
    // nome só com pontos no ERP não sobrescreve o nome do sistema
    if (cur.name === s.name || s.placeholderName) unchanged++
    else if (completes(cur.name, s)) keptComplete.push({ id: cur.id, code: s.code, row: s.row, sheetName: s.name, name: cur.name })
    else renames.push({ id: cur.id, code: s.code, row: s.row, de: cur.name, para: s.name, otherCompany: otherName(cur.name, s.name) })
  }
  const sheetCodes = new Set(sheet.map((s) => s.code))
  const notInSheet = current
    .filter((c) => !sheetCodes.has(c.code))
    .map((c) => ({ id: c.id, code: c.code, name: c.name, active: c.active }))
    .sort((a, b) => numberSort(a.code, b.code))
  return { toInsert: insertCodes.length, toRename: renames.length, unchanged, insertCodes, renames, keptComplete, inactiveInSheet, notInSheet, nearCodes }
}

/** mensagem do bloqueio por códigos que só diferem nos zeros à esquerda/maiúsculas (servidor e tela) */
export function nearCarrierCodeMessage(list: NearCarrierCode[]): string {
  const shown = list
    .slice(0, 5)
    .map((x) => `${x.code} (linha ${x.row}) × ${x.existing} no sistema`)
    .join('; ')
  return `${list.length} código(s) da planilha só diferem de um código do sistema nos zeros à esquerda ou em maiúsculas: ${shown}${list.length > 5 ? '; …' : ''}. Atualizar criaria a mesma transportadora de novo, com outro código. Corrija o código na planilha (coluna Código como Texto) ou em Cadastros › Transportadoras e gere a prévia de novo.`
}

/** avisos do plano (dependem das transportadoras atuais): nomes que mudam de verdade, inativas, completadas */
export function carrierPlanWarnings(plan: CarrierImportPlan): SheetIssue[] {
  const out: SheetIssue[] = []
  const other = plan.renames.filter((r) => r.otherCompany)
  if (other.length)
    out.push({
      rows: other.map((r) => r.row),
      message: `${other.length} transportadora(s) do sistema passam a ter OUTRO nome (ex.: código ${other[0].code}: “${other[0].de}” → “${other[0].para}”). Confira se o código é mesmo dessa transportadora: as cargas já vinculadas a ela passam a mostrar o nome novo.`,
    })
  if (plan.inactiveInSheet.length)
    out.push({
      rows: plan.inactiveInSheet.map((x) => x.row),
      message: `${plan.inactiveInSheet.length} transportadora(s) da planilha estão INATIVAS no sistema e continuam inativas (para usar, reative em Cadastros › Transportadoras): ${plan.inactiveInSheet
        .slice(0, 5)
        .map((x) => `${x.name} (${x.code})`)
        .join(', ')}${plan.inactiveInSheet.length > 5 ? ', …' : ''}.`,
    })
  if (plan.keptComplete.length)
    out.push({
      rows: plan.keptComplete.map((x) => x.row),
      message: `${plan.keptComplete.length} nome(s) foram completados no sistema (a planilha traz o nome cortado pelo ERP) e ficam como estão (ex.: código ${plan.keptComplete[0].code}: “${plan.keptComplete[0].name}”).`,
    })
  return out
}

// ---------------------------------------------------------------------------
// Confirmação
// ---------------------------------------------------------------------------

/** palavra que o usuário digita para confirmar (exatamente assim, maiúsculas) */
export const CARRIER_UPDATE_WORD = 'ATUALIZAR'

export interface CarrierApplyInput {
  /** sha256 do arquivo na prévia: a aplicação recebe o MESMO arquivo de novo */
  fileSha256: string
  dryRun: boolean
  confirm: string
}

const SHA = /^[0-9a-f]{64}$/

/** Confere o pedido de aplicação (antes de tocar no banco). null = ok; senão a mensagem. A simulação não exige a palavra. */
export function validateCarrierApplyInput(i: Partial<CarrierApplyInput> | null | undefined): string | null {
  if (!i || typeof i !== 'object') return 'Pedido inválido.'
  if (typeof i.fileSha256 !== 'string' || !SHA.test(i.fileSha256)) return 'Gere a prévia da planilha antes de aplicar.'
  if (i.dryRun === true) return null
  if (typeof i.confirm !== 'string' || i.confirm.trim() !== CARRIER_UPDATE_WORD) return `Digite ${CARRIER_UPDATE_WORD} (em maiúsculas) para confirmar.`
  return null
}

/** contagens da tabela de transportadoras (cartão, prévia e auditoria) */
export interface CarrierCounts {
  total: number
  active: number
  inactive: number
}

export const carrierCountsOf = (list: { active: boolean }[]): CarrierCounts => {
  const active = list.filter((c) => c.active).length
  return { total: list.length, active, inactive: list.length - active }
}
