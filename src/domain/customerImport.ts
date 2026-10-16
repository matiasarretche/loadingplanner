/**
 * IMPORTAÇÃO DOS CLIENTES DE EXPORTAÇÃO pela planilha (Manutenção › Clientes de exportação): leitura das
 * linhas já tiradas do .xlsx, validação, plano contra os clientes atuais e regras da confirmação.
 * Puro (sem banco nem arquivo): a tela, o servidor e os testes usam as mesmas regras.
 *
 * Contrato da planilha: primeira aba, linha 1 = cabeçalho EXATO (colunas A–K, nesta ordem):
 *   Código | Razão social | Endereço | Complemento | Bairro | Cidade | Estado/Província | Código postal | País | ID fiscal | Observações
 * Código e razão social obrigatórios; código único na planilha; país reconhecido pelo sistema (gravado com o
 * nome oficial em português); células vazias → null; espaços nas pontas removidos. Bloqueiam a planilha:
 * linhas ocultas/filtradas no Excel, células com erro do Excel (#N/A, #REF!…) e fórmulas sem valor salvo.
 * No modo "atualizar pelo código", Observações vazias na planilha mantêm as do sistema.
 */
import { canonicalCountry } from '@/lib/countries'

export type CellValue = string | number | null

/** colunas da planilha, na ordem (A–K), com o cabeçalho exato da linha 1 */
export const CUSTOMER_SHEET_COLUMNS = [
  { field: 'code', header: 'Código' },
  { field: 'name', header: 'Razão social' },
  { field: 'address', header: 'Endereço' },
  { field: 'addressComplement', header: 'Complemento' },
  { field: 'district', header: 'Bairro' },
  { field: 'city', header: 'Cidade' },
  { field: 'state', header: 'Estado/Província' },
  { field: 'postalCode', header: 'Código postal' },
  { field: 'country', header: 'País' },
  { field: 'taxId', header: 'ID fiscal' },
  { field: 'notes', header: 'Observações' },
] as const

export type CustomerField = (typeof CUSTOMER_SHEET_COLUMNS)[number]['field']

/** nome da coluna (cabeçalho) de cada campo, para as mensagens e a prévia */
export const FIELD_LABEL = Object.fromEntries(CUSTOMER_SHEET_COLUMNS.map((c) => [c.field, c.header])) as Record<CustomerField, string>

/** campo que o modo "atualizar" compara e regrava (o código só identifica o cliente) */
export type UpdatedField = Exclude<CustomerField, 'code'>

/** campos que a planilha grava no cliente (o código identifica; os outros são comparados no modo "atualizar") */
export const UPDATED_FIELDS: UpdatedField[] = ['name', 'address', 'addressComplement', 'district', 'city', 'state', 'postalCode', 'country', 'taxId', 'notes']

/**
 * Campos que, VAZIOS na planilha, não apagam o valor do sistema no modo "atualizar": as Observações não vêm do
 * ERP (são escritas em Cadastros). Para apagá-las, edite o cliente em Cadastros.
 */
export const KEEP_WHEN_EMPTY: readonly UpdatedField[] = ['notes']

/** dados de um cliente como ficam gravados (customer) */
export interface CustomerData {
  code: string
  name: string
  address: string | null
  addressComplement: string | null
  district: string | null
  city: string | null
  state: string | null
  postalCode: string | null
  /** nome oficial do país no sistema (canonicalCountry) */
  country: string
  taxId: string | null
  notes: string | null
}

/** cliente lido da planilha (com a linha, para as mensagens) */
export interface ImportedCustomer extends CustomerData {
  row: number
}

/** linha de dados da planilha: número da linha no Excel + células da coluna A em diante */
export interface SheetRow {
  row: number
  cells: CellValue[]
  /** linha oculta ou filtrada no Excel */
  hidden?: boolean
  /** colunas (0 = A) com fórmula sem valor salvo no arquivo (o leitor não distingue de resultado vazio) */
  noFormulaValue?: number[]
}

/** erro (bloqueia) ou aviso, com as linhas da planilha a que se refere (vazio = a planilha inteira) */
export interface SheetIssue {
  rows: number[]
  message: string
}

