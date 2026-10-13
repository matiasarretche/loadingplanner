/**
 * PDF "Lista de volumes para coleta" (courier/paqueteria: DHL, FedEx…), pdf-lib no navegador.
 * Sem palete nem equipamento: cada caixa é um volume com medidas, peso real e peso volumétrico,
 * para o cliente agendar a coleta na fábrica.
 */
import { PDFDocument, StandardFonts } from 'pdf-lib'
import type { CourierPlan } from '@/domain/courier'
import { COMPANY, PdfLang, pdfText, PDF_TZ } from './i18n'
import { A4, clean, GREY, LINE, M, Writer, type PdfValue } from './orderPdf'

export interface CourierPdfMeta {
  /** valor (preços de exportação); ausente = sem seção de valor */
  value?: PdfValue | null
  reference?: string
  destination?: string
  generatedAt: Date
  lang: PdfLang
  logo?: Uint8Array | null
  /** PNG da bandeira do país de destino (opcional) */
  flag?: Uint8Array | null
  /** capturas do 3D (JPEG/PNG): perspectivas dos dois lados */
  images?: Uint8Array[]
  /** as caixas foram desenhadas empilhadas? (legenda das vistas) */
  stacked?: boolean
  /** nome do usuário que gerou o PDF (rodapé discreto) */
  generatedBy?: string | null
}

const cm = (mm: number) => Math.round(mm / 10)

