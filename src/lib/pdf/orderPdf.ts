/**
 * PDF "Resumo do pedido" (pdf-lib, puro JS: roda em qualquer servidor/serverless).
 * Separação: `OrderPdfData` (conteúdo, montado a partir da versão SALVA) × `buildOrderPdf` (layout).
 * Idioma (pt/es/en) escolhido na exportação; logo e dados da Pacifil Brasil no cabeçalho/rodapé.
 */
import { PDFDocument, PDFFont, PDFImage, PDFPage, PDFString, rgb, StandardFonts } from 'pdf-lib'
import { COMPANY, instagramUrl, mailUrl, MAPS_URL, numFmt, PdfLang, pdfText, PdfText, whatsappUrl, PDF_TZ } from './i18n'
import { countryNameIn } from '@/lib/countries'
import { proformaTotals } from '@/domain/pricing'
import { PaymentTerms, paymentTermsText, TermsLang } from '@/domain/paymentTerms'
import type { KitBoxLine } from '@/domain/kitBoxes'
import { FamilyTech, TECHNOLOGIES, TechKey } from '@/domain/technology'
import { clean } from './winAnsi'

export interface OrderPdfData {
  company: string
  generatedAt: Date
  /** status = código (DRAFT, APPROVED…), traduzido no layout */
  plan: { name: string; version: number; status: string }
  customer: { name: string; country?: string | null; city?: string | null; taxId?: string | null }
  /** mode = código (SEA, ROAD, AIR) */
  order: { ref?: string | null; incoterm: string; destination: string; mode: string; originPlace?: string | null; destinationPlace?: string | null; customerAddress?: string | null; service?: string }
  /** lengthInformed = comprimento útil informado na carga (≠ cadastro) */
  equipment: { code: string; name: string; innerMm: string; lengthInformed?: boolean; doorMm: string; tareKg: number; payloadLimitKg: number | null; grossLimitKg: number | null; estimated: boolean } | null
  /** envio sem equipamento (LCL, aéreo carga solta, só paletes, courier) */
  shipping?: {
    service: string
    maxHeightMm: number | null
    pallets: number
    boxes: number
    grossKg: number
    netKg: number
    cbm: number
    chargeableKg: number | null
    courier: { pieces: number; volKg: number; chargeableKg: number; divisor: number } | null
  } | null
  /** netKg = só produto · packedKg = produto + caixa · grossKg = produto + caixa + parte da tara dos paletes */
  /** kitBoxes = caixas de kits por tipo (26 / meia caixa / individuais), só quando há caixa coletiva */
  /** tech = tecnologia da família no Catálogo (PACIFIL NXT); display SEAL = selo ao lado do item */
  products: { sku: string; name: string; boxes: number; units: number; netKg: number; packedKg: number; grossKg: number; unitPrice: number | null; currency: string | null; per: string | null; amount: number | null; kitBoxes?: KitBoxLine[]; tech?: FamilyTech | null }[]
  pallets: { name: string; count: number; boxes: number; fullBoxes: number | null; grossKgEach: number }[]
  totals: {
    pallets: number
    looseBoxes: number
    boxes: number
    units: number
    netKg: number
    goodsGrossKg: number
    palletTareKg: number
    payloadKg: number
    payloadPct: number | null
    equipmentTareKg: number
    grossTotalKg: number
    cbm: number
    volumePct: number
    floorPct: number
    usedLengthMm: number
  }
  value: { totals: Record<string, number>; missing: string[] }
  /** proforma: frete e seguro (USD) somados uma vez ao subtotal; condições de pagamento (texto no idioma do PDF) */
  proforma?: { freightUsd: number | null; insuranceUsd: number | null; paymentTerms: PaymentTerms | null } | null
  /** % do peso total por quadrante (NORTE = motorista, SUL = porta) */
  /** frente (motorista) × traseira (porta), faixa recomendada da traseira e situação */
  weight: { NE: number; NO: number; SE: number; SO: number; north: number; south: number; ok: boolean; zone: string; rearMin: number; rearIdealMin: number; rearMax: number } | null
  /** observações (traduzidas no layout) */
  flags: { equipmentReference: boolean; noNetSkus: string[]; notApproved: boolean }
}

// ---------------------------------------------------------------------------

export const A4 = { w: 595.28, h: 841.89 }
export const M = 40
export const GREEN = rgb(0.043, 0.43, 0.31)
/** verde-escuro para destacar colunas (lista de preços) */
export const GREEN_DARK = rgb(0.02, 0.29, 0.2)
export const GREY = rgb(0.37, 0.42, 0.47)
export const LINE = rgb(0.85, 0.87, 0.9)
/** espaço reservado no pé de cada página (dados da empresa) */
const FOOT = 46

/** Formatação pt-BR (compatibilidade); os builders usam numFmt(lang). */
export const nf = numFmt('pt')

/** Valor para os PDFs sem carga (paletes mistos, courier): preço unitário USD por produto. */
export interface PdfValue {
  lines: { sku: string; name: string; units: number; unitUsd: number | null; amount: number | null }[]
  totalUsd: number | null
  missing: string[]
  /** Incoterm do preço (CIF inclui o recargo por kg) */
  incoterm?: string | null
}

// texto para o WinAnsi das fontes padrão (os outros PDFs importam clean daqui)
export { clean }

export interface PdfBrand {
  lang: PdfLang
  /** PNG do logo (opcional: sem ele o cabeçalho usa o nome da empresa) */
  logo?: Uint8Array | null
  /** PNG da bandeira do país de destino (opcional) */
  flag?: Uint8Array | null
  /** fotos do carregamento (anexo no fim do PDF) */
  photos?: { bytes: Uint8Array; caption: string | null; date: Date | null }[]
  /** fotos que não entraram no PDF (limite) */
  photosOmitted?: number
  /** selos das tecnologias (PNG por chave, ex.: NXT): vão ao lado dos itens cuja família tem SELO no Catálogo */
  seals?: Partial<Record<TechKey, Uint8Array | null>>
  /** nome do usuário que gerou o documento (rodapé discreto) */
  generatedBy?: string | null
}

