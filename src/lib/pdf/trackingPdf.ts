/**
 * PDF "STATUS DO EMBARQUE" para o CLIENTE (pdf-lib, puro JS): etapa atual, rota e datas, dados do embarque,
 * contêineres e produtos de uma ou mais cargas do mesmo pedido, com uma mensagem opcional no início.
 * Conteúdo = TrackingSummary (DTO seguro montado por trackingSummaryDto em src/domain/exportTracking.ts —
 * nada interno chega aqui); este módulo só faz o layout e os textos (es/pt/en). Cabeçalho com logo e rodapé
 * (endereço, contato, Instagram, "gerado por") do Writer do PDF do pedido.
 */
import { PDFDocument, PDFFont, rgb, StandardFonts } from 'pdf-lib'
import { EXPORT_PIPELINE, EXPORT_STATUS_LABEL, ExportStatus, sameForAllUnits, SUMMARY_SECTIONS, SummaryEquipment, SummarySection, SummaryUnit, todayBR, TrackingSummary } from '@/domain/exportTracking'
import type { ShipmentService } from '@/domain/shipmentType'
import { countryNameIn } from '@/lib/countries'
import { COMPANY, PdfLang, pdfText, PdfText, PDF_TZ } from './i18n'
import { A4, clean, GREEN, GREEN_DARK, GREY, LINE, M, Writer } from './orderPdf'

type Mode = 'SEA' | 'ROAD' | 'AIR'
/** como chamar cada carga: contêiner (marítimo), caminhão (rodoviário) ou unidade (aéreo, só paletes, courier) */
type UnitKind = 'container' | 'truck' | 'unit'

interface SummaryText {
  title: string
  asOf: (date: string) => string
  message: string
  secOrder: string
  secStatus: string
  secRoute: string
  secShipping: string
  secContainers: Record<UnitKind, string>
  secProducts: string
  orderRef: string
  customer: string
  destination: string
  unit: Record<UnitKind, string>
  equipment: string
  number: Record<UnitKind, string>
  seal: string
  carrier: Record<Mode, string>
  forwarder: string
  booking: string
  document: Record<Mode, string>
  vessel: Record<Mode, string>
  voyage: string
  etd: string
  atd: string
  transit: string
  eta: string
  ata: string
  delivered: string
  days: (n: number) => string
  /** rótulos das etapas para o cliente */
  status: Record<ExportStatus, string>
  stepOf: (i: number, n: number) => string
  code: string
  description: string
  boxes: string
  units: string
  netKg: string
  grossKg: string
  total: string
  pallets: string
  /** "22 pallets" / "1 pallet" (rótulo da carga nos produtos) */
  palletCount: (n: number, s: string) => string
  packages: string
  netWeight: string
  grossWeight: string
  orderTotal: string
  noProducts: string
  /** envio sem equipamento */
  service: Record<string, string>
  /** rodapé: mensagem pronta do WhatsApp e assunto do e-mail falando do embarque (não de cotação) */
  waMessage: (q: string) => string
  mailSubject: (q: string) => string
}

