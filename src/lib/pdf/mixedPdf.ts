/**
 * PDF do PLANO DE PALETES MISTOS (pdf-lib, roda no navegador).
 * Resumo, conferência pedido × paletes e, por palete: produtos/unidades/pesos e duas vistas
 * desenhadas a partir das posições reais das caixas (lateral = comprimento, frontal = largura).
 */
import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from 'pdf-lib'
import { distinctSkuColors } from '@/domain/colors'
import { orientDims } from '@/domain/geometry'
import type { MixedResult } from '@/domain/mixedPallets'
import type { PalletDoc } from '@/domain/types'
import { kitBoxLines, kitFamilyOf } from '@/domain/kitBoxes'
import { COMPANY, PdfLang, pdfText, PdfText, PDF_TZ } from './i18n'
import { A4, clean, GREY, LINE, M, Writer, type PdfValue } from './orderPdf'

export interface MixedPdfMeta {
  /** valor (preços de exportação); ausente = sem seção de valor */
  value?: PdfValue | null
  reference?: string
  /** modalidade (FCL, LCL, AIR, ROAD, PALLETS_ONLY), traduzida no PDF */
  mode: string
  maxHeightMm: number
  generatedAt: Date
  lang: PdfLang
  /** PNG do logo (opcional) */
  logo?: Uint8Array | null
  /** país de destino e PNG da bandeira (opcionais) */
  destination?: string
  flag?: Uint8Array | null
  /** nome do usuário que gerou o PDF (rodapé discreto) */
  generatedBy?: string | null
}

const hex = (h: string) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim())
  const n = m ? parseInt(m[1], 16) : 0x999999
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 }
}

/** Vista ortogonal do palete: axis 'x' = lateral (comprimento × altura), 'y' = frontal (largura × altura). */
function drawView(page: PDFPage, font: PDFFont, bold: PDFFont, doc: PalletDoc, axis: 'x' | 'y', x0: number, y0: number, maxW: number, maxH: number, caption: string, colorOf: Map<string, string>, t: PdfText, nf: (v: number, d?: number) => string) {
  const P = doc.palletType.dims
  const span = axis === 'x' ? P.l : P.w
  const boxes = doc.items.map((it) => {
    const pack = doc.packs[it.packId]
    const d = orientDims(pack.dims, it.orientation)
    return {
      a: axis === 'x' ? it.pos.x : it.pos.y,
      w: axis === 'x' ? d.x : d.y,
      z: it.pos.z + P.h,
      h: d.z,
      depth: axis === 'x' ? it.pos.y : it.pos.x,
      pack,
    }
  })
  const top = Math.max(P.h, ...boxes.map((b) => b.z + b.h))
  const s = Math.min(maxW / span, (maxH - 14) / top)
  const ox = x0 + (maxW - span * s) / 2
  const oy = y0 + 12
  // tabuleiro
  page.drawRectangle({ x: ox, y: oy, width: span * s, height: Math.max(1, P.h * s), color: rgb(0.71, 0.54, 0.35), borderColor: rgb(0.35, 0.25, 0.15), borderWidth: 0.4 })
  // caixas: do fundo para a frente (as da frente ficam visíveis)
  for (const b of boxes.sort((p, q) => q.depth - p.depth || p.z - q.z)) {
    const c = hex(colorOf.get(b.pack.sku) ?? b.pack.color)
    const x = ox + b.a * s, y = oy + b.z * s, w = b.w * s, h = b.h * s
    page.drawRectangle({ x, y, width: w, height: h, color: rgb(c.r, c.g, c.b), borderColor: rgb(0.12, 0.16, 0.2), borderWidth: 0.4 })
    const label = clean(b.pack.sku.replace(/^HS-/, 'HS '))
    let fs = Math.min(7, h * 0.6)
    while (fs > 3.5 && bold.widthOfTextAtSize(label, fs) > w - 2) fs -= 0.5
    if (fs > 3.5 && h > 5) {
      const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b
      page.drawText(label, { x: x + (w - bold.widthOfTextAtSize(label, fs)) / 2, y: y + (h - fs) / 2 + 0.8, size: fs, font: bold, color: lum > 0.6 ? rgb(0.1, 0.1, 0.1) : rgb(1, 1, 1) })
    }
  }
  page.drawText(clean(`${caption} · ${nf(span)} mm × ${t.heightWord} ${nf(top)} mm`), { x: x0, y: y0, size: 7, font, color: GREY })
}