export class Writer {
  page!: PDFPage
  y = 0
  readonly t: PdfText
  readonly nf: (v: number, d?: number) => string
  private logoImg: PDFImage | null = null
  private flagImg: PDFImage | null = null
  private flagLabel = ''
  /** nome de quem gerou o documento: discreto no rodapé, ao lado do número da página */
  generatedBy: string | null = null
  constructor(
    private pdf: PDFDocument,
    private font: PDFFont,
    private bold: PDFFont,
    private footer: string,
    lang: PdfLang = 'pt',
  ) {
    this.t = pdfText(lang)
    this.nf = numFmt(lang)
    this.newPage()
  }
  /** carrega o logo (antes do cabeçalho) */
  async useLogo(bytes?: Uint8Array | null) {
    if (!bytes?.length) return
    try {
      this.logoImg = await this.pdf.embedPng(bytes)
    } catch {
      this.logoImg = null
    }
  }
  /** bandeira do país de destino, mostrada no cabeçalho junto com o nome do país */
  async useFlag(bytes: Uint8Array | null | undefined, country: string | null | undefined) {
    if (!bytes?.length || !country) return
    try {
      this.flagImg = await this.pdf.embedPng(bytes)
      this.flagLabel = country
    } catch {
      this.flagImg = null
    }
  }
  /** embute um PNG (selos etc.); imagem inválida = null (o PDF sai sem ela, nunca falha por isso) */
  async image(bytes?: Uint8Array | null): Promise<PDFImage | null> {
    if (!bytes?.length) return null
    try {
      return await this.pdf.embedPng(bytes)
    } catch {
      return null
    }
  }
  newPage() {
    this.page = this.pdf.addPage([A4.w, A4.h])
    this.y = A4.h - M
  }
  ensure(h: number) {
    if (this.y - h < M + FOOT - 20) this.newPage()
  }
  text(t: string, x: number, size = 9, opts: { bold?: boolean; color?: ReturnType<typeof rgb>; align?: 'left' | 'right'; width?: number } = {}) {
    const f = opts.bold ? this.bold : this.font
    const s = clean(t)
    const w = f.widthOfTextAtSize(s, size)
    const px = opts.align === 'right' && opts.width ? x + opts.width - w : x
    this.page.drawText(s, { x: px, y: this.y, size, font: f, color: opts.color ?? rgb(0.09, 0.13, 0.17) })
  }
  line(y = this.y) {
    this.page.drawLine({ start: { x: M, y }, end: { x: A4.w - M, y }, thickness: 0.6, color: LINE })
  }
  /**
   * Cabeçalho: logo à esquerda (discreto), título do documento e linha de referência à direita.
   */
  header(title: string, subtitle: string, date: string, company: string) {
    const width = A4.w - 2 * M
    const top = this.y + 8
    let left = M
    if (this.logoImg) {
      const h = 34
      const w = (this.logoImg.width / this.logoImg.height) * h
      this.page.drawImage(this.logoImg, { x: M, y: top - h, width: w, height: h })
      left = M + w + 14
    } else {
      this.text(company, M, 16, { bold: true, color: GREEN })
      left = M + 200
    }
    this.y = top - 12
    this.text(title, left, 10, { bold: true, align: 'right', width: width - (left - M) })
    this.y -= 14
    this.text(subtitle, left, 9, { align: 'right', width: width - (left - M) })
    this.y -= 12
    this.text(date, left, 8, { align: 'right', width: width - (left - M), color: GREY })
    // bandeira + país de destino, alinhados à direita abaixo da data
    if (this.flagImg) {
      this.y -= 15
      const fh = 11
      const fw = (this.flagImg.width / this.flagImg.height) * fh
      const label = clean(this.flagLabel)
      const lw = this.bold.widthOfTextAtSize(label, 8.5)
      const x = A4.w - M - lw
      this.text(label, x, 8.5, { bold: true })
      this.page.drawImage(this.flagImg, { x: x - fw - 5, y: this.y - 2.5, width: fw, height: fh })
      this.page.drawRectangle({ x: x - fw - 5, y: this.y - 2.5, width: fw, height: fh, borderColor: LINE, borderWidth: 0.4 })
    }
    this.y = Math.min(this.y, top - 34) - 8
    this.line()
    this.y -= 4
  }
  section(title: string) {
    this.ensure(30)
    this.y -= 14
    this.text(title.toUpperCase(), M, 9, { bold: true, color: GREEN })
    this.y -= 5
    this.line()
    this.y -= 12
  }
  /** lista rótulo → valor em UMA coluna (valores numéricos alinhados à direita; textos longos quebram) */
  kvList(rows: { label: string; value: string; bold?: boolean; right?: boolean }[]) {
    const vx = M + 170
    const vw = A4.w - M - vx
    for (const r of rows) {
      const lines = r.right ? [clean(r.value)] : this.wrap(r.value, vw, 9.5, r.bold)
      this.ensure(14 + (lines.length - 1) * 11)
      this.text(r.label, M, 8.5, { color: GREY, bold: r.bold })
      lines.forEach((l, j) => {
        const y0 = this.y
        this.y = y0 - j * 11
        this.text(l, vx, 9.5, { bold: r.bold, align: r.right ? 'right' : 'left', width: r.right ? 130 : undefined })
        this.y = y0
      })
      this.y -= 13 + (lines.length - 1) * 11
    }
  }
  /** pares rótulo/valor em 2 colunas */
  pairs(rows: [string, string][]) {
    const colW = (A4.w - 2 * M) / 2
    for (let i = 0; i < rows.length; i += 2) {
      this.ensure(14)
      let extra = 0
      for (let k = 0; k < 2 && i + k < rows.length; k++) {
        const [label, value] = rows[i + k]
        const x = M + k * colW
        this.text(label, x, 8, { color: GREY })
        const lines = this.wrap(value, colW - 116, 9)
        lines.forEach((l, j) => {
          const y0 = this.y
          this.y = y0 - j * 11
          this.text(l, x + 110, 9)
          this.y = y0
        })
        extra = Math.max(extra, lines.length - 1)
      }
      this.y -= 13 + extra * 11
    }
  }
  textWidth(t: string, size: number, bold = false) {
    return (bold ? this.bold : this.font).widthOfTextAtSize(clean(t), size)
  }
  /**
   * Quebra o texto em linhas que cabem em `width` (por palavras; palavra longa demais — ex.: um código —
   * quebra depois de "-", "×" ou "/" e, em último caso, por caractere). Nunca deixa texto passar da coluna.
   */
  wrap(t: string, width: number, size: number, bold = false): string[] {
    const f = bold ? this.bold : this.font
    const fits = (x: string) => f.widthOfTextAtSize(x, size) <= width
    const s = clean(t)
    if (fits(s)) return [s]
    // pedaços: palavras, e palavras longas partidas nos separadores
    const pieces: string[] = []
    for (const word of s.split(/(\s+)/)) {
      if (!word) continue
      if (/^\s+$/.test(word) || fits(word)) {
        pieces.push(word)
        continue
      }
      for (const part of word.split(/(?<=[-×/_])/)) {
        if (fits(part)) pieces.push(part)
        else {
          let cur = ''
          for (const ch of part) {
            if (cur && !fits(cur + ch)) {
              pieces.push(cur)
              cur = ''
            }
            cur += ch
          }
          if (cur) pieces.push(cur)
        }
      }
    }
    const lines: string[] = []
    let cur = ''
    for (const p of pieces) {
      if (!cur) {
        if (!/^\s+$/.test(p)) cur = p
        continue
      }
      if (fits(cur + p)) cur += p
      else {
        lines.push(cur.trimEnd())
        cur = /^\s+$/.test(p) ? '' : p
      }
    }
    if (cur.trim()) lines.push(cur.trimEnd())
    return lines.length ? lines : [s]
  }
  /**
   * Tabela: cada célula quebra em quantas linhas precisar dentro da largura da coluna (a linha da tabela
   * cresce para a mais alta) — textos nunca se sobrepõem à coluna vizinha.
   */
  /** strong: coluna destacada (negrito, verde-escuro) — ex.: produto e preço na lista de preços */
  /**
   * icons: imagem (ex.: selo PACIFIL NXT) por linha de dados, desenhada logo depois do texto da coluna
   * `iconCol` (que reserva o espaço dela); a linha cresce o necessário para o ícone caber.
   */
  table(cols: { title: string; w: number; align?: 'right'; strong?: boolean }[], rows: string[][], boldLast = false, opts: { icons?: (PDFImage | null | undefined)[]; iconCol?: number; iconSize?: number } = {}) {
    const iconCol = opts.iconCol ?? 0
    const isz = opts.iconSize ?? 14
    const draw = (cells: string[], bold: boolean, head = false, icon: PDFImage | null = null) => {
      const size = head ? 7.5 : 8.5
      const lead = size + 2
      const wrapped = cells.map((c, k) => this.wrap(c ?? '', cols[k].w - 6 - (icon && k === iconCol ? isz + 3 : 0), size, bold || head || (!head && cols[k].strong)))
      const n = Math.max(1, ...wrapped.map((l) => l.length))
      // faixa da linha: do traço anterior (y0 + 10) até y0 - (n-1)·lead - 4; o ícone (topo em y0 + 8) precisa caber
      const extra = icon ? Math.max(0, isz + 4 - (14 + (n - 1) * lead)) : 0
      this.ensure(14 + (n - 1) * lead + extra)
      const y0 = this.y
      let x = M
      wrapped.forEach((lines, k) => {
        const col = cols[k]
        lines.forEach((l, j) => {
          this.y = y0 - j * lead
          this.text(l, x + 2, size, { bold: bold || head || col.strong, color: head ? GREY : col.strong ? GREEN_DARK : undefined, align: col.align === 'right' ? 'right' : 'left', width: col.w - 4 })
        })
        if (icon && k === iconCol) {
          const iw = (icon.width / icon.height) * isz
          const tw = Math.max(0, ...lines.map((l) => this.textWidth(l, size, bold || col.strong)))
          this.page.drawImage(icon, { x: Math.min(x + 2 + tw + 3, x + col.w - 2 - iw), y: y0 + 8 - isz, width: iw, height: isz })
        }
        x += col.w
      })
      this.y = y0 - (n - 1) * lead - 4 - extra
      this.line()
      this.y -= 10
    }
    draw(cols.map((c) => c.title), false, true)
    rows.forEach((r, i) => draw(r, boldLast && i === rows.length - 1, false, opts.icons?.[i] ?? null))
  }
  /**
   * Quadro destacado (fundo verde-claro, borda e barra verdes à esquerda): imagem opcional à esquerda (ex.:
   * selo PACIFIL NXT), título em negrito e texto (parágrafos separados por quebra de linha).
   */
  highlightBox(o: { title: string; text: string; image?: PDFImage | null; imageSize?: number; titleSize?: number; textSize?: number }) {
    const width = A4.w - 2 * M
    const ts = o.titleSize ?? 11
    const xs = o.textSize ?? 8.5
    const lead = xs + 2.5
    const img = o.image ?? null
    const isz = img ? (o.imageSize ?? 52) : 0
    const iw = img ? (img.width / img.height) * isz : 0
    const pad = 10
    const tx = M + 14 + (img ? iw + 12 : 0)
    const paras = o.text
      .split(/\r?\n/)
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    const lines = paras.flatMap((p) => this.wrap(p, A4.w - M - 12 - tx, xs))
    const textH = ts + (lines.length ? 4 + lines.length * lead : 0)
    const h = Math.max(textH, isz) + 2 * pad
    this.ensure(h + 8)
    this.y -= 4
    const top = this.y
    this.page.drawRectangle({ x: M, y: top - h, width, height: h, color: rgb(0.93, 0.97, 0.95), borderColor: GREEN, borderWidth: 0.8 })
    this.page.drawRectangle({ x: M, y: top - h, width: 4, height: h, color: GREEN })
    if (img) this.page.drawImage(img, { x: M + 12, y: top - h / 2 - isz / 2, width: iw, height: isz })
    // bloco de texto centralizado na altura do quadro (quando a imagem é mais alta)
    const blockTop = top - pad - (h - 2 * pad - textH) / 2
    this.y = blockTop - ts * 0.8
    this.text(o.title, tx, ts, { bold: true, color: GREEN_DARK })
    lines.forEach((l, i) => {
      this.y = blockTop - ts - 4 - i * lead - xs * 0.8
      this.text(l, tx, xs)
    })
    this.y = top - h - 8
  }
  /**
   * Seção VALOR com a tabela por produto (paletes mistos e courier, sem carga). Preço unitário em USD
   * (a comissão de agente, se houver, já está dentro do preço e não é mostrada).
   */
  valueSection(v: PdfValue) {
    const t = this.t
    const nf = this.nf
    this.section(t.secValue)
    if (v.incoterm) {
      this.pairs([[t.incoterm, v.incoterm]])
    }
    const priced = v.lines.filter((l) => l.unitUsd != null)
    if (priced.length)
      this.table(
        [
          { title: t.code, w: 110 },
          { title: t.description, w: 205 },
          { title: t.units, w: 55, align: 'right' },
          { title: `${t.price} USD`, w: 70, align: 'right' },
          { title: `${t.total} USD`, w: 75, align: 'right' },
        ],
        [...priced.map((l) => [l.sku, l.name, nf(l.units), nf(l.unitUsd!, 2), nf(l.amount ?? 0, 2)]), [t.totalRow, '', '', '', v.totalUsd != null ? nf(v.totalUsd, 2) : '—']],
        true,
      )
    else this.pairs([[t.valueTotal('—').replace(' (—)', ''), t.noPrices]])
    if (v.missing.length) {
      this.ensure(14)
      this.text(`${t.noPrice}: ${v.missing.join(', ')}`, M, 8, { color: GREY })
      this.y -= 12
    }
  }
  /** Área clicável (anotação de link) que abre `url` no leitor de PDF. */
  link(page: PDFPage, x: number, y: number, w: number, h: number, url: string) {
    const annot = this.pdf.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [x, y, x + w, y + h],
      Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) },
    })
    page.node.addAnnot(this.pdf.context.register(annot))
  }
  /** texto + link sobre ele; devolve a largura desenhada */
  private linkText(page: PDFPage, s: string, x: number, y: number, size: number, url: string, opts: { bold?: boolean; color?: ReturnType<typeof rgb>; underline?: boolean } = {}) {
    const f = opts.bold ? this.bold : this.font
    const txt = clean(s)
    const w = f.widthOfTextAtSize(txt, size)
    const color = opts.color ?? GREY
    page.drawText(txt, { x, y, size, font: f, color })
    if (opts.underline) page.drawLine({ start: { x, y: y - 1 }, end: { x: x + w, y: y - 1 }, thickness: 0.4, color })
    this.link(page, x, y - 2, w, size + 3, url)
    return w
  }
  /**
   * Quadro de contato comercial (fim do documento): o quadro inteiro abre o WhatsApp da Exportação com
   * uma mensagem pronta citando esta cotização (`quote`); o e-mail abre o correio com o assunto preenchido.
   */
  contactBox(quote: string) {
    const t = this.t
    const h = 52
    // só se couber nesta página: o rodapé de todas as páginas já traz o contato (não abre página só para o quadro)
    if (this.y - h - 16 < M + FOOT - 20) return
    this.y -= 10
    const top = this.y
    const p = this.page
    const wa = whatsappUrl(t.waMessage(quote))
    p.drawRectangle({ x: M, y: top - h, width: A4.w - 2 * M, height: h, borderColor: LINE, borderWidth: 0.6, color: rgb(0.97, 0.985, 0.975) })
    this.y = top - 12
    this.text(t.contactTitle.toUpperCase(), M + 8, 7.5, { bold: true, color: GREEN })
    this.y -= 11
    this.text(t.contactText, M + 8, 7.5, { color: GREY })
    this.y -= 12
    let x = M + 8
    x += this.linkText(p, `${t.exportDept} · `, x, this.y, 8, wa, { bold: true, color: rgb(0.09, 0.13, 0.17) })
    x += this.linkText(p, `E-mail: ${COMPANY.email}`, x, this.y, 8, mailUrl(t.mailSubject(quote)), { bold: true, color: GREEN, underline: true })
    x += this.linkText(p, ' · ', x, this.y, 8, wa, { bold: true })
    this.linkText(p, `WhatsApp: ${COMPANY.whatsapp}`, x, this.y, 8, wa, { bold: true, color: GREEN, underline: true })
    this.y -= 11
    this.linkText(p, t.waCta, M + 8, this.y, 7.5, wa, { bold: true, color: GREEN, underline: true })
    // resto do quadro (título e texto) também abre o WhatsApp
    this.link(p, M, top - 26, A4.w - 2 * M, 26, wa)
    this.y = top - h - 4
  }
  /**
   * Rodapé em todas as páginas: empresa, endereço (Google Maps), origem, contato (e-mail/WhatsApp), Instagram
   * (links), referência, quem gerou e página. Fica abaixo de y=48 (o conteúdo nunca desce de y=66).
   */
  finish(quote = '') {
    const t = this.t
    const pages = this.pdf.getPages()
    const s = 6.5
    const wa = whatsappUrl(t.waMessage(quote))
    pages.forEach((p, i) => {
      p.drawLine({ start: { x: M, y: 48 }, end: { x: A4.w - M, y: 48 }, thickness: 0.4, color: LINE })
      let x = M
      x += this.linkText(p, `${COMPANY.legalName} · `, x, 39, s, MAPS_URL)
      this.linkText(p, `${COMPANY.address} – ${t.country}`, x, 39, s, MAPS_URL, { underline: true })
      x = M
      x += this.linkText(p, `${t.origin} · ${t.exportDept}: `, x, 31, s, wa)
      x += this.linkText(p, COMPANY.email, x, 31, s, mailUrl(t.mailSubject(quote)), { underline: true })
      x += this.linkText(p, ' · WhatsApp ', x, 31, s, wa)
      this.linkText(p, COMPANY.whatsapp, x, 31, s, wa, { underline: true })
      // redes sociais: cada perfil abre o Instagram
      x = M
      x += this.linkText(p, `${t.followUs} `, x, 23, s, instagramUrl(COMPANY.instagram[0]))
      COMPANY.instagram.forEach((h, k) => {
        if (k) x += this.linkText(p, ' · ', x, 23, s, instagramUrl(h))
        x += this.linkText(p, `@${h}`, x, 23, s, instagramUrl(h), { underline: true, color: GREEN })
      })
      const contactEnd = x
      let left = clean(this.footer)
      const pg = clean(t.page(i + 1, pages.length))
      const pw = this.font.widthOfTextAtSize(pg, s)
      // quem gerou (discreto): antes do número da página; se a referência for longa, à direita da linha do
      // Instagram; em último caso a referência (repetida do cabeçalho) é encurtada — nunca abaixo de y=15 (impressão)
      const name = this.generatedBy?.trim() ? clean(t.generatedBy(this.generatedBy.trim())) : ''
      if (name) {
        const by = `${name} · `
        const bw = this.font.widthOfTextAtSize(by, s)
        const nw = this.font.widthOfTextAtSize(name, s)
        if (M + this.font.widthOfTextAtSize(left, s) + 12 + bw + pw <= A4.w - M) p.drawText(by, { x: A4.w - M - pw - bw, y: 15, size: s, font: this.font, color: GREY })
        else if (contactEnd + 12 + nw <= A4.w - M) p.drawText(name, { x: A4.w - M - nw, y: 23, size: s, font: this.font, color: GREY })
        else {
          const room = A4.w - M - pw - bw - 12 - M
          while (left.length > 1 && this.font.widthOfTextAtSize(`${left}…`, s) > room) left = left.slice(0, -1)
          left = `${left.trimEnd()}…`
          p.drawText(by, { x: A4.w - M - pw - bw, y: 15, size: s, font: this.font, color: GREY })
        }
      }
      p.drawText(left, { x: M, y: 15, size: s, font: this.font, color: GREY })
      p.drawText(pg, { x: A4.w - M - pw, y: 15, size: s, font: this.font, color: GREY })
    })
  }
}