export interface ParsedCustomerSheet {
  customers: ImportedCustomer[]
  errors: SheetIssue[]
  warnings: SheetIssue[]
}

/** mais linhas de dados que isso = arquivo errado (a carteira tem ~250) */
export const MAX_CUSTOMER_ROWS = 5000
/** tamanho máximo de um texto de célula (Observações tem mais espaço) */
export const MAX_TEXT = 500
export const MAX_NOTES = 2000

const COLS = CUSTOMER_SHEET_COLUMNS.length
const letter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `${String.fromCharCode(64 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`)

/** texto do cabeçalho comparável: Unicode composto, espaços repetidos viram um, sem espaços nas pontas */
const headText = (v: CellValue | undefined) => (v == null ? '' : String(v).normalize('NFC').replace(/\s+/g, ' ').trim())

/** Problemas do cabeçalho (linha 1). Lista vazia = cabeçalho igual ao modelo. */
export function headerProblems(header: CellValue[]): string[] {
  const out: string[] = []
  CUSTOMER_SHEET_COLUMNS.forEach((c, i) => {
    const got = headText(header[i])
    if (got !== c.header) out.push(`coluna ${letter(i)} deveria ser “${c.header}” (${got ? `está “${got}”` : 'está vazia'})`)
  })
  for (let i = COLS; i < header.length; i++) {
    const got = headText(header[i])
    if (got) out.push(`coluna ${letter(i)} (“${got}”) não faz parte do modelo`)
  }
  return out
}

/** célula só com pontos/traços (".." do ERP): tratada como vazia */
const PLACEHOLDER = /^[.\-–—_]+$/

/**
 * Texto de uma célula: número → texto (inteiro sem casas); texto → Unicode composto, sem espaços nas pontas e
 * (fora das Observações) numa linha só, com espaços repetidos reduzidos. Vazio → null.
 */
function cellText(v: CellValue | undefined, multiline: boolean): { value: string | null; placeholder: boolean } {
  if (v == null) return { value: null, placeholder: false }
  if (typeof v === 'number') return { value: Number.isFinite(v) ? (Number.isInteger(v) ? v.toFixed(0) : String(v)) : null, placeholder: false }
  let t = String(v).normalize('NFC')
  t = multiline
    ? t
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((l) => l.replace(/[^\S\n]+/g, ' ').trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    : t.replace(/\s+/g, ' ').trim()
  if (!t) return { value: null, placeholder: false }
  if (PLACEHOLDER.test(t)) return { value: null, placeholder: true }
  return { value: t, placeholder: false }
}

/** valor de erro do Excel (gravado como erro ou colado como texto): #N/A, #REF!… (também em pt-BR/es) */
const EXCEL_ERROR = /^#[¡¿]?(N\/A|N\/D|NULL!|NULO!|DIV\/0!|VALUE!|VALOR!|REF!|NAME\?|NOME\?|NOMBRE\?|NUM!|NÚM!|SPILL!|DESPEJAR!|CALC!|GETTING_DATA|FIELD!|CAMPO!|BLOCKED!|CONNECT!|BUSY!|UNKNOWN!)$/i

/** separa as seções de um formato do Excel (";" fora de aspas) */
function formatSections(fmt: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i]
    if (ch === '\\' && i + 1 < fmt.length) {
      cur += ch + fmt[++i]
      continue
    }
    if (ch === '"') quoted = !quoted
    if (ch === ';' && !quoted) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

const CONDITION = /^\[(<=|>=|<>|<|>|=)(\d+(?:\.\d+)?)\]/
const meets = (v: number, op: string, n: number) => (op === '<=' ? v <= n : op === '>=' ? v >= n : op === '<' ? v < n : op === '>' ? v > n : op === '=' ? v === n : v !== n)

/**
 * Número inteiro ≥ 0 numa célula com formato de ZEROS (ex.: "00000", "00000-000", 000"."000"."000-00, o
 * "[<=99999]00000;00000-0000" do CEP americano) → o texto que o Excel mostra, com os zeros à esquerda e os
 * separadores. Outro formato (Geral, "0", decimais, "#", datas…) → null (o número fica como está).
 */
export function zeroPaddedText(v: number, numFmt: string | null | undefined): string | null {
  if (!numFmt || !Number.isSafeInteger(v) || v < 0) return null
  const sections = formatSections(numFmt)
  let section = sections[0]
  const cond = CONDITION.exec(section)
  if (cond) {
    if (!meets(v, cond[1], Number(cond[2]))) section = sections[1] ?? ''
    section = section.replace(CONDITION, '')
  }
  // cor e idioma ([Red], [$-416]) não mudam os dígitos
  section = section.replace(/\[[^\]]*\]/g, '')
  const parts: (string | 0)[] = []
  for (let i = 0; i < section.length; i++) {
    const ch = section[i]
    if (ch === '0') parts.push(0)
    else if (ch === '"') {
      const end = section.indexOf('"', i + 1)
      if (end < 0) return null
      parts.push(section.slice(i + 1, end))
      i = end
    } else if (ch === '\\' && i + 1 < section.length) parts.push(section[++i])
    else if ('- ()'.includes(ch)) parts.push(ch)
    else return null
  }
  const slots = parts.filter((p) => p === 0).length
  if (slots < 2) return null
  const digits = String(v).padStart(slots, '0')
  // dígitos a mais ficam no primeiro marcador (como no Excel)
  let at = 0
  let first = true
  let out = ''
  for (const p of parts) {
    if (p !== 0) {
      out += p
      continue
    }
    const take = first ? digits.length - slots + 1 : 1
    out += digits.slice(at, at + take)
    at += take
    first = false
  }
  return out
}

