/**
 * PDF da LISTA DE PREÇOS para o cliente (pt/es/en): produtos agrupados por família (e largura), com o
 * preço por unidade em USD logo depois do produto (os dois destacados), medidas, embalagem, unidades por
 * palete e pesos líquido e bruto (produto + caixa) — o mesmo cálculo da Proforma (categoria comercial,
 * Incoterm e, se houver, comissão do agente embutida). Validade, condição de pagamento e descrição
 * comercial escolhidas na emissão.
 */
import { PDFDocument, StandardFonts } from 'pdf-lib'
import type { TechDisplay } from '@/domain/technology'
import type { PaymentTerms } from '@/domain/paymentTerms'
import { paymentTermsText } from '@/domain/paymentTerms'
import type { PriceListData, PriceListRow } from '@/lib/priceList'
import { COMPANY, PdfLang, PDF_TZ } from './i18n'
import { A4, clean, GREEN_DARK, GREY, M, Writer } from './orderPdf'
import { NXT_TITLE, PRICE_LIST_VALID_DAYS } from './priceListText'

export { NXT_TITLE, PRICE_LIST_DESCRIPTION, PRICE_LIST_NXT, PRICE_LIST_VALID_DAYS } from './priceListText'

/** colunas opcionais (produto, preço, peso líquido e peso bruto sempre aparecem) */
export interface PriceListColumns {
  /** espessura (nunca nos Hidrosilos / Hydroforce) */
  thickness: boolean
  box: boolean
  perPallet: boolean
}

export interface PriceListOptions {
  lang: PdfLang
  logo?: Uint8Array | null
  paymentTerms?: PaymentTerms | null
  columns?: PriceListColumns
  /** descrição comercial (vazio = sem descrição) */
  description?: string | null
  /**
   * PACIFIL NXT (famílias marcadas no Catálogo): quadro no início (texto no idioma da lista) e, em cada grupo
   * dessas famílias, a menção — com o selo quando a família é SEAL (Hidrosilo). families: nome → MENTION | SEAL.
   */
  nxt?: { families: Record<string, TechDisplay>; text: string; seal?: Uint8Array | null } | null
  /** nome do usuário que gerou a lista (rodapé discreto) */
  generatedBy?: string | null
}

const T: Record<PdfLang, {
  title: string
  locale: string
  sub: (incoterm: string) => string
  group: (family: string, label: string) => string
  cols: { code: string; product: string; thick: string; box: string; perPallet: string; net: string; gross: string; price: string }
  liters: string
  noPrice: string
  notes: (incoterm: string) => string[]
  payment: string
  paymentAsk: string
  dates: (issued: string, valid: string) => string
  double: string
}> = {
  es: {
    title: 'LISTA DE PRECIOS',
    locale: 'es-ES',
    sub: (i) => `Precios por unidad en USD · ${i}`,
    group: (f, l) => (l ? `${f} — ${l} de ancho` : f),
    cols: { code: 'Código', product: 'Producto', thick: 'Espesor', box: 'Caja C × L × A (mm)', perPallet: 'Unid./pallet', net: 'Peso neto (kg)', gross: 'Peso bruto (kg)', price: 'Precio USD/u.' },
    liters: 'litros',
    noPrice: 'consultar',
    notes: (i) => [`Precios por unidad, en dólares estadounidenses (USD), condición ${i} (Incoterms® 2020).`, 'Peso neto: solo el producto. Peso bruto: producto + caja (sin pallet).'],
    payment: 'Condición de pago',
    paymentAsk: 'consultar con el Departamento de Exportación',
    dates: (a, b) => `Emitida el ${a} · Válida hasta el ${b}`,
    double: '* Pallet doble (2,30 × 1,15 m).',
  },
  pt: {
    title: 'LISTA DE PREÇOS',
    locale: 'pt-BR',
    sub: (i) => `Preços por unidade em USD · ${i}`,
    group: (f, l) => (l ? `${f} — largura ${l}` : f),
    cols: { code: 'Código', product: 'Produto', thick: 'Espessura', box: 'Caixa C × L × A (mm)', perPallet: 'Unid./palete', net: 'Peso líquido (kg)', gross: 'Peso bruto (kg)', price: 'Preço USD/un.' },
    liters: 'litros',
    noPrice: 'consultar',
    notes: (i) => [`Preços por unidade, em dólares americanos (USD), condição ${i} (Incoterms® 2020).`, 'Peso líquido: só o produto. Peso bruto: produto + caixa (sem palete).'],
    payment: 'Condição de pagamento',
    paymentAsk: 'consultar o Departamento de Exportação',
    dates: (a, b) => `Emitida em ${a} · Válida até ${b}`,
    double: '* Palete duplo (2,30 × 1,15 m).',
  },
  en: {
    title: 'PRICE LIST',
    locale: 'en-US',
    sub: (i) => `Unit prices in USD · ${i}`,
    group: (f, l) => (l ? `${f} — ${l} wide` : f),
    cols: { code: 'Code', product: 'Product', thick: 'Thickness', box: 'Box L × W × H (mm)', perPallet: 'Units/pallet', net: 'Net weight (kg)', gross: 'Gross weight (kg)', price: 'Price USD/unit' },
    liters: 'liters',
    noPrice: 'on request',
    notes: (i) => [`Unit prices in US dollars (USD), ${i} (Incoterms® 2020).`, 'Net weight: product only. Gross weight: product + box (without pallet).'],
    payment: 'Payment terms',
    paymentAsk: 'please contact the Export Department',
    dates: (a, b) => `Issued on ${a} · Valid until ${b}`,
    double: '* Double pallet (2.30 × 1.15 m).',
  },
}