/** textos do envio sem equipamento (pt/es/en) */
const NOEQ: Record<PdfLang, { sec: string; svc: Record<string, string>; maxH: string; pieces: string; boxes: string; volumetric: string; chargeable: string; note: string; gross: string }> = {
  pt: {
    sec: 'Envio',
    svc: { FCL: 'Contêiner completo (FCL)', ROAD: 'Rodoviário (caminhão)', AIR_ULD: 'Aéreo em ULD', LCL: 'Marítimo consolidado (LCL)', ROAD_LTL: 'Rodoviário consolidado (carga fracionada)', AIR_LOOSE: 'Aéreo — carga solta (paletes)', PALLETS_ONLY: 'Paletes (sem equipamento)', COURIER: 'Courier (DHL, FedEx…)' },
    maxH: 'Altura máx. do palete',
    pieces: 'Volumes',
    boxes: 'Caixas',
    volumetric: 'Peso volumétrico',
    chargeable: 'Peso taxável (estimativa)',
    note: 'Peso taxável estimado; o valor final é o informado pela transportadora/companhia aérea.',
    gross: 'Peso bruto',
  },
  es: {
    sec: 'Envío',
    svc: { FCL: 'Contenedor completo (FCL)', ROAD: 'Terrestre (camión)', AIR_ULD: 'Aéreo en ULD', LCL: 'Marítimo consolidado (LCL)', ROAD_LTL: 'Terrestre consolidado (carga fraccionada)', AIR_LOOSE: 'Aéreo — carga suelta (pallets)', PALLETS_ONLY: 'Pallets (sin equipo)', COURIER: 'Courier (DHL, FedEx…)' },
    maxH: 'Altura máx. del pallet',
    pieces: 'Bultos',
    boxes: 'Cajas',
    volumetric: 'Peso volumétrico',
    chargeable: 'Peso tasable (estimado)',
    note: 'Peso tasable estimado; el valor final es el informado por el transportista/aerolínea.',
    gross: 'Peso bruto',
  },
  en: {
    sec: 'Shipment',
    svc: { FCL: 'Full container (FCL)', ROAD: 'Road (truck)', AIR_ULD: 'Air in ULD', LCL: 'Sea consolidated (LCL)', ROAD_LTL: 'Road consolidated (LTL)', AIR_LOOSE: 'Air — loose cargo (pallets)', PALLETS_ONLY: 'Pallets (no equipment)', COURIER: 'Courier (DHL, FedEx…)' },
    maxH: 'Max. pallet height',
    pieces: 'Pieces',
    boxes: 'Boxes',
    volumetric: 'Volumetric weight',
    chargeable: 'Chargeable weight (estimate)',
    note: 'Estimated chargeable weight; the final figure is the one stated by the carrier/airline.',
    gross: 'Gross weight',
  },
}