const es: SummaryText = {
  title: 'ESTADO DEL EMBARQUE',
  asOf: (d) => `Situación al ${d}`,
  message: 'Mensaje',
  secOrder: 'Pedido',
  secStatus: 'Etapa actual',
  secRoute: 'Ruta y fechas',
  secShipping: 'Embarque',
  secContainers: { container: 'Contenedores', truck: 'Camiones', unit: 'Unidades' },
  secProducts: 'Productos',
  orderRef: 'Pedido / referencia',
  customer: 'Cliente',
  destination: 'País de destino',
  unit: { container: 'Contenedor', truck: 'Camión', unit: 'Unidad' },
  equipment: 'Tipo de equipo',
  number: { container: 'N.º de contenedor', truck: 'Patente / matrícula', unit: 'Identificación' },
  seal: 'Precinto',
  carrier: { SEA: 'Naviera', ROAD: 'Transportista', AIR: 'Aerolínea' },
  forwarder: 'Agente de carga',
  booking: 'Booking',
  document: { SEA: 'BL', ROAD: 'CRT / carta de porte', AIR: 'AWB (guía aérea)' },
  vessel: { SEA: 'Buque', ROAD: 'Vehículo', AIR: 'Vuelo' },
  voyage: 'Viaje',
  etd: 'Salida prevista (ETD)',
  atd: 'Salida real',
  transit: 'Tránsito estimado',
  eta: 'Llegada prevista (ETA)',
  ata: 'Llegada real',
  delivered: 'Entrega al cliente',
  days: (n) => (n === 1 ? '1 día' : `${n} días`),
  status: {
    CONFIRMED: 'Pedido confirmado',
    IN_PRODUCTION: 'En producción',
    LOADING_SCHEDULED: 'Carga programada',
    LOADED: 'Cargado',
    IN_TRANSIT: 'En tránsito',
    ARRIVED: 'Llegó a destino',
    FINISHED: 'Finalizado',
    CANCELLED: 'Cancelado',
  },
  stepOf: (i, n) => `etapa ${i} de ${n}`,
  code: 'Código',
  description: 'Descripción',
  boxes: 'Cajas',
  units: 'Unidades',
  netKg: 'Neto kg',
  grossKg: 'Bruto kg',
  total: 'TOTAL',
  pallets: 'Pallets',
  palletCount: (n, s) => (n === 1 ? '1 pallet' : `${s} pallets`),
  packages: 'Cajas',
  netWeight: 'Peso neto',
  grossWeight: 'Peso bruto (con pallets)',
  orderTotal: 'Total del pedido',
  noProducts: 'Sin productos registrados.',
  service: { LCL: 'Marítimo consolidado (LCL)', ROAD_LTL: 'Terrestre consolidado (carga fraccionada)', AIR_LOOSE: 'Aéreo — carga suelta (pallets)', PALLETS_ONLY: 'Pallets (sin equipo)', COURIER: 'Courier (DHL, FedEx…)' },
  waMessage: (q) => `¡Hola! Quisiera consultar sobre el embarque${q ? ` "${q}"` : ''}.`,
  mailSubject: (q) => `Embarque${q ? ` ${q}` : ''}`,
}

const pt: SummaryText = {
  title: 'STATUS DO EMBARQUE',
  asOf: (d) => `Situação em ${d}`,
  message: 'Mensagem',
  secOrder: 'Pedido',
  secStatus: 'Etapa atual',
  secRoute: 'Rota e datas',
  secShipping: 'Embarque',
  secContainers: { container: 'Contêineres', truck: 'Caminhões', unit: 'Unidades' },
  secProducts: 'Produtos',
  orderRef: 'Pedido / referência',
  customer: 'Cliente',
  destination: 'País de destino',
  unit: { container: 'Contêiner', truck: 'Caminhão', unit: 'Unidade' },
  equipment: 'Tipo de equipamento',
  number: { container: 'Nº do contêiner', truck: 'Placa', unit: 'Identificação' },
  seal: 'Lacre',
  carrier: { SEA: 'Armador', ROAD: 'Transportadora', AIR: 'Companhia aérea' },
  forwarder: 'Agente de carga',
  booking: 'Booking',
  document: { SEA: 'BL', ROAD: 'CRT / conhecimento', AIR: 'AWB (conhecimento aéreo)' },
  vessel: { SEA: 'Navio', ROAD: 'Veículo', AIR: 'Voo' },
  voyage: 'Viagem',
  etd: 'Saída prevista (ETD)',
  atd: 'Saída real',
  transit: 'Trânsito estimado',
  eta: 'Chegada prevista (ETA)',
  ata: 'Chegada real',
  delivered: 'Entrega ao cliente',
  days: (n) => (n === 1 ? '1 dia' : `${n} dias`),
  status: EXPORT_STATUS_LABEL,
  stepOf: (i, n) => `etapa ${i} de ${n}`,
  code: 'Código',
  description: 'Descrição',
  boxes: 'Caixas',
  units: 'Unidades',
  netKg: 'Líquido kg',
  grossKg: 'Bruto kg',
  total: 'TOTAL',
  pallets: 'Paletes',
  palletCount: (n, s) => (n === 1 ? '1 palete' : `${s} paletes`),
  packages: 'Caixas',
  netWeight: 'Peso líquido',
  grossWeight: 'Peso bruto (c/ paletes)',
  orderTotal: 'Total do pedido',
  noProducts: 'Sem produtos registrados.',
  service: { LCL: 'Marítimo consolidado (LCL)', ROAD_LTL: 'Rodoviário consolidado (carga fracionada)', AIR_LOOSE: 'Aéreo — carga solta (paletes)', PALLETS_ONLY: 'Paletes (sem equipamento)', COURIER: 'Courier (DHL, FedEx…)' },
  waMessage: (q) => `Olá! Gostaria de falar sobre o embarque${q ? ` "${q}"` : ''}.`,
  mailSubject: (q) => `Embarque${q ? ` ${q}` : ''}`,
}

