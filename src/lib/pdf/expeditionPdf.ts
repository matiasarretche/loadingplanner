/**
 * PDF de EXPEDIÇÃO (instrução de carregamento para quem monta a carga). SEM preços nem condições
 * comerciais. Conteúdo: dados da carga e do transporte, avisos (vãos a calçar), PLANTA (vista de
 * cima) e as DUAS VISTAS LATERAIS (oeste = lado do motorista; leste = lado do acompanhante) desenhadas
 * em vetor com cada unidade numerada, vistas 3D de vários ângulos, sequência de carregamento passo a
 * passo, a lista de carregamento (ordem, posição, lado, apoio) e a composição exata de cada palete.
 * Orientação: NORTE = frente (cabine), SUL = traseira (nem todo caminhão tem porta atrás).
 * Documento interno: sempre em português. Gerado no navegador (as vistas vêm do 3D da tela).
 */
import { PDFDocument, rgb, RGB, StandardFonts } from 'pdf-lib'
import { distinctSkuColors } from '@/domain/colors'
import type { ExpeditionModel, ExpeditionRow } from '@/domain/expedition'
import type { LoadDoc } from '@/domain/types'
import { fitSize, labelSpot, sideViewOrder, ViewSide } from './expeditionLayout'
import { COMPANY, PDF_TZ } from './i18n'
import { A4, clean, GREY, LINE, M, Writer } from './orderPdf'

export interface ExpeditionMeta {
  planName: string
  version: number
  status: string
  generatedAt: Date
  customer?: string | null
  orderRef?: string | null
  destination?: string | null
  mode?: string | null
  transportCompany?: string | null
  /** frente × traseira (% do peso) */
  frontPct?: number | null
  rearPct?: number | null
  logo?: Uint8Array | null
  /** nome do usuário que gerou o PDF (rodapé discreto) */
  generatedBy?: string | null
}

export interface ExpeditionImages {
  views: { title: string; bytes: Uint8Array }[]
  steps: { title: string; bytes: Uint8Array }[]
}

const STATUS: Record<string, string> = { DRAFT: 'rascunho', IN_REVIEW: 'em revisão', APPROVED: 'APROVADA', SUPERSEDED: 'substituída' }
const MODE: Record<string, string> = { SEA: 'Marítima (contêiner)', ROAD: 'Rodoviária (caminhão)', AIR: 'Aérea' }
const DARK = rgb(0.12, 0.16, 0.2)
/** nomes dos pontos de referência, os mesmos do 3D */
const NORTH = 'NORTE · FRENTE (cabine)'
const SOUTH = 'SUL · TRASEIRA'
const WEST = 'OESTE · lado do motorista'
const EAST = 'LESTE · lado do acompanhante'

/** cor clareada e OPACA (equivale à cor com transparência sobre o branco, mas tapa o que está atrás) */
const tint = (c: RGB, a: number) => rgb(c.red * a + 1 - a, c.green * a + 1 - a, c.blue * a + 1 - a)

const hexRgb = (hex: string) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  return m ? rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255) : rgb(0.6, 0.6, 0.6)
}

