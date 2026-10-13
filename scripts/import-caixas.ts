/**
 * Importa "TABELA NOVA DAS CAIXAS PACIFIL - ATUAL.xlsx" (aba CAIXAS PESO E MEDIDAS):
 * cada produto da coluna REFERENCIA → família + SKU, com a caixa como versão de embalagem v1.
 *
 * Uso: npx tsx --env-file=.env scripts/import-caixas.ts "<caminho.xlsx>" [--dry]
 *
 * - Medidas, tara (col. N) e caixas/palete (col. O) são lidas da planilha.
 * - Peso líquido = MÁXIMO da faixa da col. B (conservador). Sem faixa → 0 (gera alerta).
 * - Tudo entra como ESTIMATED. Idempotente: não duplica SKU nem embalagem existente.
 */
import ExcelJS from 'exceljs'
import { and, eq } from 'drizzle-orm'
import { db, schema as s } from '../src/db'
import { splitTechnical } from '../src/domain/productSpec'

type Fam = 'SILAGE_TARP' | 'SILO_BAG' | 'HIDROSILO'
interface RowMap {
  row: number
  fam: Fam
  /** linha/produto (agrupa SKUs) */
  line: string
  /** prefixo do SKU */
  sku: string
  items: string[]
  note?: string
}

// Mapeamento explícito da coluna REFERENCIA (C) → produtos individuais
const L = (row: number, line: string, sku: string, items: string[], note?: string): RowMap => ({ row, fam: 'SILAGE_TARP', line, sku, items, note })
const B = (row: number, line: string, sku: string, items: string[], note?: string): RowMap => ({ row, fam: 'SILO_BAG', line, sku, items, note })
const H = (row: number, items: string[], note?: string): RowMap => ({ row, fam: 'HIDROSILO', line: 'Hidrosilo', sku: 'HS', items, note })