const en: SummaryText = {
  title: 'SHIPMENT STATUS',
  asOf: (d) => `Status as of ${d}`,
  message: 'Message',
  secOrder: 'Order',
  secStatus: 'Current stage',
  secRoute: 'Route and dates',
  secShipping: 'Shipment',
  secContainers: { container: 'Containers', truck: 'Trucks', unit: 'Units' },
  secProducts: 'Products',
  orderRef: 'Order / reference',
  customer: 'Customer',
  destination: 'Destination country',
  unit: { container: 'Container', truck: 'Truck', unit: 'Unit' },
  equipment: 'Equipment type',
  number: { container: 'Container no.', truck: 'Plate no.', unit: 'ID no.' },
  seal: 'Seal',
  carrier: { SEA: 'Shipping line', ROAD: 'Carrier', AIR: 'Airline' },
  forwarder: 'Freight forwarder',
  booking: 'Booking',
  document: { SEA: 'Bill of lading (BL)', ROAD: 'CRT / waybill', AIR: 'Air waybill (AWB)' },
  vessel: { SEA: 'Vessel', ROAD: 'Vehicle', AIR: 'Flight' },
  voyage: 'Voyage',
  etd: 'Departure (ETD)',
  atd: 'Actual departure',
  transit: 'Estimated transit',
  eta: 'Arrival (ETA)',
  ata: 'Actual arrival',
  delivered: 'Delivered',
  days: (n) => (n === 1 ? '1 day' : `${n} days`),
  status: {
    CONFIRMED: 'Order confirmed',
    IN_PRODUCTION: 'In production',
    LOADING_SCHEDULED: 'Loading scheduled',
    LOADED: 'Loaded',
    IN_TRANSIT: 'In transit',
    ARRIVED: 'Arrived',
    FINISHED: 'Completed',
    CANCELLED: 'Cancelled',
  },
  stepOf: (i, n) => `stage ${i} of ${n}`,
  code: 'Code',
  description: 'Description',
  boxes: 'Boxes',
  units: 'Units',
  netKg: 'Net kg',
  grossKg: 'Gross kg',
  total: 'TOTAL',
  pallets: 'Pallets',
  palletCount: (n, s) => (n === 1 ? '1 pallet' : `${s} pallets`),
  packages: 'Boxes',
  netWeight: 'Net weight',
  grossWeight: 'Gross weight (incl. pallets)',
  orderTotal: 'Order total',
  noProducts: 'No products recorded.',
  service: { LCL: 'Sea consolidated (LCL)', ROAD_LTL: 'Road consolidated (LTL)', AIR_LOOSE: 'Air — loose cargo (pallets)', PALLETS_ONLY: 'Pallets (no equipment)', COURIER: 'Courier (DHL, FedEx…)' },
  waMessage: (q) => `Hello! I would like to talk about the shipment${q ? ` "${q}"` : ''}.`,
  mailSubject: (q) => `Shipment${q ? ` ${q}` : ''}`,
}