export async function buildExpeditionPdf(doc: LoadDoc, model: ExpeditionModel, meta: ExpeditionMeta, images: ExpeditionImages): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(clean(`Expedição — ${meta.planName} V${meta.version}`))
  pdf.setAuthor(COMPANY.legalName)
  pdf.setCreator('Pacifil Export Load Planner')
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const w = new Writer(pdf, font, bold, `Expedição · ${meta.planName} V${meta.version} · gerado em ${meta.generatedAt.toLocaleString('pt-BR', { timeZone: PDF_TZ })}`, 'pt')
  const nf = w.nf
  await w.useLogo(meta.logo)
  w.generatedBy = meta.generatedBy ?? null
  const width = A4.w - 2 * M
  const S = doc.space
  const colorOf = distinctSkuColors(Object.values(doc.pallets).flatMap((p) => Object.values(p.packs)).concat(Object.values(doc.packs)))
  const rowColor = (r: ExpeditionRow) => hexRgb(colorOf.get(r.items[0]?.sku ?? '') ?? '#999999')
  /** texto em negrito centrado no ponto (x, y = centro vertical) */
  const centered = (txt: string, x: number, y: number, fs: number) => w.page.drawText(txt, { x: x - bold.widthOfTextAtSize(txt, fs) / 2, y: y - fs / 3, size: fs, font: bold, color: DARK })
  /** texto pequeno em cinza na largura toda (quebra de linha) */
  const note = (t: string, strong = false) => {
    for (const l of w.wrap(t, width, 7, strong)) {
      w.ensure(10)
      w.text(l, M, 7, { color: GREY, bold: strong })
      w.y -= 9
    }
  }
  /** título de seção junto com o desenho (o título nunca fica sozinho no fim da página) */
  const sectionWith = (title: string, h: number) => {
    w.ensure(31 + h)
    w.section(title)
  }

  w.header('INSTRUÇÃO DE CARREGAMENTO — EXPEDIÇÃO', `${meta.planName} · V${meta.version} (${STATUS[meta.status] ?? meta.status})`, meta.generatedAt.toLocaleDateString('pt-BR', { timeZone: PDF_TZ }), 'Pacifil Brasil')

  // ---------- dados da carga
  w.section('Carga')
  w.pairs([
    ['Cliente', meta.customer || '—'],
    ['Proforma / pedido', meta.orderRef || '—'],
    ['Destino', meta.destination || '—'],
    ['Modalidade', MODE[meta.mode ?? ''] ?? meta.mode ?? '—'],
    ['Equipamento', `${S.code} — ${S.name}`],
    ['Medidas internas', `${nf(S.inner.l)} × ${nf(S.inner.w)} × ${nf(S.inner.h)} mm${S.baseInnerL != null ? ' (comprimento informado)' : ''}`],
    ['Transportadora', meta.transportCompany || '—'],
    ['Unidades', `${nf(model.totals.pallets)} palete(s)${model.totals.packages ? ` + ${nf(model.totals.packages)} volume(s) solto(s)` : ''} · ${nf(model.totals.boxes)} caixas`],
    ['Peso bruto (c/ paletes)', `${nf(model.totals.grossKg, 0)} kg`],
    ['Comprimento ocupado', `${nf(model.totals.usedLengthMm)} de ${nf(S.inner.l)} mm`],
    ...(meta.frontPct != null && meta.rearPct != null ? ([['Peso frente / traseira', `${nf(meta.frontPct, 1)}% / ${nf(meta.rearPct, 1)}%`]] as [string, string][]) : []),
  ])
  note('Orientação: NORTE = frente (cabine) · SUL = traseira · OESTE = lado do motorista · LESTE = lado do acompanhante.', true)

  if (model.notes.length) {
    w.section('Atenção no carregamento')
    for (const n of model.notes) {
      const lines = w.wrap(`• ${n}`, width, 9)
      w.ensure(12 * lines.length + 2)
      for (const l of lines) {
        w.text(l, M, 9, { color: rgb(0.7, 0.37, 0) })
        w.y -= 12
      }
    }
  }

  const L = S.inner.l, Wd = S.inner.w, H = S.inner.h
  const loaded = model.rows.filter((r) => !r.outside)
  /** régua em metros sob o desenho; `mirror` = norte à direita */
  const ruler = (base: number, scale: number, mirror: boolean) => {
    for (let m = 0; m <= L; m += 1000) {
      const x = M + (mirror ? L - m : m) * scale
      w.page.drawLine({ start: { x, y: base - 2 }, end: { x, y: base - 6 }, thickness: 0.5, color: GREY })
      if (m % 2000 === 0) w.page.drawText(`${m / 1000} m`, { x: x - 6, y: base - 14, size: 6, font, color: GREY })
    }
  }

  // ---------- PLANTA (vista de cima), em vetor
  const sc = Math.min(width / L, 150 / Wd)
  const floor = loaded.filter((r) => r.z0 <= 1)
  const stackCount = (f: ExpeditionRow) => loaded.filter((r) => r.z0 > 1 && r.x0 < f.x1 - 1 && f.x0 < r.x1 - 1 && r.y0 < f.y1 - 1 && f.y0 < r.y1 - 1).length
  sectionWith('Planta — vista de cima (norte/frente à esquerda, sul/traseira à direita)', Wd * sc + 50)
  {
    const top = w.y - 10
    const base = top - Wd * sc
    w.text(`« ${NORTH}`, M, 7, { bold: true, color: GREY })
    w.text(`${SOUTH} »`, M, 7, { bold: true, color: GREY, align: 'right', width: L * sc })
    w.text(EAST, M + (L * sc) / 2 - font.widthOfTextAtSize(EAST, 7) / 2, 7, { color: GREY })
    w.page.drawRectangle({ x: M, y: base, width: L * sc, height: Wd * sc, borderColor: DARK, borderWidth: 1 })
    for (const r of floor) {
      const x = M + r.x0 * sc, y = base + r.y0 * sc, ww = (r.x1 - r.x0) * sc, hh = (r.y1 - r.y0) * sc
      w.page.drawRectangle({ x, y, width: ww, height: hh, color: tint(rowColor(r), 0.5), borderColor: DARK, borderWidth: 0.6 })
      // sem espaço: tira o "+n"; ainda sem espaço: sem rótulo (a lista tem a posição)
      const n = stackCount(r)
      for (const txt of (n ? [`${r.label} +${n}`, r.label] : [r.label]).map(clean)) {
        const fs = fitSize((s) => bold.widthOfTextAtSize(txt, s), ww, hh, 9)
        if (fs) {
          centered(txt, x + ww / 2, y + hh / 2, fs)
          break
        }
      }
    }
    ruler(base, sc, false)
    w.y = base - 24
    w.text(WEST, M + (L * sc) / 2 - font.widthOfTextAtSize(WEST, 7) / 2, 7, { color: GREY })
    w.y -= 10
    note('Cada retângulo = uma unidade no piso; "+1" = unidades empilhadas por cima (ver a lista). Cores = produto (as mesmas do 3D).')
    w.y -= 2
  }

  // ---------- VISTAS LATERAIS (oeste e leste), em vetor, como se vê de fora de cada lado
  const sz = Math.min(width / L, 110 / H)
  const sideView = (side: ViewSide) => {
    const east = side === 'LESTE'
    sectionWith(east ? 'Vista lateral — lado LESTE (lado do acompanhante)' : 'Vista lateral — lado OESTE (lado do motorista)', H * sz + 52)
    // do lado leste, quem olha tem a frente (norte) à DIREITA: o desenho é espelhado
    const X = (x: number) => M + (east ? L - x : x) * sz
    const top = w.y - 10
    const base = top - H * sz
    if (east) {
      w.text(`« ${SOUTH}`, M, 7, { bold: true, color: GREY })
      w.text(`${NORTH} »`, M, 7, { bold: true, color: GREY, align: 'right', width: L * sz })
    } else {
      w.text(`« ${NORTH}`, M, 7, { bold: true, color: GREY })
      w.text(`${SOUTH} »`, M, 7, { bold: true, color: GREY, align: 'right', width: L * sz })
    }
    w.page.drawRectangle({ x: M, y: base, width: L * sz, height: H * sz, borderColor: DARK, borderWidth: 1 })
    // do fundo para perto de quem olha, cores opacas: o que está na frente tapa o de trás
    for (const r of sideViewOrder(loaded, side, Wd)) {
      const xa = X(east ? r.x1 : r.x0)
      w.page.drawRectangle({ x: xa, y: base + r.z0 * sz, width: (r.x1 - r.x0) * sz, height: r.height * sz, color: tint(rowColor(r), 0.55), borderColor: DARK, borderWidth: 0.6 })
    }
    // rótulos por último, só na parte VISÍVEL de cada unidade (nada na frente dela nessa vista)
    for (const r of loaded) {
      const txt = clean(r.label)
      const fs = fitSize((s) => bold.widthOfTextAtSize(txt, s), (r.x1 - r.x0) * sz, r.height * sz, 8)
      if (!fs) continue
      const spot = labelSpot(r, loaded, side, Wd, (bold.widthOfTextAtSize(txt, fs) + 2) / sz, (fs + 2) / sz)
      if (spot) centered(txt, X(spot.x), base + spot.z * sz, fs)
    }
    ruler(base, sz, east)
    w.y = base - 24
    note(`Como se vê de fora, do lado ${east ? 'LESTE (acompanhante): frente (norte) à DIREITA' : 'OESTE (motorista): frente (norte) à esquerda'}. Altura interna ${nf(H)} mm. Unidades escondidas atrás de outras aparecem na vista do outro lado e na planta.`)
    w.y -= 2
  }
  sideView('OESTE')
  sideView('LESTE')

  // ---------- imagens (vistas 3D e sequência), 2 por linha
  const grid = async (title: string, list: { title: string; bytes: Uint8Array }[]) => {
    if (!list.length) return
    w.newPage()
    w.section(title)
    const gap = 10
    const imgW = (width - gap) / 2
    for (let i = 0; i < list.length; i += 2) {
      const pair = list.slice(i, i + 2)
      // imagem danificada: entra um quadro vazio com o título (o PDF nunca falha por isso)
      const embedded: (Awaited<ReturnType<typeof pdf.embedJpg>> | null)[] = []
      for (const it of pair) {
        try {
          embedded.push(it.bytes[0] === 0x89 && it.bytes[1] === 0x50 ? await pdf.embedPng(it.bytes) : await pdf.embedJpg(it.bytes))
        } catch {
          embedded.push(null)
        }
      }
      // altura da imagem (quadro vazio de proporção 820/1400 se a imagem estava danificada)
      const ihOf = (im: (typeof embedded)[number]) => (im ? (im.height / im.width) * imgW : imgW * (820 / 1400))
      const h = Math.max(...embedded.map(ihOf))
      // títulos quebrados na largura da imagem (no máx. 2 linhas)
      const titles = pair.map((it) => w.wrap(it.title, imgW, 8, true).slice(0, 2))
      const capH = Math.max(...titles.map((t) => t.length)) * 10
      w.ensure(h + 14 + capH)
      embedded.forEach((im, k) => {
        const ih = ihOf(im)
        if (im) w.page.drawImage(im, { x: M + k * (imgW + gap), y: w.y - ih, width: imgW, height: ih })
        w.page.drawRectangle({ x: M + k * (imgW + gap), y: w.y - ih, width: imgW, height: ih, borderColor: LINE, borderWidth: 0.5 })
      })
      w.y -= h + 10
      const y0 = w.y
      titles.forEach((ls, k) =>
        ls.forEach((l, j) => {
          w.y = y0 - j * 10
          w.text(l, M + k * (imgW + gap), 8, { bold: true, color: GREY })
        }),
      )
      w.y = y0 - capH - 4
    }
  }
  await grid('Vistas 3D (vários ângulos)', images.views)
  await grid('Sequência de carregamento (passo a passo)', images.steps)

  // ---------- lista de carregamento
  w.newPage()
  w.section('Lista de carregamento (na ordem em que entra)')
  const sideTxt = (r: ExpeditionRow) => (r.side === 'OESTE' ? 'oeste' : r.side === 'LESTE' ? 'leste' : 'centro')
  const obs = (r: ExpeditionRow) => {
    if (r.outside) return 'FORA DA CARGA'
    const base = r.stackedOn ? `sobre ${r.stackedOn} (${nf(r.z0)} mm)` : r.z0 > 1 ? `elevado (${nf(r.z0)} mm)` : 'no piso'
    return r.overhang ? `${base} · passa do limite` : base
  }
  w.table(
    [
      { title: 'Ordem', w: 34, align: 'right' },
      { title: 'Unid.', w: 38 },
      { title: 'Palete', w: 70 },
      { title: 'Produtos (caixas)', w: 136 },
      { title: 'Peso kg', w: 46, align: 'right' },
      { title: 'Posição a partir da frente (mm)', w: 84, align: 'right' },
      { title: 'Lado', w: 38 },
      { title: 'Apoio / obs.', w: 69 },
    ],
    model.rows.map((r) => [
      String(r.order),
      r.label,
      `${r.carrier}${r.rotated ? ' (girado)' : ''}`,
      // kits: tipo da caixa junto (caixa 79583 de 26 / meia caixa / individual)
      r.items.map((i) => `${i.sku} × ${nf(i.boxes)}${i.box ? ` (${i.box})` : ''}`).join(', '),
      nf(r.grossKg, 0),
      `${nf(r.x0)}–${nf(r.x1)}`,
      sideTxt(r),
      obs(r),
    ]),
  )
  w.y -= 4
  note('Documento interno de expedição — sem preços. Posições medidas a partir da FRENTE (norte, cabine) em direção à TRASEIRA (sul). Lado: oeste = lado do motorista; leste = lado do acompanhante; centro = no meio.')

  // ---------- composição exata de cada palete (montagens iguais juntas)
  if (model.pallets.length) {
    const cols: { title: string; w: number; align?: 'right' }[] = [
      { title: 'Produto', w: 120 },
      { title: 'Descrição', w: 205 },
      { title: 'Caixa C × L × A (mm)', w: 95, align: 'right' },
      { title: 'Caixas', w: 47, align: 'right' },
      { title: 'Unidades', w: 48, align: 'right' },
    ]
    /** o que cada montagem desenha, medido com as mesmas quebras de linha do desenho */
    const blocks = model.pallets.map((c) => {
      const n = c.labels.length
      const headLines = w.wrap(`${c.labels.join(', ')}${n > 1 ? ` — ${nf(n)} paletes iguais` : ''}`, width, 9.5, true)
      const sub = `${c.carrier} · ${nf(c.boxes)} caixas${c.fullBoxes && c.fullBoxes > c.boxes ? ` (parcial: completo leva ${nf(c.fullBoxes)})` : ''} · altura ${nf(c.heightMm)} mm · ${nf(c.grossKg, 0)} kg bruto · ${nf(c.netKg, 0)} kg líquido${n > 1 ? ' (cada)' : ''}`
      const rows = c.items.map((i) => [i.sku, i.box ? `${i.name} — ${i.box}` : i.name, i.dims ? `${nf(i.dims.l)} × ${nf(i.dims.w)} × ${nf(i.dims.h)}` : '—', nf(i.boxes), nf(i.units)])
      const layerLines = c.layers.flatMap((l) => w.wrap(`Camada${l.to > l.from ? `s ${l.from} a ${l.to}` : ` ${l.from}`}: ${l.text}`, width, 7.5))
      // linhas da tabela como Writer.table: 14 por linha + 10,5 por linha quebrada a mais; cabeçalho idem
      const rowH = (cells: string[], size: number, bold: boolean) => 14 + (Math.max(1, ...cells.map((t, k) => w.wrap(t, cols[k].w - 6, size, bold).length)) - 1) * (size + 2)
      const tableH = rowH(cols.map((x) => x.title), 7.5, true) + rows.reduce((s, r) => s + rowH(r, 8.5, false), 0)
      // limitado a uma página útil (um bloco maior que a página quebra sem deixar página vazia)
      const h = Math.min(headLines.length * 12 + 14 + tableH + layerLines.length * 9.5 + 8, A4.h - 2 * M - 46)
      return { headLines, sub, rows, layerLines, h }
    })
    // título da seção + nota + o 1º palete juntos (o título nunca fica sozinho no fim da página)
    w.ensure(48 + blocks[0].h)
    w.y -= 6
    w.section('Composição de cada palete')
    note('Paletes iguais aparecem juntos. Camadas de baixo para cima (a 1ª fica sobre o tabuleiro); os números são CAIXAS.')
    w.y -= 2
    for (const b of blocks) {
      w.ensure(b.h)
      for (const l of b.headLines) {
        w.text(l, M, 9.5, { bold: true })
        w.y -= 12
      }
      w.text(b.sub, M, 8, { color: GREY })
      w.y -= 14
      w.table(cols, b.rows)
      for (const t of b.layerLines) {
        w.ensure(10)
        w.text(t, M, 7.5, { color: GREY })
        w.y -= 9.5
      }
      w.y -= 8
    }
  }
  w.finish(`Expedição ${meta.planName} V${meta.version}`)
  return pdf.save()
}