const MAP: RowMap[] = [
  L(2, 'Lona BPF', 'LS-BPF', ['6X25', '8X25']),
  L(3, 'Lona padrão', 'LS', ['6X25', '8X25']),
  L(4, 'Lona BPF', 'LS-BPF', ['4X100', '8X50']),
  L(5, 'Lona padrão', 'LS', ['6X50', '8X50', '4X100'], 'Planilha escreve "8 X 5O" (letra O) — lido como 8X50.'),
  L(6, 'Lona sem impressão', 'LS-SI', ['6X50', '8X50', '4X100']),
  L(7, 'Lona BigSafe', 'LS-BIGSAFE', ['16X50', '18X50', '20X50'], 'Caixa de 1,60 m de comprimento.'),
  L(8, 'Lona padrão', 'LS', ['8X100', '10X50', '12X50', '14X50']),
  L(9, 'Lona Big Silo', 'LS-BIGSILO', ['22X50', '24X50', '28X50'], 'Caixa de 2.100 mm em palete de 2.000 mm: sobra 100 mm (overhang) — verificar.'),
  B(10, 'Silo-bolsa', 'SB', ['5FT', '6FT']),
  B(11, 'Silo-bolsa Uruguai', 'SB-URU', ['6FT'], 'Linha sem código de caixa na planilha.'),
  L(12, 'Lona BPF', 'LS-BPF', ['10X50', '6X100', '8X100', '12X50', '14X50']),
  L(13, 'Lona sem impressão', 'LS-SI', ['6X100']),
  L(14, 'Lona Plus (LP)', 'LS-LP', ['14X50']),
  B(15, 'Silo-bolsa', 'SB', ['9FT']),
  B(16, 'Silo-bolsa', 'SB', ['10X100']),
  B(17, 'Silo-bolsa Eco Bag', 'SB-ECO', ['9X60']),
  B(18, 'Silo-bolsa Pró Bag', 'SB-PRO', ['9X60'], 'Mesmo código de caixa (74041) da linha 16 (10x100).'),
  B(19, 'Silo-bolsa sem impressão (exportação)', 'SB-SI', ['9X200/60']),
  B(20, 'Silo-bolsa', 'SB', ['9X75']),
  B(21, 'Silo-bolsa Eco Bag', 'SB-ECO', ['9X75']),
  B(22, 'Silo-bolsa Pró Bag', 'SB-PRO', ['9X75']),
  B(23, 'Silo-bolsa sem impressão (exportação)', 'SB-SI', ['9X250/75']),
  B(24, 'Silo-bolsa', 'SB', ['10X75'], 'Peso total da embalagem digitado 6,7 kg na planilha, mas caixa+kit+plástico = 6,96 kg — usado 6,96.'),
  B(25, 'Silo-bolsa Pró Bag', 'SB-PRO', ['9X100']),
  B(26, 'Silo-bolsa sem impressão (exportação)', 'SB-SI', ['10X250/75']),
  B(27, 'Silo-bolsa linha Bridon', 'SB-BRIDON', ['10X250/75']),
  B(28, 'Silo-bolsa', 'SB', ['12X75']),
  B(29, 'Silo-bolsa Eco Bag', 'SB-ECO', ['9X100']),
  B(30, 'Silo-bolsa Pró Bag', 'SB-PRO', ['9X125']),
  B(31, 'Silo-bolsa sem impressão (exportação)', 'SB-SI', ['12X250', '9X100']),
  B(32, 'Silo-bolsa linha Bridon', 'SB-BRIDON', ['9X300', '9X328', '11,5X200', '11,5X250', '12X200', '12X250', '10X300']),
  B(33, 'Silo-bolsa', 'SB', ['9X125']),
  B(34, 'Silo-bolsa', 'SB', ['10X400']),
  B(35, 'Silo-bolsa linha Bridon', 'SB-BRIDON', ['10X400', '10X500']),
  B(36, 'Silo-bolsa', 'SB', ['12X500'], 'Distribuição "2 e 3" por palete — confirmar.'),
  B(37, 'Silo-bolsa sem impressão (exportação)', 'SB-SI', ['12X500', '11,5X500']),
  B(38, 'Silo-bolsa linha Bridon', 'SB-BRIDON', ['12X500', '11,5X500']),
  L(39, 'Lona medida especial', 'LS-ESP', ['18X40', '18X50'], 'Espessuras 120 µm / 150 µm.'),
  L(40, 'Lona medida especial', 'LS-ESP-EUA', ['15X46'], 'Medida EUA.'),
  // Hidrosilo: tabela das linhas 45–51 usada como vigente; tabela 41–44 registrada como alternativa
  H(45, ['500L', '1000L', '2000L']),
  H(46, ['5.5M']),
  H(47, ['10M']),
  H(48, ['15M', '20M']),
  H(49, ['25M']),
  H(50, ['30M', '40M']),
  H(51, ['50M']),
  H(43, ['35M'], 'Só existe na tabela alternativa (linhas 41–44).'),
]

/** Tabela alternativa de Hidrosilo (linhas 41–44) — vai como observação nos SKUs. */
const HS_ALT: Record<string, number> = { '5.5M': 41, '10M': 41, '15M': 42, '20M': 42, '25M': 43, '30M': 43, '40M': 44, '50M': 44 }