const TXT: Record<PdfLang, SummaryText> = { es, pt, en }

/** nome do idioma (histórico: "Resumo para o cliente gerado (Español)") */
export const SUMMARY_LANG_NAME: Record<PdfLang, string> = { es: 'Español', pt: 'Português', en: 'English' }

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * Dia civil 'YYYY-MM-DD' no idioma do PDF, sem passar por Date (nada de fuso): es/pt '25/10/2026',
 * en '25 Oct 2026'; vazio/inválido = '—'.
 */
export function fmtSummaryDate(d: string | null | undefined, lang: PdfLang): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d ?? '')
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return '—'
  return lang === 'en' ? `${Number(m[3])} ${MONTHS_EN[Number(m[2]) - 1]} ${m[1]}` : `${m[3]}/${m[2]}/${m[1]}`
}

const unitKind = (s: ShipmentService): UnitKind => (s === 'FCL' || s === 'LCL' ? 'container' : s === 'ROAD' || s === 'ROAD_LTL' ? 'truck' : 'unit')

const WHITE = rgb(1, 1, 1)
const DONE_BG = rgb(0.86, 0.94, 0.9)
const RED = rgb(0.75, 0.1, 0.1)
/** alturas: título de seção (Writer.section: 14 + 5 + 12) e rótulo de uma carga (sub: 2 + 13) */
const SECTION_H = 31
const SUB_H = 15

/** Writer cujo rodapé (link do WhatsApp e assunto do e-mail) fala do embarque, não de uma cotação */
class SummaryWriter extends Writer {
  declare readonly t: PdfText
  constructor(pdf: PDFDocument, font: PDFFont, bold: PDFFont, footer: string, lang: PdfLang, x: SummaryText) {
    super(pdf, font, bold, footer, lang)
    this.t = { ...pdfText(lang), waMessage: x.waMessage, mailSubject: x.mailSubject }
  }
}

/** corta o texto (com "…") para caber na largura */
function fit(w: Writer, s: string, max: number, size: number): string {
  if (w.textWidth(s, size) <= max) return s
  let r = s
  while (r.length > 1 && w.textWidth(`${r}…`, size) > max) r = r.slice(0, -1)
  return `${r.trimEnd()}…`
}

export interface TrackingPdfOptions {
  lang: PdfLang
  /** PNG do logo (sem ele o cabeçalho usa o nome da empresa) */
  logo?: Uint8Array | null
  /** PNG da bandeira do país de destino (opcional) */
  flag?: Uint8Array | null
  /** seções escolhidas no diálogo (o PDF segue a ordem de SUMMARY_SECTIONS) */
  sections: readonly SummarySection[]
  /** "Mensagem ao cliente": quadro destacado no início (quebras de linha = parágrafos); vazio = sem quadro */
  message?: string | null
  /** quem gerou (rodapé discreto) */
  generatedBy?: string | null
  /** instante da geração (padrão: agora) */
  now?: Date
}