export async function buildCourierPdf(plan: CourierPlan, meta: CourierPdfMeta): Promise<Uint8Array> {
  const t = pdfText(meta.lang)
  const pdf = await PDFDocument.create()
  pdf.setTitle(clean(`${t.courierDocTitle}${meta.reference ? ` — ${meta.reference}` : ''}`))
  pdf.setAuthor(COMPANY.legalName)
  pdf.setCreator('Pacifil Export Load Planner')
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const w = new Writer(pdf, font, bold, `${t.courierDocTitle}${meta.reference ? ` · ${meta.reference}` : ''} · ${t.generatedAt} ${meta.generatedAt.toLocaleString(t.locale, { timeZone: PDF_TZ })}`, meta.lang)
  const nf = w.nf
  await w.useLogo(meta.logo)
  w.generatedBy = meta.generatedBy ?? null
  await w.useFlag(meta.flag, meta.destination)
  const T = plan.totals
  /** parágrafo com quebra de linha (o Writer escreve uma linha por chamada) */
  const para = (text: string, size = 7.5) => {
    const lines: string[] = []
    for (const word of clean(text).split(' ')) {
      const cur = lines.length ? lines[lines.length - 1] : ''
      const joined = `${cur} ${word}`
      if (lines.length && font.widthOfTextAtSize(joined, size) <= A4.w - 2 * M) lines[lines.length - 1] = joined
      else lines.push(word)
    }
    w.ensure(lines.length * (size + 2.5) + 4)
    for (const l of lines) {
      w.text(l, M, size, { color: GREY })
      w.y -= size + 2.5
    }
  }

  w.header(t.courierTitle, meta.reference ? t.refLine(meta.reference) : t.courierDocTitle, meta.generatedAt.toLocaleDateString(t.locale, { timeZone: PDF_TZ }), 'Pacifil Brasil')

  w.section(t.secSummary)
  w.pairs([
    [t.modality, t.transport.COURIER],
    ...(meta.destination ? ([[t.destination, meta.destination]] as [string, string][]) : []),
    [t.courierPieces, nf(T.pieces)],
    [t.boxesUnits, `${nf(T.pieces)} / ${nf(T.units)}`],
    [t.grossTotal, `${nf(T.grossKg, 1)} kg`],
    [t.courierVolTotal, `${nf(T.volKg, 1)} kg (÷ ${nf(plan.divisor)})`],
    [t.courierChargeable, `${nf(T.chargeableKg, 1)} kg`],
    [t.palletVolume, `${nf(T.cbm, 3)} m³`],
  ])
  w.ensure(28)
  w.text(t.courierNoPallet, M, 8.5, { bold: true })
  w.y -= 12
  w.text(`${t.courierPickup}: ${COMPANY.address} – ${t.country}`, M, 8.5)
  w.y -= 6

  w.section(t.secProducts)
  w.table(
    [
      { title: t.code, w: 82 },
      { title: t.description, w: 150 },
      { title: t.boxes, w: 40, align: 'right' },
      { title: t.units, w: 40, align: 'right' },
      { title: t.courierDimsShort, w: 82, align: 'right' },
      { title: t.courierKgShort, w: 60, align: 'right' },
      { title: t.courierVolShort, w: 61, align: 'right' },
    ],
    plan.rows.map((r) => [r.sku, r.kitBox ? `${r.name} — ${t.kitBox(r.kitBox)}` : r.name, nf(r.boxes), nf(r.units), `${cm(r.dimsMm.l)} × ${cm(r.dimsMm.w)} × ${cm(r.dimsMm.h)}`, nf(r.grossKgEach, 1), nf(r.volKgEach, 1)]),
  )
  w.ensure(14)
  w.text(`${t.totalRow}: ${nf(T.pieces)} · ${nf(T.grossKg, 1)} kg · ${nf(T.volKg, 1)} kg vol. · ${nf(T.cbm, 3)} m³`, M, 8.5, { bold: true })
  w.y -= 12

  // vistas 3D (capturadas na tela)
  if (meta.images?.length) {
    w.section(t.courierViews)
    const gap = 10
    const imgs = meta.images.slice(0, 2)
    const imgW = imgs.length > 1 ? (A4.w - 2 * M - gap) / 2 : A4.w - 2 * M
    const embedded = []
    for (const bytes of imgs) embedded.push(bytes[0] === 0x89 && bytes[1] === 0x50 ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes))
    const maxH = Math.max(...embedded.map((img) => (img.height / img.width) * imgW))
    w.ensure(maxH + 22)
    embedded.forEach((img, i) => {
      const h = (img.height / img.width) * imgW
      w.page.drawImage(img, { x: M + i * (imgW + gap), y: w.y - h, width: imgW, height: h })
      w.page.drawRectangle({ x: M + i * (imgW + gap), y: w.y - h, width: imgW, height: h, borderColor: LINE, borderWidth: 0.6 })
    })
    w.y -= maxH + 12
    para(t.courierViewsNote(Boolean(meta.stacked)))
    w.y -= 4
  }

  // volumes um a um (o que o courier pede ao agendar: medidas e peso de cada peça)
  const pieces = plan.rows.flatMap((r) => Array.from({ length: r.boxes }, () => r))
  if (pieces.length <= 300) {
    w.section(t.courierPieceList)
    w.table(
      [
        { title: t.courierPiece, w: 50 },
        { title: t.code, w: 100 },
        { title: t.courierDims, w: 120, align: 'right' },
        { title: t.courierKgEach, w: 120, align: 'right' },
        { title: t.courierVolEach, w: 125, align: 'right' },
      ],
      pieces.map((r, i) => [`${i + 1}/${pieces.length}`, r.sku, `${cm(r.dimsMm.l)} × ${cm(r.dimsMm.w)} × ${cm(r.dimsMm.h)}`, nf(r.grossKgEach, 1), nf(r.volKgEach, 1)]),
    )
  }

  if (meta.value) w.valueSection(meta.value)
  w.y -= 4
  para(t.courierNote(nf(plan.divisor)))
  w.y -= 6
  const quote = meta.reference ? `${t.orderRef} ${meta.reference}` : `${t.courierDocTitle} ${meta.generatedAt.toLocaleDateString(t.locale, { timeZone: PDF_TZ })}`
  w.contactBox(quote)
  w.finish(quote)
  return pdf.save()
}
