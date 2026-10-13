/**
 * Exporta para Excel o CATÁLOGO LOGÍSTICO exatamente como aparece na página /catalogo
 * (famílias e produtos ativos, embalagem vigente, mesma ordem). Só os dados da tabela principal.
 * A coluna "Código" é a chave para uma futura importação: não alterar códigos existentes.
 * Uso: npx tsx --env-file=.env scripts/export-catalog.ts caminho\arquivo.xlsx
 */
import ExcelJS from 'exceljs'
import { sortProducts } from '../src/domain/productOrder'
import { technicalAttrs } from '../src/domain/productSpec'
import { asc, eq } from 'drizzle-orm'
import { db, schema as s } from '../src/db'

const VERIF: Record<string, string> = { VERIFIED: 'Verificado', ESTIMATED: 'Estimado / referência', UNVERIFIED: 'Não verificado' }
const PRICE_UNIT: Record<string, string> = { UNIT: 'unidade', BOX: 'caixa', PALLET: 'palete' }

const numAttr = (a: Record<string, unknown> | null | undefined, k: string) => {
  const v = a?.[k]
  return typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : null
}

export async function catalogRows() {
  const [families, products, variants, packs, pallets] = await Promise.all([
    db.select().from(s.productFamilies).where(eq(s.productFamilies.active, true)).orderBy(asc(s.productFamilies.sort), asc(s.productFamilies.name)),
    db.select().from(s.products),
    db.select().from(s.productVariants).where(eq(s.productVariants.active, true)).orderBy(asc(s.productVariants.sku)),
    db.select().from(s.packagingVersions),
    db.select().from(s.palletTypes).orderBy(asc(s.palletTypes.code)),
  ])
  const current = new Map<number, (typeof packs)[number]>()
  for (const p of packs) {
    const c = current.get(p.variantId)
    if (!c || p.version > c.version) current.set(p.variantId, p)
  }
  const productById = new Map(products.map((p) => [p.id, p]))
  const palletCode = new Map(pallets.map((p) => [p.id, p.code]))
  const rows: { famIdx: number; v: (typeof variants)[number]; family: string; line: string; pk: (typeof packs)[number] | undefined }[] = []
  for (const v of variants) {
    const prod = productById.get(v.productId)
    const famIdx = prod ? families.findIndex((f) => f.id === prod.familyId) : -1
    if (!prod || famIdx < 0) continue // a página só mostra produtos de famílias ativas
    rows.push({ famIdx, v, family: families[famIdx].name, line: prod.name, pk: current.get(v.id) })
  }
  // mesma ordem da plataforma (domain/productOrder): família e, dentro dela, medidas numéricas
  const sorted = sortProducts(rows, (r) => ({ familySort: r.famIdx, familyName: r.family, attrs: technicalAttrs(r.v.attrs, r.v), thicknessUm: r.v.thicknessUm, sku: r.v.sku, brand: r.v.brand }))
  rows.splice(0, rows.length, ...sorted)
  return {
    rows: rows.map((r) => ({
      family: r.family,
      line: r.line,
      sku: r.v.sku,
      brand: r.v.brand,
      name: r.v.name,
      capL: numAttr(r.v.attrs, 'capacidade_l'),
      siloBag: r.v.attrs?.silo_bolsa == null ? null : Number(r.v.attrs.silo_bolsa) === 1 ? 'Sí' : 'No',
      diaFt: r.v.diameterFt ?? numAttr(r.v.attrs, 'diametro_ft'),
      diaM: numAttr(r.v.attrs, 'diametro_m'),
      widthM: r.v.widthM ?? numAttr(r.v.attrs, 'largura_m'),
      lengthM: r.v.lengthM ?? numAttr(r.v.attrs, 'comprimento_m'),
      perimM: numAttr(r.v.attrs, 'perimetro_m'),
      micron: r.v.thicknessUm ?? numAttr(r.v.attrs, 'espessura_um'),
      l: r.pk?.lengthMm ?? null,
      w: r.pk?.widthMm ?? null,
      h: r.pk?.heightMm ?? null,
      netKg: r.pk?.netKg ?? null,
      grossKg: r.pk?.grossKg ?? null,
      upp: r.pk?.unitsPerPallet ?? null,
      pallet: r.pk?.palletTypeId ? palletCode.get(r.pk.palletTypeId) ?? null : null,
      price: r.v.price,
      currency: r.v.price != null ? r.v.priceCurrency : null,
      priceUnit: r.v.price != null ? PRICE_UNIT[r.v.priceUnit] ?? r.v.priceUnit : null,
      data: r.pk ? VERIF[r.pk.verification] ?? r.pk.verification : 'sem embalagem',
    })),
    palletCodes: pallets.filter((p) => p.active).map((p) => p.code),
    families: families.map((f) => f.name),
  }
}