/** Gera o PDF do resumo para o cliente. Sem nenhuma seção marcada sai só o cabeçalho (e a mensagem). */
export async function buildTrackingSummaryPdf(d: TrackingSummary, o: TrackingPdfOptions): Promise<Uint8Array> {
  const lang = o.lang
  const x = TXT[lang] ?? pt
  const t = pdfText(lang)
  const now = o.now ?? new Date()
  const cancelled = (u: SummaryUnit) => u.status === 'CANCELLED'
  // cargas em curso (todas canceladas: todas): nelas se decide o que é igual para todas (uma vez só) e o que
  // vai por carga em rota/embarque — os dados da cancelada param no tempo e não podem separar os das outras
  const live = d.units.some((u) => !cancelled(u)) ? d.units.filter((u) => !cancelled(u)) : d.units
  const quote = d.orderRef ?? live.flatMap((u) => (u.containerNumber ? [u.containerNumber] : [])).join(', ')

  const pdf = await PDFDocument.create()
  pdf.setTitle(clean(`${x.title}${quote ? ` — ${quote}` : ''}`))
  pdf.setAuthor(COMPANY.legalName)
  pdf.setCreator('Pacifil Export Load Planner')
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const footer = [quote, `${t.generatedAt} ${now.toLocaleString(t.locale, { timeZone: PDF_TZ })}`].filter(Boolean).join(' · ')
  const w = new SummaryWriter(pdf, font, bold, footer, lang, x)
  w.generatedBy = o.generatedBy?.trim() || null
  const nf = w.nf
  const kg = (v: number) => `${nf(v, 1)} kg`
  const fd = (v: string | null) => fmtSummaryDate(v, lang)
  const country = countryNameIn(d.country, lang) || d.country
  await w.useLogo(o.logo)
  await w.useFlag(o.flag, country)

  const subtitle = [d.orderRef, d.customer !== '—' ? d.customer : null].filter(Boolean).join(' · ')
  w.header(x.title, fit(w, subtitle || x.title, 330, 9), x.asOf(fd(todayBR(now))), 'Pacifil Brasil')

  const msg = (o.message ?? '').trim()
  if (msg) w.highlightBox({ title: x.message, text: msg, titleSize: 9.5, textSize: 9 })

  const kind = unitKind(d.service)
  const mode: Mode = d.placeMode
  const multi = d.units.length > 1
  /** "Contenedor 3": número = posição da carga NO PEDIDO (unitIndex, como na plataforma), não no resumo */
  const unitName = (u: SummaryUnit) => (multi ? `${x.unit[kind]} ${u.unitIndex}` : x.unit[kind])
  const unitTitle = (u: SummaryUnit) => [unitName(u), u.containerNumber].filter(Boolean).join(' · ')
  /** célula da carga nas tabelas por carga: "Contenedor 1 (MSCU…)" */
  const unitCell = (u: SummaryUnit) => `${unitName(u)}${u.containerNumber ? ` (${u.containerNumber})` : ''}`
  /** altura que w.table vai ocupar (mesma conta do Writer: cabeçalho 7,5 pt, linhas 8,5 pt, células quebradas) */
  const tableHeight = (cols: { title: string; w: number }[], rows: string[][], boldLast = false) => {
    const rowH = (cells: string[], size: number, b: boolean) => 14 + (Math.max(1, ...cells.map((c, k) => w.wrap(c ?? '', cols[k].w - 6, size, b).length)) - 1) * (size + 2)
    return rowH(cols.map((c) => c.title), 7.5, true) + rows.reduce((a, r, i) => a + rowH(r, 8.5, boldLast && i === rows.length - 1), 0)
  }
  /** espaço que keepTable reserva (tabela muito longa: só o começo; o resto quebra de página normalmente) */
  const keepHeight = (cols: { title: string; w: number }[], rows: string[][]) => Math.min(tableHeight(cols, rows), 320)
  /** tabela curta (uma linha por carga) inteira na mesma página — sem a última linha sozinha na página seguinte */
  const keepTable = (cols: { title: string; w: number }[], rows: string[][]) => {
    w.ensure(keepHeight(cols, rows))
    w.table(cols, rows)
  }
  /**
   * Título da seção JUNTO com o primeiro bloco dela (`first` = o que esse bloco reserva com ensure): o título
   * nunca fica sozinho no pé da página. Mínimo de 80 pt (título + uma ou duas linhas).
   */
  const head = (title: string, first = 0) => {
    w.ensure(Math.max(80, SECTION_H + first))
    w.section(title)
  }
  /**
   * Campos iguais em todas as cargas EM CURSO: uma vez só (pares rótulo/valor, depois de `lead`); os que
   * variam: numa tabela com uma linha por carga em curso. As canceladas ficam de fora daqui (os dados delas
   * param de ser atualizados) — a etapa, os contêineres e os produtos as mostram marcadas.
   */
  const sharedOrPerUnit = (title: string, fields: { label: string; value: (u: SummaryUnit) => string }[], lead: [string, string][] = []) => {
    const diff = fields.filter((f) => !sameForAllUnits(live, f.value))
    const pairs: [string, string][] = [...lead, ...fields.filter((f) => !diff.includes(f)).map((f): [string, string] => [f.label, f.value(live[0])])]
    const first = 130
    const cw = diff.length ? (A4.w - 2 * M - first) / diff.length : 0
    const cols = [{ title: x.unit[kind], w: first }, ...diff.map((f) => ({ title: f.label, w: cw }))]
    const rows = live.map((u) => [unitCell(u), ...diff.map((f) => f.value(u))])
    // primeiro bloco: os pares ou, sem pares, a tabela inteira
    head(title, pairs.length || !diff.length ? 0 : keepHeight(cols, rows))
    if (pairs.length) w.pairs(pairs)
    if (!diff.length) return
    if (pairs.length) w.y -= 4
    keepTable(cols, rows)
  }
  const equipmentLabel = (e: SummaryEquipment | null) => {
    if (!e) return '—'
    if (e.service) return x.service[e.service] ?? e.service
    return e.name && e.name !== e.code ? `${e.code} — ${e.name}` : e.code || '—'
  }
  /** rótulo de uma carga antes do bloco dela (quando os dados variam por carga); ocupa SUB_H */
  const sub = (label: string, need = 44) => {
    w.ensure(need)
    w.y -= 2
    w.text(label, M, 8.5, { bold: true, color: GREEN_DARK })
    w.y -= 13
  }

  // as 7 etapas em quadros (mesmo tamanho para qualquer etapa: os rótulos não dependem da atual)
  const pipeN = EXPORT_PIPELINE.length
  const pipeGap = 4
  const pipeBw = (A4.w - 2 * M - pipeGap * (pipeN - 1)) / pipeN
  const pipeSize = 7.5
  const pipeLead = pipeSize + 1.5
  const pipeLabels = EXPORT_PIPELINE.map((s, i) => w.wrap(`${i + 1}. ${x.status[s]}`, pipeBw - 8, pipeSize, true))
  const pipeH = Math.max(...pipeLabels.map((l) => l.length)) * pipeLead + 12
  /** o que pipeline(status) reserva com ensure */
  const pipelineHeight = (status: ExportStatus) => (status === 'CANCELLED' ? 18 : pipeH + 28)
  /** as 7 etapas em quadros (a atual em verde; as anteriores marcadas); cancelado = só o texto */
  const pipeline = (status: ExportStatus) => {
    w.ensure(pipelineHeight(status))
    if (status === 'CANCELLED') {
      w.text(x.status.CANCELLED, M, 10, { bold: true, color: RED })
      w.y -= 16
      return
    }
    const cur = EXPORT_PIPELINE.indexOf(status)
    const top = w.y + 6
    EXPORT_PIPELINE.forEach((s, i) => {
      const bx = M + i * (pipeBw + pipeGap)
      const current = i === cur
      const done = i < cur
      w.page.drawRectangle({ x: bx, y: top - pipeH, width: pipeBw, height: pipeH, color: current ? GREEN : done ? DONE_BG : WHITE, borderColor: current || done ? GREEN : LINE, borderWidth: current ? 1 : 0.6 })
      const lines = pipeLabels[i]
      const blockTop = top - (pipeH - lines.length * pipeLead) / 2
      lines.forEach((l, j) => {
        w.y = blockTop - pipeSize * 0.85 - j * pipeLead
        w.text(l, bx + (pipeBw - w.textWidth(l, pipeSize, true)) / 2, pipeSize, { bold: true, color: current ? WHITE : done ? GREEN_DARK : GREY })
      })
    })
    w.y = top - pipeH - 14
    w.text(`${x.status[status]} — ${x.stepOf(cur + 1, pipeN)}`, M, 9.5, { bold: true, color: GREEN_DARK })
    w.y -= 14
  }

  const draw: Record<SummarySection, () => void> = {
    order: () => {
      head(x.secOrder)
      w.pairs([
        [x.orderRef, d.orderRef ?? '—'],
        [x.customer, d.customer],
        [x.destination, country],
      ])
    },

    status: () => {
      if (sameForAllUnits(d.units, (u) => u.status)) {
        head(x.secStatus, pipelineHeight(d.units[0].status))
        pipeline(d.units[0].status)
        return
      }
      // etapas diferentes (inclusive uma cancelada): um bloco por carga, com o rótulo dela
      head(x.secStatus, SUB_H + pipelineHeight(d.units[0].status))
      d.units.forEach((u) => {
        sub(unitTitle(u), SUB_H + pipelineHeight(u.status))
        pipeline(u.status)
      })
    },

    route: () => {
      // origem/destino são do pedido; as datas podem variar por carga
      const dates: { label: string; value: (u: SummaryUnit) => string }[] = [
        { label: x.etd, value: (u) => fd(u.dates.etd) },
        { label: x.eta, value: (u) => fd(u.dates.eta) },
        { label: x.atd, value: (u) => fd(u.dates.atd) },
        { label: x.ata, value: (u) => fd(u.dates.ata) },
        { label: x.transit, value: (u) => (u.dates.transitDays != null ? x.days(u.dates.transitDays) : '—') },
        // entrega: só quando informada
        ...(live.some((u) => u.dates.deliveredAt) ? [{ label: x.delivered, value: (u: SummaryUnit) => fd(u.dates.deliveredAt) }] : []),
      ]
      sharedOrPerUnit(x.secRoute, dates, [
        [t.placeOrigin(mode), d.originPlace ?? '—'],
        [t.placeDestination(mode), d.destinationPlace ?? '—'],
      ])
    },

    shipping: () => {
      const v = (s: string | null) => s ?? '—'
      sharedOrPerUnit(x.secShipping, [
        { label: x.carrier[mode], value: (u) => v(u.shipping.carrier) },
        { label: x.forwarder, value: (u) => v(u.shipping.forwarder) },
        { label: x.booking, value: (u) => v(u.shipping.bookingNumber) },
        { label: x.document[mode], value: (u) => v(u.shipping.blNumber) },
        { label: x.vessel[mode], value: (u) => v(u.shipping.vessel) },
        { label: x.voyage, value: (u) => v(u.shipping.voyage) },
      ])
    },

    containers: () => {
      // coluna da carga com várias cargas ou com uma cancelada (marcada ali); uma carga só, em curso: sem ela
      const unitCol = multi || d.units.some(cancelled)
      const first = unitCol ? 110 : 0
      const cols = [
        { title: x.equipment, w: (A4.w - 2 * M - first) * 0.42 },
        { title: x.number[kind], w: (A4.w - 2 * M - first) * 0.32 },
        { title: x.seal, w: (A4.w - 2 * M - first) * 0.26 },
      ]
      const rows = d.units.map((u) => [equipmentLabel(u.equipment), u.containerNumber ?? '—', u.sealNumber ?? '—'])
      if (!unitCol) {
        head(x.secContainers[kind], tableHeight(cols, rows))
        w.table(cols, rows)
        return
      }
      const ucols = [{ title: x.unit[kind], w: first }, ...cols]
      const urows = d.units.map((u, i) => [cancelled(u) ? `${unitName(u)} · ${x.status.CANCELLED}` : unitName(u), ...rows[i]])
      head(x.secContainers[kind], keepHeight(ucols, urows))
      keepTable(ucols, urows)
    },

    products: () => {
      const totalsPairs = (tt: { pallets: number; packages: number; netKg: number; grossKg: number }): [string, string][] => [
        [x.pallets, nf(tt.pallets)],
        [x.packages, nf(tt.packages)],
        [x.netWeight, kg(tt.netKg)],
        [x.grossWeight, kg(tt.grossKg)],
      ]
      // mesmas colunas em todas as cargas (tabelas alinhadas umas com as outras)
      const codeW = Math.min(92, Math.max(72, ...d.units.flatMap((u) => u.products.map((p) => w.textWidth(p.sku, 8.5) + 8))))
      const nums = [
        { title: x.boxes, w: 44, align: 'right' as const },
        { title: x.units, w: 54, align: 'right' as const },
        { title: x.netKg, w: 64, align: 'right' as const },
        { title: x.grossKg, w: 64, align: 'right' as const },
      ]
      const cols = [{ title: x.code, w: codeW }, { title: x.description, w: A4.w - 2 * M - codeW - nums.reduce((a, c) => a + c.w, 0) }, ...nums]
      const rowsOf = (u: SummaryUnit) => {
        const rows = u.products.map((p) => [p.sku, p.kitBoxes?.length ? `${p.name} — ${t.kitBoxes(p.kitBoxes)}` : p.name, nf(p.boxes), nf(p.units), nf(p.netKg, 1), nf(p.grossKg, 1)])
        if (u.totals) rows.push([x.total, '', nf(u.totals.packages), nf(u.totals.units), nf(u.totals.netKg, 1), nf(u.totals.grossKg, 1)])
        return rows
      }
      /** cabeçalho + 1ª linha da tabela da carga (ou a linha "sem produtos") */
      const firstRows = (u: SummaryUnit, rows: string[][]) => (u.products.length ? tableHeight(cols, rows.slice(0, 1)) : 14)
      head(x.secProducts, (multi ? SUB_H : 0) + firstRows(d.units[0], rowsOf(d.units[0])))
      d.units.forEach((u, i) => {
        const rows = rowsOf(u)
        if (multi) {
          // respiro entre a tabela da carga anterior e o rótulo desta; rótulo + cabeçalho + 1ª linha juntos
          if (i > 0) w.y -= 6
          const note = cancelled(u) ? x.status.CANCELLED : u.totals ? x.palletCount(u.totals.pallets, nf(u.totals.pallets)) : null
          sub([unitTitle(u), note].filter(Boolean).join(' · '), SUB_H + firstRows(u, rows))
        }
        if (!u.products.length) {
          w.ensure(14)
          w.text(x.noProducts, M, 8.5, { color: GREY })
          w.y -= 14
          return
        }
        w.table(cols, rows, Boolean(u.totals))
        if (!multi && u.totals) w.pairs(totalsPairs(u.totals))
      })
      // várias cargas: total do pedido (soma das cargas do resumo; as canceladas não entram)
      const withTotals = d.units.flatMap((u) => (u.totals && !cancelled(u) ? [u.totals] : []))
      if (multi && withTotals.length) {
        const sum = withTotals.reduce((a, tt) => ({ pallets: a.pallets + tt.pallets, packages: a.packages + tt.packages, netKg: a.netKg + tt.netKg, grossKg: a.grossKg + tt.grossKg }), { pallets: 0, packages: 0, netKg: 0, grossKg: 0 })
        w.y -= 6
        sub(x.orderTotal, 60)
        w.pairs(totalsPairs(sum))
      }
    },
  }

  const chosen = new Set(o.sections)
  for (const s of SUMMARY_SECTIONS) {
    if (!chosen.has(s)) continue
    // sem nenhuma carga (não acontece: a operação pedida sempre entra) só o pedido faz sentido
    if (!d.units.length && s !== 'order') continue
    // cada seção abre com head(): o título vai junto com o primeiro bloco (nunca sozinho no pé da página)
    draw[s]()
  }

  w.finish(quote)
  return pdf.save()
}
