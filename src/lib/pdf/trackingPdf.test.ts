import { inflateSync } from 'node:zlib'
import { PDFArray, PDFDocument, PDFRawStream } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { SUMMARY_SECTIONS, SummarySection, SummaryUnit, TrackingSummary } from '@/domain/exportTracking'
import { buildTrackingSummaryPdf, fmtSummaryDate } from './trackingPdf'

const hexText = (s: string) => s.replace(/<([0-9A-Fa-f]+)>/g, (_, h: string) => Buffer.from(h, 'hex').toString('latin1'))

/** texto desenhado em CADA página (content streams da página, descomprimidos e decodificados) */
async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes)
  return doc.getPages().map((p) => {
    const c = p.node.Contents()
    const parts = c instanceof PDFArray ? c.asArray().map((r) => doc.context.lookup(r)) : [c]
    return parts
      .map((s) => {
        if (!(s instanceof PDFRawStream)) return ''
        try {
          return hexText(inflateSync(s.contents).toString('latin1'))
        } catch {
          return hexText(Buffer.from(s.contents).toString('latin1'))
        }
      })
      .join('\n')
  })
}
/** o texto `s` desenhado sozinho (um Tj só: título de seção, rótulo…), não como parte de outro texto */
const drawnAlone = (page: string, s: string) => page.split('\n').some((l) => l.trim() === `${s} Tj`)

/** texto desenhado no PDF: descomprime os content streams e decodifica as strings hex (<...> Tj) em WinAnsi/Latin-1 */
function drawnText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes)
  const out: string[] = []
  let i = 0
  for (;;) {
    const a = raw.indexOf('stream', i, 'latin1')
    if (a < 0) break
    let start = a + 6
    if (raw[start] === 0x0d) start++
    if (raw[start] === 0x0a) start++
    const end = raw.indexOf('endstream', start, 'latin1')
    if (end < 0) break
    try {
      out.push(inflateSync(raw.subarray(start, end)).toString('latin1'))
    } catch {
      // stream não comprimido (imagem etc.)
    }
    i = end + 9
  }
  return hexText(out.join('\n'))
}

const unit = (i: number, extra: Partial<SummaryUnit> = {}): SummaryUnit => ({
  unitIndex: i,
  status: 'IN_TRANSIT',
  equipment: { code: '40HC', name: "40' High Cube", service: null },
  containerNumber: `MSCU123456${i}`,
  sealNumber: `SEAL-${i}`,
  shipping: { carrier: 'Maersk', forwarder: 'Fwd Uno', bookingNumber: 'BK-777', blNumber: 'BL-888', vessel: 'MSC Ana', voyage: '123E' },
  dates: { etd: '2026-10-20', atd: '2026-10-21', transitDays: 5, eta: '2026-10-25', ata: null, deliveredAt: null },
  products: [
    { sku: 'HS-2M-10K', name: 'Hidrosilo 2 x 10 m', kitBoxes: null, boxes: 26, units: 26, netKg: 581.6, grossKg: 760.5 },
    { sku: 'KIT-HF', name: 'Kit Hydroforce', kitBoxes: [{ kind: 'BIG', code: '79583', kits: 26, boxes: 1 }], boxes: 1, units: 26, netKg: 46.8, grossKg: 52 },
  ],
  totals: { pallets: 2, packages: 27, units: 52, netKg: 628.4, grossKg: 812.5 },
  ...extra,
})

const data: TrackingSummary = {
  operationIds: [11, 12],
  orderRef: 'Proforma 192.26',
  customer: 'Agro Uruguay SA',
  country: 'Uruguai',
  service: 'FCL',
  placeMode: 'SEA',
  originPlace: 'Rio Grande',
  destinationPlace: 'Montevideo',
  unitCount: 2,
  units: [unit(1), unit(2)],
}

const MESSAGE = 'Estimado cliente:\nSu carga ya zarpó.\n\nSaludos cordiales.'
const NOW = new Date('2026-10-13T15:00:00Z')