/** Hidrosilo: metros/litros → SKU existente (1.000 L por metro) ou novo. */
const HS_SKU: Record<string, { sku: string; name: string; attrs: Record<string, number> }> = {
  '500L': { sku: 'HS-500L', name: 'Hidrosilo 500 L', attrs: { capacidade_l: 500 } },
  '1000L': { sku: 'HS-1K', name: 'Hidrosilo 1.000 L', attrs: { capacidade_l: 1000 } },
  '2000L': { sku: 'HS-2K', name: 'Hidrosilo 2.000 L', attrs: { capacidade_l: 2000 } },
  '5.5M': { sku: 'HS-5K', name: 'Hidrosilo 5.000 L', attrs: { capacidade_l: 5000, comprimento_m: 5.5 } },
  '10M': { sku: 'HS-10K', name: 'Hidrosilo 10.000 L', attrs: { capacidade_l: 10000, comprimento_m: 10 } },
  '15M': { sku: 'HS-15K', name: 'Hidrosilo 15.000 L', attrs: { capacidade_l: 15000, comprimento_m: 15 } },
  '20M': { sku: 'HS-20K', name: 'Hidrosilo 20.000 L', attrs: { capacidade_l: 20000, comprimento_m: 20 } },
  '25M': { sku: 'HS-25K', name: 'Hidrosilo 25.000 L', attrs: { capacidade_l: 25000, comprimento_m: 25 } },
  '30M': { sku: 'HS-30K', name: 'Hidrosilo 30.000 L', attrs: { capacidade_l: 30000, comprimento_m: 30 } },
  '35M': { sku: 'HS-35K', name: 'Hidrosilo 35.000 L', attrs: { capacidade_l: 35000, comprimento_m: 35 } },
  '40M': { sku: 'HS-40K', name: 'Hidrosilo 40.000 L', attrs: { capacidade_l: 40000, comprimento_m: 40 } },
  '50M': { sku: 'HS-50K', name: 'Hidrosilo 50.000 L', attrs: { capacidade_l: 50000, comprimento_m: 50 } },
}

/** Silo-bolsa sem impressão/Bridon usa comprimento em pés quando ≥ 200 (ex.: 9X250/75 = 9 ft × 250 ft ≈ 75 m). */
function describe(fam: Fam, line: string, item: string): { name: string; attrs: Record<string, string | number> } {
  if (fam === 'SILAGE_TARP') {
    const [w, l] = item.split('X').map((x) => Number(x.replace(',', '.')))
    return { name: `${line} ${String(w).replace('.', ',')} × ${l} m`, attrs: { largura_m: w, comprimento_m: l } }
  }
  const ft = item.match(/^(\d+)FT$/)
  if (ft) return { name: `${line} ${ft[1]} pés`, attrs: { diametro_ft: Number(ft[1]) } }
  const m = item.match(/^([\d,]+)X(\d+)(?:\/(\d+))?$/)!
  const d = Number(m[1].replace(',', '.'))
  const len = Number(m[2])
  const metric = m[3] ? Number(m[3]) : null
  if (len >= 200) {
    const approx = metric ?? Math.round(len * 0.3048)
    return { name: `${line} ${m[1]} pés × ${len} pés (~${approx} m)`, attrs: { diametro_ft: d, comprimento_ft: len, comprimento_m_aprox: approx } }
  }
  return { name: `${line} ${m[1]} pés × ${len} m`, attrs: { diametro_ft: d, comprimento_m: len } }
}

const PALLET_BY_D: Record<string, { code: string; name: string; l: number; w: number }> = {
  '1,00X1,20': { code: 'PBR-1', name: 'PBR-1 (Brasil)', l: 1000, w: 1200 },
  '1,15X1,15': { code: 'PCF-1150', name: 'Pacifil 1150 × 1150 mm (interno)', l: 1150, w: 1150 },
  '1,10X1,30': { code: 'PCF-1100x1300', name: 'Pacifil exportação 1100 × 1300 mm', l: 1100, w: 1300 },
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null
  if (typeof v === 'number') return v
  if (typeof v === 'object' && v && 'result' in v) return num((v as { result: unknown }).result)
  const n = Number(String(v).replace(',', '.'))
  return Number.isFinite(n) ? n : null
}
function text(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'object' && v && 'richText' in v) return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join('')
  if (typeof v === 'object' && v && 'result' in v) return String((v as { result: unknown }).result ?? '')
  return String(v)
}
/** "10KG A 30KG" → 30; "ATÉ 55KG" → 55; texto sem número → null */
function maxNet(range: string): number | null {
  const n = [...range.matchAll(/(\d+)\s*KG/gi)].map((m) => Number(m[1]))
  return n.length ? Math.max(...n) : null
}

