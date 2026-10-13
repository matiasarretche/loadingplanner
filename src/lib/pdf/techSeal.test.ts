import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { TECHNOLOGIES } from '@/domain/technology'
import type { PriceListData, PriceListRow } from '@/lib/priceList'
import { clean, Writer } from './orderPdf'
import { buildPriceListPdf, PRICE_LIST_NXT } from './priceListPdf'

const seal = new Uint8Array(readFileSync(path.join(process.cwd(), 'public', TECHNOLOGIES.NXT.seal)))

const row = (sku: string, name: string): PriceListRow => ({ sku, name, brand: 'Pacifil', widthM: 2, lengthM: 10, thicknessUm: 600, capacityL: 10000, box: { l: 1140, w: 570, h: 150 }, unitsPerPallet: 26, palletCode: null, netKg: 22.37, grossKg: 28.07, priceUsd: 126, reason: null })
const data: PriceListData = {
  category: { id: 1, name: 'Categoria A' },
  incoterm: 'FOB',
  agent: null,
  generatedAt: new Date('2026-10-12T12:00:00Z'),
  groups: [
    { family: 'Hidrosilo', label: '2 m', rows: [row('HS-2M-10K', 'Hidrosilo 2 × 10 m')] },
    { family: 'Lona de silagem', label: '', rows: [row('LS-PAC-8X50-150-STD', 'Lona padrão 8 × 50 m × 150 µm')] },
  ],
}
/** imagens embutidas no PDF (o PNG com transparência gera a imagem + a máscara SMask) */
const images = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1').match(/\/Subtype\s*\/Image/g)?.length ?? 0

describe('selo PACIFIL NXT nos PDFs comerciais', () => {
  it('lista de preços: família com SELO no Catálogo embute o selo', async () => {
    const pdf = await buildPriceListPdf(data, { lang: 'es', nxt: { families: { Hidrosilo: 'SEAL', 'Lona de silagem': 'MENTION' }, text: PRICE_LIST_NXT.es, seal } })
    expect(images(pdf)).toBeGreaterThan(0)
  })

  it('lista de preços: só menção (texto) ou sem NXT não embute imagem nenhuma', async () => {
    const mention = await buildPriceListPdf(data, { lang: 'es', nxt: { families: { 'Lona de silagem': 'MENTION' }, text: PRICE_LIST_NXT.es, seal } })
    expect(images(mention)).toBe(0)
    const none = await buildPriceListPdf(data, { lang: 'es', nxt: null })
    expect(images(none)).toBe(0)
  })

  it('lista de preços: texto com quebras de linha e ™ gera o PDF normalmente', async () => {
    const pdf = await buildPriceListPdf(data, { lang: 'pt', description: 'Linha 1\nLinha 2 {marca}', nxt: { families: { Hidrosilo: 'SEAL' }, text: 'Parágrafo 1.\r\n\r\nPACIFIL NXT™ parágrafo 2.', seal } })
    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThan(0)
  })

  it('clean(): quebra de linha/tabulação vira espaço e ™ é mantido (não "?")', () => {
    expect(clean('Linha 1\r\nLinha 2\tfim')).toBe('Linha 1 Linha 2 fim')
    expect(clean('PACIFIL NXT™ — ® ç')).toBe('PACIFIL NXT™ — ® ç')
  })

  it('clean(): controles C1 (texto CP1252 colado) viram o caractere certo ou "?" e o PDF não quebra', async () => {
    expect(clean('a\x85b\x92c\x96d\x7Fe\x81f')).toBe('a…b’c–d?e?f')
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    expect(() => font.widthOfTextAtSize(clean('x\x85\x80\x9D\x7F y'), 9)).not.toThrow()
  })

  it('tabela com ícone por linha: a linha com selo cresce para o ícone caber', async () => {
    const pdf = await PDFDocument.create()
    const w = new Writer(pdf, await pdf.embedFont(StandardFonts.Helvetica), await pdf.embedFont(StandardFonts.HelveticaBold), '', 'pt')
    const img = await w.image(seal)
    expect(img).not.toBeNull()
    expect(await w.image(new Uint8Array([1, 2, 3]))).toBeNull()
    const cols = [{ title: 'Código', w: 80 }, { title: 'Descrição', w: 200 }]
    const y0 = w.y
    w.table(cols, [['HS-2M-10K', 'Hidrosilo']])
    const plain = y0 - w.y
    const y1 = w.y
    w.table(cols, [['HS-2M-10K', 'Hidrosilo']], false, { icons: [img], iconCol: 0, iconSize: 14 })
    expect(y1 - w.y).toBe(plain + 4)
  })
})