export async function buildOrderPdf(d: OrderPdfData, images: Uint8Array[], brand: PdfBrand = { lang: 'pt' }): Promise<Uint8Array> {
  const t = pdfText(brand.lang)
  const pdf = await PDFDocument.create()
  pdf.setTitle(clean(`${t.orderTitle} — ${d.plan.name} V${d.plan.version}`))
  pdf.setAuthor(COMPANY.legalName)
  pdf.setCreator('Pacifil Export Load Planner')
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const status = t.status[d.plan.status] ?? d.plan.status
  const w = new Writer(pdf, font, bold, `${d.plan.name} V${d.plan.version} · ${t.generatedAt} ${d.generatedAt.toLocaleString(t.locale, { timeZone: PDF_TZ })}`, brand.lang)
  w.generatedBy = brand.generatedBy ?? null
  const nf = w.nf
  await w.useLogo(brand.logo)
  await w.useFlag(brand.flag, d.order.destination)

  w.header(t.orderTitle, `${d.plan.name} · ${t.version} V${d.plan.version} (${status})`, d.generatedAt.toLocaleDateString(t.locale, { timeZone: PDF_TZ }), d.company)

  w.section(t.secCustomer)
  w.pairs([
    [t.customer, d.customer.name],
    [t.orderRef, d.order.ref || '—'],
    [t.destination, countryNameIn(d.order.destination, brand.lang)],
    [t.incoterm, d.order.incoterm],
    [t.city, d.customer.city || '—'],
    [t.transportL, d.shipping && d.order.service && NOEQ[brand.lang].svc[d.order.service] ? NOEQ[brand.lang].svc[d.order.service] : t.mode[d.order.mode] ?? d.order.mode],
    ...(d.customer.taxId ? ([[t.taxId, d.customer.taxId]] as [string, string][]) : []),
    ...(d.order.originPlace ? ([[t.placeOrigin(d.order.mode), d.order.originPlace]] as [string, string][]) : []),
    ...(d.order.destinationPlace ? ([[t.placeDestination(d.order.mode), d.order.destinationPlace]] as [string, string][]) : []),
    ...(d.order.customerAddress ? ([[t.customerAddress, d.order.customerAddress]] as [string, string][]) : []),
  ])

  if (d.equipment) {
    w.section(t.secEquipment)
    w.pairs([
      [t.type, `${d.equipment.code} — ${d.equipment.name}`],
      [t.innerDims, `${d.equipment.innerMm} mm${d.equipment.lengthInformed ? ` (${t.lengthInformed})` : ''}`],
      [t.door, `${d.equipment.doorMm} mm`],
      [t.equipTare, `${nf(d.equipment.tareKg)} kg`],
      [t.maxPayload, d.equipment.payloadLimitKg != null ? `${nf(d.equipment.payloadLimitKg)} kg` : '—'],
      [t.maxGross, d.equipment.grossLimitKg != null ? `${nf(d.equipment.grossLimitKg)} kg` : '—'],
    ])
  } else if (d.shipping) {
    // envio sem equipamento: paletes/volumes, volume e pesos (taxável = estimativa)
    const x = NOEQ[brand.lang]
    const sh = d.shipping
    w.section(x.sec)
    w.pairs([
      [t.type, x.svc[sh.service] ?? sh.service],
      ...(sh.maxHeightMm != null ? ([[x.maxH, `${nf(sh.maxHeightMm)} mm`]] as [string, string][]) : []),
      [sh.service === 'COURIER' ? x.pieces : t.pallets, nf(sh.service === 'COURIER' ? sh.boxes : sh.pallets)],
      [x.boxes, nf(sh.boxes)],
      [t.volume, `${nf(sh.cbm, 2)} m³`],
      [x.gross, `${nf(sh.grossKg, 1)} kg`],
      ...(sh.courier ? ([[`${x.volumetric} (÷ ${nf(sh.courier.divisor)})`, `${nf(sh.courier.volKg, 1)} kg`]] as [string, string][]) : []),
      ...(sh.chargeableKg != null ? ([[x.chargeable, `${nf(sh.chargeableKg, 1)} kg`]] as [string, string][]) : []),
    ])
    if (sh.chargeableKg != null) {
      w.text(x.note, M, 7.5, { color: GREY })
      w.y -= 10
    }
  }

  // Imagens 3D (uma imagem danificada é ignorada: o PDF sai sem ela, nunca falha por isso)
  const embedded: PDFImage[] = []
  for (const bytes of images.slice(0, 2)) {
    try {
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50
      embedded.push(isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes))
    } catch {
      // imagem inválida: segue sem ela
    }
  }
  if (embedded.length) {
    w.section(t.secViews)
    const gap = 10
    const imgW = (A4.w - 2 * M - gap) / 2
    let maxH = 0
    for (const img of embedded) maxH = Math.max(maxH, (img.height / img.width) * imgW)
    w.ensure(maxH + 16)
    embedded.forEach((img, i) => {
      const h = (img.height / img.width) * imgW
      w.page.drawImage(img, { x: M + i * (imgW + gap), y: w.y - h, width: imgW, height: h })
      w.page.drawRectangle({ x: M + i * (imgW + gap), y: w.y - h, width: imgW, height: h, borderColor: LINE, borderWidth: 0.6 })
    })
    w.y -= maxH + 12
    w.text(t.viewsCaption, M, 7.5, { color: GREY })
    w.y -= 4
  }

  w.section(t.secProducts)
  const hasPrice = d.products.some((p) => p.unitPrice != null)
  // coluna do código na largura do maior código (72–120 pt); a descrição fica com o restante
  // código na largura do maior código (72–112 pt; acima disso quebra); números compactos; a descrição
  // fica com todo o restante da largura (textos longos quebram em linhas, nunca se sobrepõem)
  // selo da tecnologia (PACIFIL NXT) ao lado do código dos itens cuja família tem SELO no Catálogo
  const SEAL = 14
  const sealImgs = new Map<TechKey, PDFImage>()
  for (const key of new Set(d.products.flatMap((p) => (p.tech?.display === 'SEAL' ? [p.tech.key] : [])))) {
    const img = await w.image(brand.seals?.[key])
    if (img) sealImgs.set(key, img)
  }
  const sealOf = (p: OrderPdfData['products'][number]) => (p.tech?.display === 'SEAL' ? (sealImgs.get(p.tech.key) ?? null) : null)
  const codeW = Math.min(92, Math.max(72, ...d.products.map((p) => w.textWidth(p.sku, 8.5) + 8 + (sealOf(p) ? SEAL + 3 : 0))))
  const nums = [
    { title: t.boxes, w: 30, align: 'right' as const },
    { title: t.units, w: 46, align: 'right' as const },
    { title: t.netUnitKg, w: hasPrice ? 36 : 42, align: 'right' as const },
    { title: t.netKg, w: 48, align: 'right' as const },
    { title: t.packedKg, w: 52, align: 'right' as const },
    { title: t.grossKg, w: 48, align: 'right' as const },
    // preços: SEMPRE com 2 casas ("73,00") e a moeda no título; colunas largas o bastante para "100.000,00"
    ...(hasPrice ? [{ title: `${t.price} USD`, w: 50, align: 'right' as const }, { title: `${t.total} USD`, w: 60, align: 'right' as const }] : []),
  ]
  const money = (v: number) => nf(v, 2)
  const cols = [{ title: t.code, w: codeW }, { title: t.description, w: A4.w - 2 * M - codeW - nums.reduce((a, c) => a + c.w, 0) }, ...nums]
  const rows = d.products.map((p) => [
    p.sku,
    p.kitBoxes?.length ? `${p.name} — ${t.kitBoxes(p.kitBoxes)}` : p.name,
    nf(p.boxes),
    nf(p.units),
    // peso líquido (só produto) por unidade de venda
    p.units > 0 ? nf(p.netKg / p.units, 2) : '—',
    nf(p.netKg, 1),
    nf(p.packedKg, 1),
    nf(p.grossKg, 1),
    ...(hasPrice ? [p.unitPrice != null ? money(p.unitPrice) : '—', p.amount != null ? money(p.amount) : '—'] : []),
  ])
  const tt = d.totals
  rows.push([t.totalRow, '', nf(tt.boxes), nf(tt.units), '', nf(tt.netKg, 1), nf(tt.goodsGrossKg, 1), nf(tt.payloadKg, 1), ...(hasPrice ? ['', ''] : [])])
  w.table(cols, rows, true, { icons: d.products.map(sealOf), iconCol: 0, iconSize: SEAL })
  // legenda do selo: o que é a tecnologia (uma vez por tecnologia com selo nos itens)
  for (const [key, img] of sealImgs) {
    const tech = TECHNOLOGIES[key]
    w.highlightBox({ title: tech.title, text: tech.text[brand.lang], image: img, imageSize: 34, titleSize: 9.5, textSize: 7.5 })
  }

  if (d.pallets.length) {
    w.section(t.secPalletizing)
    w.table(
      [
        { title: t.palletAssembly, w: 260 },
        { title: t.quantity, w: 70, align: 'right' },
        { title: t.boxesPerPallet, w: 90, align: 'right' },
        { title: t.grossPerPallet, w: 95, align: 'right' },
      ],
      d.pallets.map((p) => [p.name, nf(p.count), p.fullBoxes != null ? t.partialOf(p.boxes, p.fullBoxes) : String(p.boxes), nf(p.grossKgEach, 1)]),
    )
  }

  w.section(t.secWeights)
  w.pairs([
    [t.pallets, nf(tt.pallets)],
    [t.looseBoxes, nf(tt.looseBoxes)],
    [t.netWeight, `${nf(tt.netKg, 1)} kg`],
    [t.goodsGross, `${nf(tt.goodsGrossKg, 1)} kg`],
    [t.palletTare, `${nf(tt.palletTareKg, 1)} kg`],
    ...(d.equipment
      ? ([
          [t.payload, `${nf(tt.payloadKg, 1)} kg${tt.payloadPct != null ? ` (${nf(tt.payloadPct, 1)}%)` : ''}`],
          [t.equipTare, `${nf(tt.equipmentTareKg)} kg`],
        ] as [string, string][])
      : []),
    [d.equipment ? t.grossTotal : NOEQ[brand.lang].gross, `${nf(tt.grossTotalKg, 1)} kg`],
    [t.volume, `${nf(tt.cbm, 2)} m³`],
    ...(d.equipment
      ? ([
          [t.occupancy, `${nf(tt.volumePct, 1)}% / ${nf(tt.floorPct, 1)}%`],
          [t.usedLength, `${nf(tt.usedLengthMm)} mm`],
        ] as [string, string][])
      : []),
  ])

  if (d.weight) {
    w.section(t.secWeightDist)
    const q = d.weight
    // FRENTE (motorista) × TRASEIRA (porta): números grandes e um medidor com a faixa recomendada
    const width = A4.w - 2 * M
    const RED = rgb(0.84, 0.15, 0.16), AMBER = rgb(0.7, 0.37, 0)
    const GREEN_T = rgb(0.165, 0.49, 0.31)
    const zoneColor = q.zone === 'front' ? RED : q.zone === 'rear' ? AMBER : GREEN_T
    w.ensure(118)
    const top = w.y
    w.text(t.wFront, M, 8, { bold: true, color: GREY })
    w.text(t.wRear, M, 8, { bold: true, color: GREY, align: 'right', width })
    w.y -= 17
    w.text(`${nf(q.north, 1)}%`, M, 16, { bold: true, color: q.zone === 'front' ? RED : undefined })
    w.text(`${nf(q.south, 1)}%`, M, 16, { bold: true, color: q.zone === 'rear' ? AMBER : q.zone === 'ideal' ? GREEN_T : undefined, align: 'right', width })
    // medidor: % na traseira de 45 a 55
    const gy = w.y - 18, gh = 10
    const X = (v: number) => M + ((Math.min(55, Math.max(45, v)) - 45) / 10) * width
    w.page.drawRectangle({ x: M, y: gy, width, height: gh, color: rgb(0.93, 0.945, 0.957) })
    w.page.drawRectangle({ x: M, y: gy, width: X(q.rearMin) - M, height: gh, color: rgb(0.97, 0.83, 0.83) })
    w.page.drawRectangle({ x: X(q.rearMin), y: gy, width: X(q.rearIdealMin) - X(q.rearMin), height: gh, color: rgb(0.86, 0.94, 0.9) })
    w.page.drawRectangle({ x: X(q.rearIdealMin), y: gy, width: X(q.rearMax) - X(q.rearIdealMin), height: gh, color: rgb(0.47, 0.78, 0.6) })
    w.page.drawRectangle({ x: X(q.rearMax), y: gy, width: M + width - X(q.rearMax), height: gh, color: rgb(0.96, 0.89, 0.72) })
    w.page.drawLine({ start: { x: X(50), y: gy - 3 }, end: { x: X(50), y: gy + gh + 3 }, thickness: 1, color: rgb(0.49, 0.23, 0.93), dashArray: [2, 2] })
    // marcador (triângulo) na posição atual
    const mx = X(q.south)
    w.page.drawSvgPath(`M ${mx - 5} ${-(gy + gh + 9)} L ${mx + 5} ${-(gy + gh + 9)} L ${mx} ${-(gy + gh + 1)} Z`, { x: 0, y: 0, color: zoneColor })
    w.y = gy - 10
    w.text(`< ${t.wScaleFront}`, M, 7, { color: GREY })
    w.text('50 / 50', X(50) - 12, 7, { color: GREY })
    w.text(`${t.wScaleRear} >`, M, 7, { color: GREY, align: 'right', width })
    w.y -= 13
    w.text(t.wZone[q.zone] ?? '', M, 8.5, { bold: true, color: zoneColor })
    w.y -= 12
    w.text(`${t.wLateral(nf(q.NO + q.SO, 1), nf(q.NE + q.SE, 1))}   ·   ${t.wQuads(nf(q.NE, 1), nf(q.NO, 1), nf(q.SE, 1), nf(q.SO, 1))}`, M, 8, { color: GREY })
    w.y -= 11
    w.text(t.wRule, M, 7, { color: GREY })
    w.y = Math.min(w.y, top - 110) - 4
  }

  w.section(t.secValue)
  const cur = Object.entries(d.value.totals)
  const pf = d.proforma
  const goods = d.value.totals.USD ?? null
  // produtos sem preço: o total é PARCIAL (nunca apresentado como total do pedido)
  const partial = d.value.missing.length ? ({ pt: ' (parcial — faltam preços)', es: ' (parcial — faltan precios)', en: ' (partial — prices missing)' } as const)[brand.lang] : ''
  if (pf && (pf.freightUsd || pf.insuranceUsd)) {
    // subtotal da mercadoria + frete + seguro = total geral (cada valor entra uma única vez)
    const tt2 = proformaTotals(goods, pf.freightUsd, pf.insuranceUsd)
    w.kvList([
      { label: t.goodsSubtotal, value: goods != null ? `USD ${nf(goods, 2)}` : t.noPrices, right: true },
      { label: t.freight, value: pf.freightUsd ? `USD ${nf(pf.freightUsd, 2)}` : '—', right: true },
      { label: t.insurance, value: pf.insuranceUsd ? `USD ${nf(pf.insuranceUsd, 2)}` : '—', right: true },
      { label: t.grandTotal + partial, value: tt2.totalUsd != null ? `USD ${nf(tt2.totalUsd, 2)}` : '—', right: true, bold: true },
    ])
  } else if (cur.length) w.pairs(cur.map(([c, v]) => [t.valueTotal(c) + partial, nf(v, 2)] as [string, string]))
  else w.pairs([[t.valueTotal('—').replace(' (—)', ''), t.noPrices]])
  const terms = paymentTermsText(pf?.paymentTerms, (brand.lang === 'es' || brand.lang === 'en' ? brand.lang : 'pt') as TermsLang)
  if (terms) w.kvList([{ label: t.paymentTerms, value: terms }])
  if (d.value.missing.length) {
    w.ensure(14)
    w.text(`${t.noPrice}: ${d.value.missing.join(', ')}`, M, 8, { bold: true, color: rgb(0.75, 0.1, 0.1) })
    w.y -= 12
  }

  const notes = [
    ...(d.flags.equipmentReference ? [t.noteEquipRef] : []),
    ...(d.flags.noNetSkus.length ? [t.noteNoNet(d.flags.noNetSkus.join(', '))] : []),
    ...(d.flags.notApproved ? [t.noteStatus(status)] : []),
  ]
  if (notes.length) {
    w.section(t.secNotes)
    for (const n of notes) {
      w.ensure(13)
      w.text(`• ${n}`, M, 8, { color: GREY })
      w.y -= 12
    }
  }
  const quote = [d.order.ref ? `${t.orderRef} ${d.order.ref}` : null, `${d.plan.name} V${d.plan.version}`, d.customer.name !== '—' ? d.customer.name : null].filter(Boolean).join(' · ')
  w.contactBox(quote)

  // FOTOS DO CARREGAMENTO (como a carga ficou), 2 por linha, com legenda e data. Fotos cortadas pelo limite
  // de tamanho: a nota "+N foto(s)…" sai mesmo se nenhuma coube (aí sem página nova, só a seção com a nota)
  const photos = brand.photos ?? []
  if (photos.length || brand.photosOmitted) {
    if (photos.length) w.newPage()
    w.section(t.secPhotos)
    const gap = 10
    const imgW = (A4.w - 2 * M - gap) / 2
    for (let i = 0; i < photos.length; i += 2) {
      const pair = photos.slice(i, i + 2)
      const emb = []
      for (const ph of pair) {
        try {
          emb.push(ph.bytes[0] === 0x89 && ph.bytes[1] === 0x50 ? await pdf.embedPng(ph.bytes) : await pdf.embedJpg(ph.bytes))
        } catch {
          emb.push(null)
        }
      }
      const hs = emb.map((im) => (im ? Math.min((im.height / im.width) * imgW, 300) : 0))
      const h = Math.max(...hs, 20)
      // legendas com quebra de linha dentro da coluna (no máx. 3 linhas)
      const labels = pair.map((ph) => w.wrap([ph.caption, ph.date ? ph.date.toLocaleString(t.locale, { dateStyle: 'short', timeStyle: 'short', timeZone: PDF_TZ }) : null].filter(Boolean).join(' · '), imgW - 2, 8).slice(0, 3))
      const capH = Math.max(...labels.map((l) => l.length), 1) * 10
      w.ensure(h + 16 + capH)
      emb.forEach((im, k) => {
        if (!im) return
        const iw = (im.width / im.height) * hs[k]
        w.page.drawImage(im, { x: M + k * (imgW + gap) + (imgW - iw) / 2, y: w.y - hs[k], width: iw, height: hs[k] })
      })
      w.y -= h + 10
      const y0 = w.y
      labels.forEach((ls, k) =>
        ls.forEach((l, j) => {
          w.y = y0 - j * 10
          w.text(l, M + k * (imgW + gap), 8, { color: GREY })
        }),
      )
      w.y = y0 - capH - 6
    }
    if (brand.photosOmitted) {
      w.ensure(14)
      w.text(t.photosOmitted(brand.photosOmitted), M, 8, { color: GREY })
      w.y -= 12
    }
  }
  w.finish(quote)
  return pdf.save()
}