async function main() {
  const [file, flag] = process.argv.slice(2)
  const dry = flag === '--dry'
  if (!file) throw new Error('Informe o caminho do .xlsx')
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(file)
  const ws = wb.getWorksheet('CAIXAS PESO E MEDIDAS') ?? wb.worksheets[0]

  const read = (r: number) => {
    const row = ws.getRow(r)
    const c = (col: string) => row.getCell(col).value
    let range = text(c('B')).trim()
    if (!range && r === 11) range = text(ws.getRow(10).getCell('B').value) // célula mesclada
    const k = num(c('K')) ?? 0, l = num(c('L')) ?? 0, m = num(c('M')) ?? 0
    return {
      code: text(c('A')).trim() || null,
      range,
      ref: text(c('C')).trim(),
      pallet: text(c('D')).trim().toUpperCase(),
      dims: { l: num(c('E'))!, w: num(c('G'))!, h: num(c('I'))! },
      tare: { box: k, kit: l, plastic: m, total: Math.round((k + l + m) * 1000) / 1000, sheetTotal: num(c('N')) },
      dist: text(c('O')).trim(),
    }
  }

  const today = new Date().toISOString().slice(0, 10)
  const fam = Object.fromEntries((await db.select().from(s.productFamilies)).map((f) => [f.code, f.id]))
  const stats = { pallets: 0, products: 0, variants: 0, packs: 0, skippedPacks: 0 }
  const report: string[] = []

  // Paletes que faltam
  const palletId: Record<string, number> = {}
  for (const p of Object.values(PALLET_BY_D)) {
    let pt = await db.query.palletTypes.findFirst({ where: eq(s.palletTypes.code, p.code) })
    if (!pt && !dry) {
      ;[pt] = await db
        .insert(s.palletTypes)
        .values({ code: p.code, name: p.name, lengthMm: p.l, widthMm: p.w, verification: 'UNVERIFIED', source: 'Tabela de caixas Pacifil', notes: 'Criado pela importação da tabela de caixas. Completar altura, tara e capacidade.' })
        .returning()
      stats.pallets++
    }
    if (pt) palletId[p.code] = pt.id
  }

  const productCache = new Map<string, number>()
  async function productId(f: Fam, name: string) {
    const key = `${f}|${name}`
    if (productCache.has(key)) return productCache.get(key)!
    let p = await db.query.products.findFirst({ where: and(eq(s.products.name, name), eq(s.products.familyId, fam[f])) })
    if (!p && !dry) {
      ;[p] = await db.insert(s.products).values({ familyId: fam[f], name, notes: 'Importado da tabela de caixas.' }).returning()
      stats.products++
    }
    if (p) productCache.set(key, p.id)
    return p?.id ?? -1
  }

  for (const m of MAP) {
    const r = read(m.row)
    if (!r.dims.l || !r.dims.w || !r.dims.h) {
      report.push(`linha ${m.row}: sem medidas — ignorada`)
      continue
    }
    const pal = PALLET_BY_D[r.pallet]
    const net = maxNet(r.range) ?? 0
    const distNums = [...r.dist.matchAll(/\d+/g)].map((x) => Number(x[0]))
    const notes = [
      `Tabela de caixas, linha ${m.row}: "${r.ref}".`,
      r.code ? `Código caixa (RECH): ${r.code}.` : 'Sem código de caixa.',
      `Faixa de peso líquido: ${r.range || 'não informada'}${net ? ` → usado ${net} kg (máximo da faixa)` : ' → peso líquido pendente'}.`,
      `Tara embalagem: caixa ${r.tare.box} + kit ${r.tare.kit} + plástico/fitas ${r.tare.plastic} = ${r.tare.total} kg.`,
      pal ? '' : `Palete da planilha ${r.pallet} não é um dos 3 tipos padrão (1,00×1,20 / 1,15×1,15 / 1,10×1,30): definir o palete.`,
      `Palete: ${r.pallet} · distribuição: ${r.dist}${distNums.length > 1 ? ' (alternativas — confirmar)' : ''}.`,
      m.note ?? '',
    ]
      .filter(Boolean)
      .join('\n')

    for (const item of m.items) {
      const line = m.line
      let sku: string, name: string, attrs: Record<string, string | number>
      let extra = ''
      if (m.fam === 'HIDROSILO') {
        const h = HS_SKU[item]
        sku = h.sku
        name = h.name
        attrs = h.attrs
        if (m.row !== 43 && HS_ALT[item]) {
          const a = read(HS_ALT[item])
          extra = `\nTabela alternativa (linha ${HS_ALT[item]}, "${a.ref}"): caixa ${a.code} ${a.dims.l}×${a.dims.w}×${a.dims.h} mm, tara ${a.tare.total} kg, ${a.dist}/palete — CONFLITO: confirmar qual é a vigente.`
        }
        if (item === '5.5M') extra += '\nEspecificação indica 5k = 5,30 m; planilha diz 5,5 m.'
      } else {
        const d = describe(m.fam, line, item)
        sku = `${m.sku}-${item.replace(/\//g, '-').replace(/,/g, '.')}`
        if (m.fam === 'SILO_BAG' && m.sku === 'SB' && item === '9X75') sku = 'SB-9x75' // SKU já existente
        name = d.name
        attrs = d.attrs
      }
      attrs = { ...attrs, ref_planilha: r.ref, ...(r.code ? { codigo_caixa: r.code } : {}) }

      let v = await db.query.productVariants.findFirst({ where: eq(s.productVariants.sku, sku) })
      if (!v && !dry) {
        const pid = m.fam === 'HIDROSILO' ? await productId('HIDROSILO', 'Hidrosilo') : await productId(m.fam, line)
        const t = splitTechnical(attrs)
        ;[v] = await db.insert(s.productVariants).values({ productId: pid, sku, name, attrs: t.attrs, ...Object.fromEntries(Object.entries(t.columns).filter(([, x]) => x != null)) }).returning()
        stats.variants++
      } else if (v && !dry) {
        const t = splitTechnical(attrs)
        await db.update(s.productVariants).set({ attrs: { ...v.attrs, ...t.attrs }, ...Object.fromEntries(Object.entries(t.columns).filter(([, x]) => x != null)) }).where(eq(s.productVariants.id, v.id))
      }
      const has = v ? await db.query.packagingVersions.findFirst({ where: eq(s.packagingVersions.variantId, v.id) }) : undefined
      if (has) {
        stats.skippedPacks++
        report.push(`${sku}: já tem embalagem (v${has.version}) — não alterada`)
        continue
      }
      if (!dry && v) {
        await db.insert(s.packagingVersions).values({
          variantId: v.id,
          version: 1,
          validFrom: today,
          packageType: 'Caixa',
          lengthMm: Math.round(r.dims.l),
          widthMm: Math.round(r.dims.w),
          heightMm: Math.round(r.dims.h),
          netKg: net,
          grossKg: Math.round((net + r.tare.total) * 1000) / 1000,
          unitsPerPackage: 1,
          unitsPerPallet: distNums[0] ?? null,
          palletTypeId: pal ? palletId[pal.code] ?? null : null,
          allowedOrientations: ['LWH', 'WLH'],
          stackable: true,
          verification: 'ESTIMATED',
          notes: notes + extra,
        })
      }
      stats.packs++
      report.push(`${sku.padEnd(24)} ${name.padEnd(55)} ${r.dims.l}×${r.dims.w}×${r.dims.h}  net ${net}  bruto ${Math.round((net + r.tare.total) * 100) / 100}  ${r.pallet}  ${r.dist}/pal`)
    }
  }
  console.log(report.join('\n'))
  console.log(`\n${dry ? '[SIMULAÇÃO] ' : ''}Paletes novos: ${stats.pallets} · produtos novos: ${stats.products} · SKUs novos: ${stats.variants} · embalagens criadas: ${stats.packs} · já existentes: ${stats.skippedPacks}`)
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