const COLS = [
  { key: 'family', header: 'Família', width: 18 },
  { key: 'line', header: 'Linha', width: 22 },
  { key: 'brand', header: 'Marca', width: 12 },
  { key: 'sku', header: 'Código', width: 24 },
  { key: 'name', header: 'Descrição', width: 46 },
  { key: 'capL', header: 'Capacidad (L)', width: 12, fmt: '#,##0' },
  { key: 'siloBag', header: 'Silo Bolsa', width: 10 },
  { key: 'diaFt', header: 'Diámetro (pies)', width: 12, fmt: '#,##0.##' },
  { key: 'diaM', header: 'Diámetro (m)', width: 12, fmt: '#,##0.000' },
  { key: 'widthM', header: 'Ancho (m)', width: 10, fmt: '#,##0.##' },
  { key: 'lengthM', header: 'Largo (m)', width: 10, fmt: '#,##0.##' },
  { key: 'perimM', header: 'Perímetro (m)', width: 12, fmt: '#,##0.000' },
  { key: 'micron', header: 'Espesor (micrones)', width: 12, fmt: '#,##0' },
  { key: 'l', header: 'Caixa C (mm)', width: 13, fmt: '#,##0' },
  { key: 'w', header: 'Caixa L (mm)', width: 13, fmt: '#,##0' },
  { key: 'h', header: 'Caixa A (mm)', width: 13, fmt: '#,##0' },
  { key: 'netKg', header: 'Peso líquido (kg)', width: 16, fmt: '#,##0.00#' },
  { key: 'grossKg', header: 'Peso c/ embalagem (kg)', width: 15, fmt: '#,##0.00#' },
  { key: 'upp', header: 'Caixas / palete', width: 14, fmt: '#,##0' },
  { key: 'pallet', header: 'Palete', width: 18 },
  { key: 'price', header: 'Preço', width: 12, fmt: '#,##0.00' },
  { key: 'currency', header: 'Moeda', width: 9 },
  { key: 'priceUnit', header: 'Preço por', width: 11 },
  { key: 'data', header: 'Dados', width: 22 },
] as const

async function main() {
  const out = process.argv[2]
  if (!out) throw new Error('Uso: export-catalog.ts arquivo.xlsx')
  const { rows, palletCodes } = await catalogRows()

  const wb = new ExcelJS.Workbook()
  wb.creator = 'Pacifil Export Load Planner'
  wb.created = new Date()
  const ws = wb.addWorksheet('Catálogo logístico', { views: [{ state: 'frozen', xSplit: 3, ySplit: 1 }] })
  ws.columns = COLS.map((c) => ({ key: c.key, header: c.header, width: c.width }))
  for (const r of rows) ws.addRow(r)

  const header = ws.getRow(1)
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B6E4F' } }
  header.alignment = { vertical: 'middle', wrapText: true }
  header.height = 30
  COLS.forEach((c, i) => {
    const col = ws.getColumn(i + 1)
    if ('fmt' in c) col.numFmt = c.fmt
    if (['sku', 'family', 'line', 'brand', 'name', 'siloBag', 'pallet', 'currency', 'priceUnit', 'data'].includes(c.key)) col.numFmt = '@' // texto (evita "1E5", datas etc.)
  })
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLS.length } }

  // listas para edição segura (validação de dados)
  const lists = wb.addWorksheet('Listas')
  lists.getColumn(1).values = ['Paletes', ...palletCodes]
  lists.getColumn(2).values = ['Moedas', 'USD', 'BRL', 'EUR']
  lists.getColumn(3).values = ['Preço por', 'unidade', 'caixa', 'palete']
  lists.getColumn(4).values = ['Dados', 'Verificado', 'Estimado / referência', 'Não verificado']
  lists.getRow(1).font = { bold: true }
  lists.columns.forEach((c) => (c.width = 24))
  const last = rows.length + 200 // linhas extras para produtos novos
  const colLetter = (key: string) => {
    const i = COLS.findIndex((c) => c.key === key)
    return i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(64 + Math.floor(i / 26)) + String.fromCharCode(65 + (i % 26))
  }
  for (let r = 2; r <= last; r++) {
    const list = (key: string, ref: string) => (ws.getCell(`${colLetter(key)}${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [ref], showErrorMessage: true, errorTitle: 'Valor inválido', error: 'Escolha um valor da lista.' })
    list('pallet', `Listas!$A$2:$A$${palletCodes.length + 1}`)
    list('currency', 'Listas!$B$2:$B$4')
    list('priceUnit', 'Listas!$C$2:$C$4')
    list('data', 'Listas!$D$2:$D$4')
    for (const k of ['l', 'w', 'h', 'upp'])
      ws.getCell(`${colLetter(k)}${r}`).dataValidation = { type: 'whole', operator: 'greaterThanOrEqual', allowBlank: true, formulae: [0], showErrorMessage: true, error: 'Número inteiro em mm / unidades.' }
    for (const k of ['netKg', 'grossKg', 'price'])
      ws.getCell(`${colLetter(k)}${r}`).dataValidation = { type: 'decimal', operator: 'greaterThanOrEqual', allowBlank: true, formulae: [0], showErrorMessage: true, error: 'Número maior ou igual a zero.' }
  }

  const info = wb.addWorksheet('Instruções')
  info.getColumn(1).width = 110
  ;[
    'CATÁLOGO LOGÍSTICO — exportado do Pacifil Export Load Planner',
    `Gerado em ${new Date().toLocaleString('pt-BR')} · ${rows.length} produtos (mesmos dados e ordem da página "Catálogo logístico").`,
    '',
    '• "Código" identifica o produto: não altere códigos existentes (para um produto novo, use um código novo).',
    '• Medidas da caixa em milímetros (números inteiros). Pesos em kg por caixa. "Caixas / palete" = quantidade no palete padrão.',
    '• Palete, Moeda, Preço por e Dados têm lista de valores (setinha na célula). Valores de apoio na aba "Listas".',
    '• Produtos novos: adicione linhas no final da tabela, preenchendo pelo menos Família, Código, Descrição e medidas.',
    '• Para reimportar as alterações no sistema, envie este arquivo de volta (a importação valida cada linha antes de gravar).',
  ].forEach((t, i) => {
    const c = info.getCell(`A${i + 1}`)
    c.value = t
    if (i === 0) c.font = { bold: true, size: 13 }
  })

  await wb.xlsx.writeFile(out)
  console.log(`Exportados ${rows.length} produtos → ${out}`)
}

if (process.argv[1]?.includes('export-catalog')) main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