describe('PDF do resumo para o cliente (Status do embarque)', () => {
  it('es, todas as seções, mensagem com quebras de linha: abre no pdf-lib e traz título, contêiner e mensagem', async () => {
    const bytes = await buildTrackingSummaryPdf(data, { lang: 'es', sections: SUMMARY_SECTIONS, message: MESSAGE, generatedBy: 'Matías Teste', now: NOW })
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1)
    const txt = drawnText(bytes)
    expect(txt).toContain('ESTADO DEL EMBARQUE')
    expect(txt).toContain('Situación al 13/10/2026')
    expect(txt).toContain('MSCU1234561')
    expect(txt).toContain('MSCU1234562')
    expect(txt).toContain('SEAL-2')
    // mensagem: um parágrafo por linha
    expect(txt).toContain('Estimado cliente:')
    expect(txt).toContain('Su carga ya zarpó.')
    expect(txt).toContain('Saludos cordiales.')
    // etapa atual, embarque, rota e produtos
    expect(txt).toContain('En tránsito')
    expect(txt).toContain('etapa 5 de 7')
    expect(txt).toContain('Naviera')
    expect(txt).toContain('BK-777')
    expect(txt).toContain('25/10/2026')
    expect(txt).toContain('5 días')
    expect(txt).toContain('Hidrosilo 2 x 10 m')
    expect(txt).toContain('Total del pedido')
    // rodapé: Instagram e quem gerou; o WhatsApp fala do embarque (não de cotação)
    expect(txt).toContain('@pacifil360')
    expect(txt).toContain('generado por Matías Teste')
    expect(txt).toContain(encodeURIComponent('consultar sobre el embarque'))
    expect(txt).not.toContain('cotizaci')
  })

  it('en, todas as seções: título, contêiner, mensagem e datas no formato "25 Oct 2026"', async () => {
    const bytes = await buildTrackingSummaryPdf(data, { lang: 'en', sections: SUMMARY_SECTIONS, message: 'Dear customer,\nYour cargo has sailed.', generatedBy: 'Matías Teste', now: NOW })
    await PDFDocument.load(bytes)
    const txt = drawnText(bytes)
    expect(txt).toContain('SHIPMENT STATUS')
    expect(txt).toContain('Status as of 13 Oct 2026')
    expect(txt).toContain('MSCU1234561')
    expect(txt).toContain('Dear customer,')
    expect(txt).toContain('Your cargo has sailed.')
    expect(txt).toContain('25 Oct 2026')
    expect(txt).toContain('In transit')
    expect(txt).toContain('Shipping line')
    expect(txt).toContain('generated by Matías Teste')
  })

  it('só as seções escolhidas: sem "Produtos" e "Contêineres" não aparecem produtos nem contêineres', async () => {
    const txt = drawnText(await buildTrackingSummaryPdf(data, { lang: 'es', sections: ['order', 'status'], now: NOW }))
    expect(txt).toContain('ESTADO DEL EMBARQUE')
    expect(txt).toContain('Agro Uruguay SA')
    expect(txt).toContain('En tránsito')
    expect(txt).not.toContain('MSCU1234561')
    expect(txt).not.toContain('Hidrosilo')
    expect(txt).not.toContain('BK-777')
  })

  it('etapas diferentes por carga e cancelada: uma linha de etapas por carga, cancelada só em texto', async () => {
    const d: TrackingSummary = {
      ...data,
      unitCount: 3,
      units: [unit(1, { status: 'LOADED' }), unit(2, { shipping: { ...unit(2).shipping, carrier: 'Hapag' } }), unit(3, { status: 'CANCELLED', shipping: { ...unit(3).shipping, carrier: 'CMA CGM' } })],
    }
    const txt = drawnText(await buildTrackingSummaryPdf(d, { lang: 'pt', sections: SUMMARY_SECTIONS, now: NOW }))
    expect(txt).toContain('STATUS DO EMBARQUE')
    expect(txt).toContain('Carregado')
    expect(txt).toContain('Em trânsito')
    expect(txt).toContain('Cancelado')
    expect(txt).toContain('Contêiner 3')
    // armador diferente entre as cargas em curso: tabela por carga; o da cancelada (parado) não aparece
    expect(txt).toContain('Maersk')
    expect(txt).toContain('Hapag')
    expect(txt).not.toContain('CMA CGM')
  })

  it('número da carga = posição NO PEDIDO (unitIndex, como na plataforma), não a posição no resumo', async () => {
    // pedido com 3 cargas; a 2 ainda sem seguimento: o resumo traz a 1 e a 3
    const d: TrackingSummary = { ...data, unitCount: 3, units: [unit(1, { status: 'LOADED' }), unit(3, { shipping: { ...unit(3).shipping, carrier: 'Hapag' } })] }
    for (const lang of ['pt', 'es'] as const) {
      const txt = drawnText(await buildTrackingSummaryPdf(d, { lang, sections: SUMMARY_SECTIONS, now: NOW }))
      const name = lang === 'pt' ? 'Contêiner' : 'Contenedor'
      expect(txt).toContain(`${name} 1`)
      expect(txt).toContain(`${name} 3`)
      expect(txt).not.toContain(`${name} 2`)
    }
  })

  it('carga cancelada: marcada na tabela de contêineres; fora da comparação e das tabelas por carga de rota e embarque', async () => {
    const stale = unit(2, { status: 'CANCELLED', shipping: { ...unit(2).shipping, carrier: 'Hapag', bookingNumber: null }, dates: { ...unit(2).dates, etd: null, eta: '2026-11-30' } })
    const d: TrackingSummary = { ...data, units: [unit(1), stale] }
    const txt = drawnText(await buildTrackingSummaryPdf(d, { lang: 'es', sections: ['route', 'shipping', 'containers'], now: NOW }))
    expect(txt).toContain('Contenedor 2 · Cancelado')
    expect(txt).toContain('MSCU1234562')
    // dados da carga em curso uma vez só; os parados da cancelada não aparecem nem viram tabela por carga
    expect(txt).toContain('Maersk')
    expect(txt).toContain('BK-777')
    expect(txt).toContain('20/10/2026')
    expect(txt).not.toContain('Hapag')
    expect(txt).not.toContain('30/11/2026')
    expect(txt).not.toContain('Contenedor 1 (')
    // uma carga só, cancelada: a coluna da carga aparece para marcá-la
    const one = drawnText(await buildTrackingSummaryPdf({ ...data, units: [{ ...stale, unitIndex: 1 }] }, { lang: 'es', sections: ['containers'], now: NOW }))
    expect(one).toContain('Contenedor · Cancelado')
  })

  describe('título da seção nunca sozinho no pé da página (com o primeiro bloco na mesma página)', () => {
    // 8 caminhões; a mensagem (1 a 60 linhas) empurra as seções por todas as alturas da página
    const road = (extra: (i: number) => Partial<SummaryUnit> = () => ({})): TrackingSummary => ({
      ...data,
      service: 'ROAD',
      placeMode: 'ROAD',
      unitCount: 8,
      units: Array.from({ length: 8 }, (_, k) => unit(k + 1, { equipment: { code: 'SIDER', name: 'Sider 14,6 m', service: null }, containerNumber: `ABC1D2${k + 1}`, ...extra(k + 1) })),
    })
    const message = (n: number) => Array.from({ length: n }, (_, j) => `Línea ${j + 1}`).join('\n')
    const check = async (d: TrackingSummary, sections: SummarySection[], title: string, firstBlock: string[]) => {
      for (let n = 1; n <= 60; n++) {
        const pages = await pageTexts(await buildTrackingSummaryPdf(d, { lang: 'es', sections, message: message(n), now: NOW }))
        const at = pages.findIndex((p) => drawnAlone(p, title))
        expect(at, `${title}, mensagem com ${n} linhas`).toBeGreaterThanOrEqual(0)
        for (const s of firstBlock) expect(pages[at].includes(s), `${title} sem "${s}" na mesma página (mensagem com ${n} linhas)`).toBe(true)
      }
    }

    it('contêineres/caminhões: a tabela inteira (uma linha por carga) vai com o título', async () => {
      await check(road(), ['order', 'containers'], 'CAMIONES', ['Camión 1', 'Camión 8'])
    })

    it('etapa atual com etapas diferentes por carga: o rótulo e as etapas da 1ª carga vão com o título', async () => {
      await check(road((i) => ({ status: i % 2 ? 'LOADED' : 'IN_TRANSIT' })), ['order', 'status'], 'ETAPA ACTUAL', ['Camión 1 · ABC1D21', '4. Cargado'])
    })

    it('embarque com todos os campos diferentes por carga (sem pares): a tabela vai com o título', async () => {
      const d = road((i) => ({ shipping: { carrier: `Trans ${i}`, forwarder: `Fwd ${i}`, bookingNumber: `BK-${i}`, blNumber: `CRT-${i}`, vessel: `Placa ${i}`, voyage: `${i}E` } }))
      await check(d, ['order', 'shipping'], 'EMBARQUE', ['Trans 1', 'Trans 8'])
    })
  })

  it('datas civis sem fuso: es/pt dd/mm/aaaa, en "25 Oct 2026"; vazio = —', () => {
    expect(fmtSummaryDate('2026-10-25', 'es')).toBe('25/10/2026')
    expect(fmtSummaryDate('2026-10-25', 'pt')).toBe('25/10/2026')
    expect(fmtSummaryDate('2026-10-25', 'en')).toBe('25 Oct 2026')
    expect(fmtSummaryDate('2026-03-05', 'en')).toBe('5 Mar 2026')
    expect(fmtSummaryDate('2027-01-01', 'en')).toBe('1 Jan 2027')
    expect(fmtSummaryDate(null, 'es')).toBe('—')
    expect(fmtSummaryDate('25/10/2026', 'en')).toBe('—')
    expect(fmtSummaryDate('2026-13-01', 'es')).toBe('—')
  })
})