/** medidas externas em cm (C × L × A), como se cota frete */
const cmDims = (d: { l: number; w: number; h: number }) => `${Math.round(d.l / 10)} × ${Math.round(d.w / 10)} × ${Math.round(d.h / 10)}`

export async function buildMixedPdf(plan: MixedResult, meta: MixedPdfMeta): Promise<Uint8Array> {
  const t = pdfText(meta.lang)
  const pdf = await PDFDocument.create()
  pdf.setTitle(clean(`${t.mixedDocTitle}${meta.reference ? ` — ${meta.reference}` : ''}`))
  pdf.setAuthor(COMPANY.legalName)
  pdf.setCreator('Pacifil Export Load Planner')
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const w = new Writer(pdf, font, bold, `${t.mixedDocTitle}${meta.reference ? ` · ${meta.reference}` : ''} · ${t.generatedAt} ${meta.generatedAt.toLocaleString(t.locale, { timeZone: PDF_TZ })}`, meta.lang)
  const nf = w.nf
  await w.useLogo(meta.logo)
  w.generatedBy = meta.generatedBy ?? null
  await w.useFlag(meta.flag, meta.destination)
  const width = A4.w - 2 * M
  // uma cor por produto no plano (sem repetir entre SKUs diferentes), igual ao 3D
  const colorOf = distinctSkuColors(plan.pallets.flatMap((p) => Object.values(p.doc.packs)))

  w.header(t.mixedTitle, meta.reference ? t.refLine(meta.reference) : t.mixedDocTitle, meta.generatedAt.toLocaleDateString(t.locale, { timeZone: PDF_TZ }), 'Pacifil Brasil')

  w.section(t.secSummary)
  const allOk = plan.check.every((c) => c.ok)
  w.pairs([
    [t.modality, t.transport[meta.mode] ?? meta.mode],
    [t.maxPalletH, `${nf(meta.maxHeightMm)} mm ${t.deckPlusBoxes}`],
    [t.pallets, `${nf(plan.totals.pallets)} (${t.floorPositions(nf(plan.positions))})`],
    [t.boxesUnits, `${nf(plan.totals.boxes)} / ${nf(plan.totals.units)}`],
    [t.grossTotal, `${nf(plan.totals.grossKg, 1)} kg`],
    [t.netWeight, `${nf(plan.totals.netKg, 1)} kg`],
    [t.palletVolume, t.totalCbm(nf(plan.totals.cbm, 2), plan.totals.pallets)],
    [t.orderCheck, allOk ? t.checkOk : t.checkDiff],
  ])

  w.section(t.secCheck)
  w.table(
    [
      { title: t.code, w: 90 },
      { title: t.description, w: 215 },
      { title: t.ordered, w: 60, align: 'right' },
      { title: t.onPallets, w: 70, align: 'right' },
      { title: t.situation, w: 80, align: 'right' },
    ],
    plan.check.map((c) => [c.sku, c.name, nf(c.requested), nf(c.placed), c.ok ? 'OK' : c.placed < c.requested ? t.missingN(nf(c.requested - c.placed)) : t.exceedsN(nf(c.placed - c.requested))]),
  )
  if (plan.unplaced.length) {
    w.ensure(14)
    w.text(`${t.notPlaced}: ${plan.unplaced.map((u) => `${u.boxes} × ${u.sku} (${u.reason})`).join('; ')}`, M, 8, { color: rgb(0.84, 0.15, 0.16) })
    w.y -= 12
  }

  // Resumo por palete (tabela compacta)
  w.section(t.pallets)
  w.table(
    [
      { title: t.pallet, w: 38 },
      { title: t.type, w: 66 },
      { title: t.content, w: 150 },
      { title: t.dimsCol, w: 92, align: 'right' },
      { title: t.cbmCol, w: 45, align: 'right' },
      { title: t.weightKg, w: 70, align: 'right' },
      { title: t.occ, w: 54, align: 'right' },
    ],
    plan.pallets.map((p, i) => [
      String(i + 1),
      p.doc.palletType.code,
      p.lines.map((l) => `${l.sku.replace(/^HS-/, 'HS ')}: ${l.units}`).join(', '),
      cmDims(p.outerMm),
      nf(p.cbm, 3),
      nf(p.grossKg, 1),
      `${nf(p.volumeUtilPct)}%`,
    ]),
  )
  // linha de total (cubagem e peso) + como a cubagem é medida
  w.ensure(14)
  w.text(`${t.totalRow}: ${t.totalCbm(nf(plan.totals.cbm, 2), plan.totals.pallets)} · ${nf(plan.totals.grossKg, 1)} kg`, M, 8.5, { bold: true })
  w.y -= 11
  w.text(t.cbmNote, M, 7, { color: GREY })
  w.y -= 6

  // Detalhe de cada palete
  plan.pallets.forEach((p, i) => {
    const pt = p.doc.palletType
    const kitLines = p.lines.filter((l) => kitFamilyOf(l.sku))
    w.ensure(60 + p.lines.length * 14 + kitLines.length * 11 + 175)
    w.section(`${t.pallet} ${i + 1} — ${pt.code} ${pt.dims.l} × ${pt.dims.w} mm`)
    w.table(
      [
        { title: '', w: 14 },
        { title: t.code, w: 90 },
        { title: t.description, w: 215 },
        { title: t.boxes, w: 55, align: 'right' },
        { title: t.units, w: 55, align: 'right' },
        { title: t.grossKg, w: 86, align: 'right' },
      ],
      p.lines.map((l) => ['', l.sku, l.name, nf(l.boxes), nf(l.units), nf(l.grossKg, 1)]),
    )
    // amostras de cor na 1ª coluna da tabela recém-desenhada
    const rowH = 14
    p.lines.forEach((l, k) => {
      const pack = Object.values(p.doc.packs).find((x) => x.sku === l.sku)
      if (!pack) return
      const c = hex(colorOf.get(pack.sku) ?? pack.color)
      const y = w.y + rowH * (p.lines.length - k) - 2
      w.page.drawRectangle({ x: M + 3, y, width: 7, height: 7, color: rgb(c.r, c.g, c.b) })
    })
    w.ensure(14)
    const crit = p.issues.filter((x) => x.severity === 'CRITICAL')
    w.text(t.palletLine(nf(p.grossKg, 1), nf(p.netKg, 1), nf(p.heightMm), nf(p.volumeUtilPct), crit.length), M, 8, { color: crit.length ? rgb(0.84, 0.15, 0.16) : GREY })
    w.y -= 11
    // kits: caixas por tipo (caixa 79583 de 26, meia caixa, individuais)
    for (const l of kitLines) {
      w.text(`${l.sku}: ${t.kitBoxes(kitBoxLines(p.doc.items.map((it) => p.doc.packs[it.packId]).filter((k) => k?.sku === l.sku)))}`, M, 8)
      w.y -= 11
    }
    w.text(t.dimsLine(cmDims(p.outerMm), nf(p.cbm, 3)), M, 8, { bold: true })
    w.y -= 8
    // vistas
    const viewH = 165
    w.ensure(viewH + 6)
    const gap = 16
    const lw = (width - gap) * (pt.dims.l / (pt.dims.l + pt.dims.w))
    const fw = width - gap - lw
    drawView(w.page, font, bold, p.doc, 'x', M, w.y - viewH, lw, viewH, t.sideView, colorOf, t, nf)
    drawView(w.page, font, bold, p.doc, 'y', M + lw + gap, w.y - viewH, fw, viewH, t.frontView, colorOf, t, nf)
    w.page.drawLine({ start: { x: M, y: w.y - viewH - 4 }, end: { x: M + width, y: w.y - viewH - 4 }, thickness: 0.3, color: LINE })
    w.y -= viewH + 12
  })

  if (meta.value) w.valueSection(meta.value)
  w.ensure(26)
  w.y -= 6
  w.text(t.mixedFooterNote, M, 7.5, { color: GREY })
  w.y -= 4
  const quote = meta.reference ? `${t.orderRef} ${meta.reference}` : `${t.mixedDocTitle} ${meta.generatedAt.toLocaleDateString(t.locale, { timeZone: PDF_TZ })}`
  w.contactBox(quote)
  w.finish(quote)
  return pdf.save()
}