/** Hidrosilo e Hydroforce: a espessura (600 µm) não vai na lista */
const hideThickness = (family: string) => /hidrosilo|hidroforce|hydroforce/i.test(family)

export async function buildPriceListPdf(data: PriceListData, o: PriceListOptions): Promise<Uint8Array> {
  const t = T[o.lang]
  const cols = o.columns ?? { thickness: true, box: true, perPallet: true }
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const families = [...new Set(data.groups.map((g) => g.family))]
  const famTxt = families.length > 3 ? '' : families.join(' · ')
  pdf.setTitle(clean(`${t.title}${famTxt ? ` — ${famTxt}` : ''}`))
  pdf.setAuthor(COMPANY.legalName)
  pdf.setCreator('Pacifil Export Load Planner')
  const fmtDate = (d: Date) => d.toLocaleDateString(t.locale, { timeZone: PDF_TZ })
  const issued = fmtDate(data.generatedAt)
  const valid = fmtDate(new Date(data.generatedAt.getTime() + PRICE_LIST_VALID_DAYS * 86_400_000))
  const w = new Writer(pdf, font, bold, `${t.title}${famTxt ? ` · ${famTxt}` : ''} · ${data.incoterm} · ${t.dates(issued, valid)}`, o.lang)
  await w.useLogo(o.logo ?? null)
  w.generatedBy = o.generatedBy ?? null
  // separador de milhar SEMPRE (o espanhol omite em 4 dígitos: "2000" ao lado de "10.000")
  const nf = (v: number, d = 0) => new Intl.NumberFormat(t.locale, { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: 'always' } as Intl.NumberFormatOptions).format(v)
  w.header(`${t.title}${famTxt ? ` — ${famTxt.toUpperCase()}` : ''}`, t.sub(data.incoterm), t.dates(issued, valid), 'Pacifil Brasil')

  // descrição do produto a partir do catálogo: "Hidrosilo 2 m × 3 m — 2.000 litros"
  // Hidrosilo / Hydroforce: montada das medidas; demais famílias: o nome do catálogo (distingue BPF, padrão, LP…)
  const product = (family: string, r: PriceListRow) =>
    hideThickness(family) && r.widthM && r.lengthM ? `${family} ${nf(r.widthM, r.widthM % 1 ? 1 : 0)} m × ${nf(r.lengthM, r.lengthM % 1 ? 1 : 0)} m${r.capacityL ? ` — ${nf(r.capacityL)} ${t.liters}` : ''}${r.brand !== 'Pacifil' ? ` (${r.brand})` : ''}` : r.name
  const width = A4.w - 2 * M
  // PACIFIL NXT: um quadro destacado no início (uma vez) e a menção em cada grupo das famílias NXT do Catálogo;
  // nas famílias com SELO (Hidrosilo) o selo vai junto da menção (e no quadro do início)
  const nxtFams = new Map(Object.entries(o.nxt?.families ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
  const nxtOf = (family: string) => nxtFams.get(family.toLowerCase()) ?? null
  const groupsNxt = data.groups.map((g) => nxtOf(g.family))
  const seal = groupsNxt.includes('SEAL') ? await w.image(o.nxt?.seal) : null
  if (o.nxt?.text.trim() && groupsNxt.some(Boolean)) w.highlightBox({ title: NXT_TITLE, text: o.nxt.text, image: seal, imageSize: 54 })
  // altura da menção no grupo: só texto = 11; selo (24 pt) + texto ao lado = 25
  const SEAL_TAG = 24
  const tagH = (mode: TechDisplay | null) => (mode === 'SEAL' && seal ? SEAL_TAG + 1 : mode ? 11 : 0)
  for (const g of data.groups) {
    // coluna do código na largura do maior código DO GRUPO (sem quebrar "AC-PAC-2.3X50-240")
    const codeW = Math.min(118, Math.max(62, ...g.rows.map((r) => w.textWidth(r.sku, 8.5) + 8)))
    const showThick = cols.thickness && !hideThickness(g.family)
    // ordem: código · PRODUTO · PREÇO (os dois destacados) · espessura · caixa · unid./palete · pesos
    const colDefs: { key: string; title: string; w: number; align?: 'right'; strong?: boolean }[] = [
      { key: 'code', title: t.cols.code, w: codeW },
      { key: 'product', title: t.cols.product, w: 0, strong: true },
      { key: 'price', title: t.cols.price, w: 66, align: 'right', strong: true },
      // espessura: 40 pt, ou o necessário para o título caber sem partir a palavra ("Thickness")
      ...(showThick ? [{ key: 'thick', title: t.cols.thick, w: Math.max(40, Math.ceil(w.textWidth(t.cols.thick, 7.5, true)) + 7), align: 'right' as const }] : []),
      ...(cols.box ? [{ key: 'box', title: t.cols.box, w: 80, align: 'right' as const }] : []),
      ...(cols.perPallet ? [{ key: 'perPallet', title: t.cols.perPallet, w: 42, align: 'right' as const }] : []),
      { key: 'net', title: t.cols.net, w: 46, align: 'right' },
      { key: 'gross', title: t.cols.gross, w: 46, align: 'right' },
    ]
    colDefs[1].w = width - colDefs.reduce((s, c) => s + c.w, 0)
    // título + descrição + cabeçalho + 2 linhas juntos (o título nunca fica sozinho no fim da página)
    const mode = nxtOf(g.family)
    // descrição comercial: a mesma para todos os produtos (uma vez por grupo, com a(s) marca(s) do grupo);
    // quebras de linha da textarea viram parágrafos (nunca '?')
    const brands = [...new Set(g.rows.map((r) => r.brand))].join(' / ')
    const descLines = o.description?.trim()
      ? o.description
          .replace(/\{marca\}/gi, brands)
          .split(/\r?\n/)
          .map((p) => p.replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .flatMap((p) => w.wrap(p, width, 7.5))
      : []
    // reserva a altura REAL da descrição (limitada a meia página: descrição enorme quebra normalmente)
    const descH = descLines.length ? Math.min(descLines.length * 9.5 + 3, A4.h / 2) : 0
    w.ensure(31 + descH + tagH(mode) + 1 + 30 + 2 * 22)
    w.section(t.group(g.family, g.label))
    if (mode === 'SEAL' && seal) {
      // selo à esquerda (topo logo abaixo do traço da seção) e a menção centralizada ao lado
      const sw = (seal.width / seal.height) * SEAL_TAG
      w.page.drawImage(seal, { x: M, y: w.y + 8 - SEAL_TAG, width: sw, height: SEAL_TAG })
      const y0 = w.y
      w.y = y0 + 8 - SEAL_TAG / 2 - 3
      w.text(NXT_TITLE, M + sw + 6, 9, { bold: true, color: GREEN_DARK })
      w.y = y0 + 8 - SEAL_TAG - 9
    } else if (mode) {
      w.text(NXT_TITLE, M, 8, { bold: true, color: GREEN_DARK })
      w.y -= 11
    }
    if (descLines.length) {
      for (const l of descLines) {
        w.ensure(10)
        w.text(l, M, 7.5, { color: GREY })
        w.y -= 9.5
      }
      w.y -= 3
    }
    w.table(
      colDefs.map(({ title, w: cw, align, strong }) => ({ title, w: cw, align, strong })),
      g.rows.map((r) => {
        const cell: Record<string, string> = {
          code: r.sku,
          product: product(g.family, r),
          thick: r.thicknessUm ? `${nf(r.thicknessUm)} µm` : '—',
          box: r.box ? `${nf(r.box.l)} × ${nf(r.box.w)} × ${nf(r.box.h)}` : '—',
          perPallet: r.unitsPerPallet ? `${nf(r.unitsPerPallet)}${r.palletCode?.includes('DUPLO') ? '*' : ''}` : '—',
          net: r.netKg != null ? nf(r.netKg, 2) : '—',
          gross: r.grossKg != null ? nf(r.grossKg, 2) : '—',
          price: r.priceUsd != null ? `USD ${nf(r.priceUsd, 2)}` : t.noPrice,
        }
        return colDefs.map((c) => cell[c.key])
      }),
    )
  }
  // observações: Incoterm, pesos, condição de pagamento, palete duplo (todas no mesmo estilo, sem negrito)
  w.ensure(60)
  w.y -= 6
  const terms = paymentTermsText(o.paymentTerms ?? null, o.lang)
  const doubles = cols.perPallet && data.groups.some((g) => g.rows.some((r) => r.palletCode?.includes('DUPLO')))
  const payLine = `${t.payment}: ${(terms ?? t.paymentAsk).replace(/\.$/, '')}.`
  const notes = [...t.notes(data.incoterm), payLine, ...(doubles ? [t.double] : [])]
  for (const n of notes) {
    for (const l of w.wrap(n, width, 7.5)) {
      w.ensure(11)
      w.text(l, M, 7.5, { color: GREY })
      w.y -= 10
    }
  }
  w.y -= 4
  const ref = `${t.title}${famTxt ? ` ${famTxt}` : ''}`
  w.contactBox(ref)
  w.finish(ref)
  return pdf.save()
}