/** chave para achar razões sociais repetidas: sem acento, sem pontuação, minúsculas */
export const nameKey = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** agrupa linhas por chave, mantendo a ordem da primeira aparição */
function group(list: { key: string; row: number }[]): Map<string, number[]> {
  const m = new Map<string, number[]>()
  for (const x of list) m.set(x.key, [...(m.get(x.key) ?? []), x.row])
  return m
}

/**
 * LÊ a planilha (cabeçalho + linhas de dados): devolve os clientes válidos, os ERROS (bloqueiam a aplicação:
 * cabeçalho diferente, código vazio/repetido/inválido, razão social vazia, país vazio ou não reconhecido,
 * texto longo demais, erro do Excel (#N/A…), fórmula sem valor salvo, linha oculta/filtrada) e os AVISOS
 * (razão social repetida, sem cidade/endereço, país com outra grafia, células "..", valores fora das colunas
 * do modelo, código postal/ID fiscal gravado como número).
 */
export function parseCustomerSheet(header: CellValue[], rows: SheetRow[]): ParsedCustomerSheet {
  const errors: SheetIssue[] = []
  const warnings: SheetIssue[] = []
  const head = headerProblems(header)
  if (head.length) {
    errors.push({ rows: [1], message: `Cabeçalho diferente do modelo: ${head.join('; ')}. A linha 1 da primeira aba deve ser exatamente: ${CUSTOMER_SHEET_COLUMNS.map((c) => c.header).join(' | ')}.` })
    return { customers: [], errors, warnings }
  }

  // linha sem nenhum valor (ou só com "..") não conta; com fórmula sem valor salvo nas colunas do modelo, conta
  const data = rows.filter((r) => r.cells.some((c) => cellText(c, true).value != null) || (r.noFormulaValue ?? []).some((i) => i < COLS))
  if (!data.length) {
    errors.push({ rows: [], message: 'A planilha não tem clientes abaixo do cabeçalho.' })
    return { customers: [], errors, warnings }
  }
  if (data.length > MAX_CUSTOMER_ROWS) {
    errors.push({ rows: [], message: `A planilha tem mais de ${MAX_CUSTOMER_ROWS.toLocaleString('pt-BR')} linhas com dados — não parece a carteira de clientes.` })
    return { customers: [], errors, warnings }
  }

  const noCode: number[] = []
  const badCode: number[] = []
  const noName: number[] = []
  const noCountry: number[] = []
  const unknownCountry: { key: string; row: number }[] = []
  const respelled: { key: string; row: number }[] = []
  const placeholders: number[] = []
  const outside: number[] = []
  const noCity: number[] = []
  const noAddress: number[] = []
  const codes: { key: string; row: number }[] = []
  const names: { key: string; row: number }[] = []
  const nameShown = new Map<string, string>()
  const tooLong: SheetIssue[] = []
  /** chave = cabeçalho da coluna */
  const excelErrors: { key: string; row: number }[] = []
  const errorTexts = new Map<string, Set<string>>()
  const noValue: { key: string; row: number }[] = []
  const hidden: number[] = []
  const numericIds: number[] = []
  const valid: ImportedCustomer[] = []

  for (const r of data) {
    const v = {} as Record<CustomerField, string | null>
    /** colunas com erro do Excel ou fórmula sem valor (não viram "vazio" nas outras mensagens) */
    const flagged = new Set<CustomerField>()
    let hasPlaceholder = false
    let rowOk = true
    if (r.hidden) {
      hidden.push(r.row)
      rowOk = false
    }
    CUSTOMER_SHEET_COLUMNS.forEach((c, i) => {
      const t = cellText(r.cells[i], c.field === 'notes')
      v[c.field] = t.value
      if (r.noFormulaValue?.includes(i)) {
        noValue.push({ key: c.header, row: r.row })
        flagged.add(c.field)
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
      if (t.placeholder) hasPlaceholder = true
      const max = c.field === 'notes' ? MAX_NOTES : MAX_TEXT
      if (t.value && t.value.length > max) {
        tooLong.push({ rows: [r.row], message: `“${c.header}” com ${t.value.length.toLocaleString('pt-BR')} caracteres (máx. ${max.toLocaleString('pt-BR')}).` })
        rowOk = false
      }
    })
    if (hasPlaceholder) placeholders.push(r.row)
    if (r.cells.slice(COLS).some((c) => cellText(c, true).value != null)) outside.push(r.row)
    // gravado como número no Excel: um zero à esquerda já se perdeu (o leitor só recupera com formato de zeros)
    if ((typeof r.cells[7] === 'number' && v.postalCode != null) || (typeof r.cells[9] === 'number' && v.taxId != null)) numericIds.push(r.row)

    const rawCode = r.cells[0]
    if (v.code == null) {
      if (!flagged.has('code')) noCode.push(r.row)
      rowOk = false
    } else if (typeof rawCode === 'number' && !Number.isInteger(rawCode)) {
      badCode.push(r.row)
      rowOk = false
    } else codes.push({ key: v.code, row: r.row })

    if (v.name == null) {
      if (!flagged.has('name')) noName.push(r.row)
      rowOk = false
    } else {
      const k = nameKey(v.name)
      names.push({ key: k, row: r.row })
      if (!nameShown.has(k)) nameShown.set(k, v.name)
    }

    let country: string | null = null
    if (v.country == null) {
      if (!flagged.has('country')) noCountry.push(r.row)
      rowOk = false
    } else {
      country = canonicalCountry(v.country)
      if (!country) {
        unknownCountry.push({ key: v.country, row: r.row })
        rowOk = false
      } else if (country !== v.country) respelled.push({ key: `${v.country}\u0000${country}`, row: r.row })
    }
    if (v.city == null && !flagged.has('city')) noCity.push(r.row)
    if (v.address == null && !flagged.has('address')) noAddress.push(r.row)

    if (rowOk && v.code != null && v.name != null && country != null)
      valid.push({
        row: r.row,
        code: v.code,
        name: v.name,
        address: v.address,
        addressComplement: v.addressComplement,
        district: v.district,
        city: v.city,
        state: v.state,
        postalCode: v.postalCode,
        country,
        taxId: v.taxId,
        notes: v.notes,
      })
  }

  // ERROS
  if (noCode.length) errors.push({ rows: noCode, message: 'Código vazio.' })
  if (badCode.length) errors.push({ rows: badCode, message: 'Código inválido (número com casas decimais).' })
  const dupCodes = new Set<string>()
  for (const [code, at] of group(codes)) {
    if (at.length < 2) continue
    dupCodes.add(code)
    errors.push({ rows: at, message: `Código ${code} repetido (${at.length} linhas): cada cliente precisa de um código único.` })
  }
  if (noName.length) errors.push({ rows: noName, message: 'Razão social vazia.' })
  if (noCountry.length) errors.push({ rows: noCountry, message: 'País vazio.' })
  for (const [raw, at] of group(unknownCountry)) errors.push({ rows: at, message: `País não reconhecido: “${raw}”. Use o nome do país em português (ex.: Estados Unidos, Países Baixos).` })
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

  // AVISOS
  for (const [k, at] of group(names)) if (at.length > 1) warnings.push({ rows: at, message: `Razão social repetida (${at.length} linhas): “${nameShown.get(k)}”. Na escolha do cliente as opções ficam parecidas.` })
  for (const [k, at] of group(respelled)) {
    const [raw, canon] = k.split('\u0000')
    warnings.push({ rows: at, message: `País “${raw}” será gravado como “${canon}” (nome oficial no sistema).` })
  }
  if (noCity.length) warnings.push({ rows: noCity, message: `${noCity.length} cliente(s) sem cidade.` })
  if (noAddress.length) warnings.push({ rows: noAddress, message: `${noAddress.length} cliente(s) sem endereço (rua e número).` })
  if (placeholders.length) warnings.push({ rows: placeholders, message: 'Células só com pontos ou traços (ex.: “..”) foram tratadas como vazias.' })
  if (outside.length) warnings.push({ rows: outside, message: `Valores depois da coluna ${letter(COLS - 1)} (fora do modelo) foram ignorados.` })
  if (numericIds.length)
    warnings.push({
      rows: numericIds,
      message: '“Código postal” ou “ID fiscal” gravado como número no Excel: um zero à esquerda (ex.: 02134) não chega. Se algum começava com 0, formate a coluna como Texto e digite de novo.',
    })

  // linhas com código repetido não entram (o erro já bloqueia)
  return { customers: valid.filter((c) => !dupCodes.has(c.code)), errors, warnings }
}

/** valores a gravar no cliente (sem a linha da planilha) */
export function customerValues(c: ImportedCustomer): CustomerData {
  return { code: c.code, name: c.name, address: c.address, addressComplement: c.addressComplement, district: c.district, city: c.city, state: c.state, postalCode: c.postalCode, country: c.country, taxId: c.taxId, notes: c.notes }
}

/** cliente atual no banco (o que o plano precisa) */
export interface CurrentCustomer {
  id: number
  code: string | null
  name: string
  address: string | null
  addressComplement: string | null
  district: string | null
  city: string | null
  state: string | null
  postalCode: string | null
  country: string | null
  taxId: string | null
  notes: string | null
  agentId: number | null
  active: boolean
}

/** valor atual (de) → valor da planilha (para) */
export interface FieldChange {
  de: string | null
  para: string | null
}

export interface CustomerChange {
  id: number
  code: string
  row: number
  /** razão social da planilha (a que fica gravada) */
  name: string
  /** razão social atual quando muda (o cliente é renomeado); null = a mesma */
  previousName: string | null
  /** campos que mudam (só eles são gravados) */
  fields: UpdatedField[]
  /** campos com valor no sistema que ficam VAZIOS (a planilha não traz o valor) */
  cleared: UpdatedField[]
  /** de → para de cada campo que muda (prévia e auditoria) */
  diff: Partial<Record<UpdatedField, FieldChange>>
}

/** código da planilha que não existe no sistema, mas só difere de um código atual nos zeros à esquerda */
export interface LeadingZeroCode {
  code: string
  row: number
  /** código atual no sistema (ex.: planilha "609", sistema "000609") */
  existing: string
  id: number
}

export interface CustomerImportPlan {
  /** SUBSTITUIR: apaga todos os clientes atuais e cria os da planilha */
  replace: { toDelete: number; toInsert: number; agentLinksLost: number; inactiveDeleted: number }
  /** ATUALIZAR PELO CÓDIGO: cria os códigos novos e atualiza os existentes; não apaga nada */
  update: {
    toInsert: number
    toUpdate: number
    unchanged: number
    /** clientes atuais sem código (criados pela tela): não são tocados */
    withoutCode: number
    /** clientes atuais com código que não está na planilha: não são tocados */
    notInSheet: number
    insertCodes: string[]
    changes: CustomerChange[]
    /** clientes atuais SEM código com a mesma razão social de um da planilha: o da planilha entra como novo */
    sameNameWithoutCode: { name: string; rows: number[]; ids: number[] }[]
    /**
     * códigos que só diferem de um código atual nos zeros à esquerda (ex.: código numérico no Excel): BLOQUEIAM
     * o modo atualizar, senão o mesmo cliente seria criado de novo com outro código
     */
    leadingZeroCodes: LeadingZeroCode[]
  }
}

const same = (a: string | null, b: string | null) => (a ?? null) === (b ?? null)
/** código sem os zeros à esquerda (fica ao menos um caractere) */
const withoutLeadingZeros = (code: string) => code.replace(/^0+(?=.)/, '')

/**
 * PLANO dos dois modos a partir dos clientes válidos da planilha e dos clientes atuais. No modo atualizar,
 * um campo muda quando o valor da planilha é diferente do atual, exceto Observações vazias na planilha
 * (KEEP_WHEN_EMPTY), que mantêm o valor do sistema.
 */
export function planCustomerImport(sheet: ImportedCustomer[], current: CurrentCustomer[]): CustomerImportPlan {
  const withCode = current.filter((c): c is CurrentCustomer & { code: string } => c.code != null)
  const byCode = new Map(withCode.map((c) => [c.code, c]))
  const byStripped = new Map(withCode.map((c) => [withoutLeadingZeros(c.code), c]))
  const insertCodes: string[] = []
  const changes: CustomerChange[] = []
  const leadingZeroCodes: LeadingZeroCode[] = []
  let unchanged = 0
  for (const s of sheet) {
    const cur = byCode.get(s.code)
    if (!cur) {
      insertCodes.push(s.code)
      const near = byStripped.get(withoutLeadingZeros(s.code))
      if (near) leadingZeroCodes.push({ code: s.code, row: s.row, existing: near.code, id: near.id })
      continue
    }
    const fields = UPDATED_FIELDS.filter((f) => !(s[f] == null && KEEP_WHEN_EMPTY.includes(f)) && !same(cur[f], s[f]))
    if (!fields.length) {
      unchanged++
      continue
    }
    changes.push({
      id: cur.id,
      code: s.code,
      row: s.row,
      name: s.name,
      previousName: fields.includes('name') ? cur.name : null,
      fields,
      cleared: fields.filter((f) => s[f] == null),
      diff: Object.fromEntries(fields.map((f) => [f, { de: cur[f] ?? null, para: s[f] ?? null }])),
    })
  }
  const sheetCodes = new Set(sheet.map((s) => s.code))
  const withoutCode = current.filter((c) => c.code == null)
  const noCodeByName = group(withoutCode.map((c) => ({ key: nameKey(c.name), row: c.id })))
  const inserted = new Set(insertCodes)
  const sameName = new Map<string, { name: string; rows: number[]; ids: number[] }>()
  for (const s of sheet) {
    if (!inserted.has(s.code)) continue
    const k = nameKey(s.name)
    const ids = noCodeByName.get(k)
    if (!ids) continue
    const g = sameName.get(k) ?? { name: s.name, rows: [], ids }
    g.rows.push(s.row)
    sameName.set(k, g)
  }
  return {
    replace: {
      toDelete: current.length,
      toInsert: sheet.length,
      agentLinksLost: current.filter((c) => c.agentId != null).length,
      inactiveDeleted: current.filter((c) => !c.active).length,
    },
    update: {
      toInsert: insertCodes.length,
      toUpdate: changes.length,
      unchanged,
      withoutCode: withoutCode.length,
      notInSheet: current.filter((c) => c.code != null && !sheetCodes.has(c.code)).length,
      insertCodes,
      changes,
      sameNameWithoutCode: [...sameName.values()],
      leadingZeroCodes,
    },
  }
}

/** mensagem do bloqueio do modo atualizar por códigos que só diferem nos zeros à esquerda (servidor e tela) */
export function leadingZeroMessage(list: LeadingZeroCode[]): string {
  const shown = list
    .slice(0, 5)
    .map((x) => `${x.code} (linha ${x.row}) × ${x.existing} no sistema`)
    .join('; ')
  return `${list.length} código(s) da planilha só diferem de um código do sistema nos zeros à esquerda: ${shown}${list.length > 5 ? '; …' : ''}. Atualizar criaria o mesmo cliente de novo, com outro código. Na planilha, formate a coluna Código como Texto e digite o código igual ao do sistema (ou corrija o código em Cadastros); depois gere a prévia de novo.`
}

/** "linha 3" / "linhas 3, 5 e 9" / "linhas 3, 5, 9, … (mais 12)" */
export function rowsLabel(rows: number[], max = 12): string {
  if (!rows.length) return ''
  if (rows.length === 1) return `linha ${rows[0]}`
  const shown = rows.slice(0, max)
  if (rows.length > max) return `linhas ${shown.join(', ')}, … (mais ${rows.length - max})`
  return `linhas ${shown.slice(0, -1).join(', ')} e ${shown[shown.length - 1]}`
}

// ---------------------------------------------------------------------------
// Confirmação e backup
// ---------------------------------------------------------------------------

export type CustomerImportMode = 'replace' | 'update'

/** palavras que o usuário digita para confirmar (exatamente assim, maiúsculas) */
export const REPLACE_WORD = 'SUBSTITUIR'
export const UPDATE_WORD = 'ATUALIZAR'
export const confirmWordOf = (m: CustomerImportMode) => (m === 'replace' ? REPLACE_WORD : UPDATE_WORD)

export const CUSTOMERS_BACKUP_KIND = 'pacifil-backup-clientes'
export const CUSTOMERS_BACKUP_VERSION = 1

/** contagens da tabela de clientes (as mesmas no backup, na auditoria e na conferência antes de aplicar) */
export interface CustomerCounts {
  customers: number
  withCode: number
  withAgent: number
  inactive: number
}

const CUSTOMER_COUNT_KEYS: (keyof CustomerCounts)[] = ['customers', 'withCode', 'withAgent', 'inactive']

/** mesmas contagens? (ausente = diferente) */
export function sameCustomerCounts(a: Partial<CustomerCounts> | null | undefined, b: CustomerCounts): boolean {
  if (!a) return false
  return CUSTOMER_COUNT_KEYS.every((k) => Number(a[k]) === b[k])
}

export interface CustomerApplyInput {
  mode: CustomerImportMode
  /** sha256 do arquivo na prévia: a aplicação recebe o MESMO arquivo de novo */
  fileSha256: string
  dryRun: boolean
  confirm: string
  savedBackup: boolean
  backupSha256: string | null
}

const SHA = /^[0-9a-f]{64}$/

/**
 * Confere o pedido de aplicação (antes de tocar no banco). null = ok; senão a mensagem para o usuário.
 * A simulação não exige a palavra nem o backup (se vier o sha256 do backup, ele é conferido também).
 */
export function validateCustomerApplyInput(i: Partial<CustomerApplyInput> | null | undefined): string | null {
  if (!i || typeof i !== 'object') return 'Pedido inválido.'
  if (i.mode !== 'replace' && i.mode !== 'update') return 'Escolha o modo: substituir todos ou atualizar pelo código.'
  if (typeof i.fileSha256 !== 'string' || !SHA.test(i.fileSha256)) return 'Gere a prévia da planilha antes de aplicar.'
  if (i.backupSha256 != null && i.backupSha256 !== '' && (typeof i.backupSha256 !== 'string' || !SHA.test(i.backupSha256))) return 'Backup inválido: baixe o backup de novo.'
  if (i.dryRun === true) return null
  const word = confirmWordOf(i.mode)
  if (typeof i.confirm !== 'string' || i.confirm.trim() !== word) return `Digite ${word} (em maiúsculas) para confirmar.`
  if (i.savedBackup !== true) return 'Marque “Baixei e guardei o backup” antes de aplicar.'
  if (typeof i.backupSha256 !== 'string' || !SHA.test(i.backupSha256)) return 'Baixe o backup dos clientes atuais antes de aplicar.'
  return null
}
