import { describe, expect, it } from 'vitest'
import { placePallets } from './autoload'
import { expeditionModel, palletLayers, sideOf, unitLabel } from './expedition'
import { container, loadDoc, pack, palletDoc, palletType } from './fixtures'
import { loadGeometries } from './load'
import { optimizeMixedPallets } from './mixedPallets'
import type { LoadDoc, LoadUnit } from './types'

const a = pack({ sku: 'SB-A', packagingVersionId: 1, grossKg: 100, netKg: 94 })
const item = (id: string, z: number) => ({ id, packId: 'a', pos: { x: 0, y: 0, z }, orientation: 'LWH' as const, locked: false })
const pal = palletDoc({ packs: { a }, items: [item('1', 0), item('2', 400)] })

/** palete (1000 × 1200 no piso) na posição dada */
const P = (id: string, x: number, y: number, z = 0): LoadUnit => ({ id, kind: 'PALLET', palletKey: 'p', pos: { x, y, z }, yaw: false, locked: false })
const V = (id: string, x: number, y: number, z = 0): LoadUnit => ({ id, kind: 'PACKAGE', packId: 'a', pos: { x, y, z }, orientation: 'LWH', locked: false })
const docWith = (units: LoadUnit[]): LoadDoc => loadDoc({ space: container('40HC'), pallets: { p: pal }, packs: { a }, units })
/** altura do palete montado (para empilhar exatamente em cima) */
const palH = loadGeometries(docWith([P('x', 0, 0)]))[0].box.size.z

describe('expedição: instrução de carregamento (sem preços)', () => {
  it('ordem do fundo para a porta, posição, lado e conteúdo', () => {
    const doc = placePallets(loadDoc({ space: container('40HC') }), 'p', pal, 6).doc
    const m = expeditionModel(doc, { maxSteps: 3 })
    expect(m.rows).toHaveLength(6)
    expect(m.rows.map((r) => r.order)).toEqual([1, 2, 3, 4, 5, 6])
    for (let i = 1; i < m.rows.length; i++) expect(m.rows[i].x0).toBeGreaterThanOrEqual(m.rows[i - 1].x0)
    expect(m.rows[0].items).toEqual([{ sku: 'SB-A', name: expect.any(String), boxes: 2, units: 2 }])
    expect(['OESTE', 'CENTRO', 'LESTE']).toContain(m.rows[0].side)
    expect(m.rows.every((r) => r.stackedOn === null && !r.outside)).toBe(true)
    // passos acumulados: o último mostra todas as unidades
    expect(m.steps.length).toBeLessThanOrEqual(3)
    expect(m.steps.at(-1)!.ids).toHaveLength(6)
    // nada de preço no modelo
    expect(JSON.stringify(m)).not.toMatch(/usd|price|preço/i)
  })
  it('avisa o espaço livre na porta a calçar', () => {
    const doc = placePallets(loadDoc({ space: container('40HC') }), 'p', pal, 2).doc
    const m = expeditionModel(doc)
    expect(m.notes.some((n) => /TRASEIRA/.test(n))).toBe(true)
  })

  it('unidade em PONTE entra depois de todos os apoios, mesmo que comece antes', () => {
    // P1 0–1000, P3 1000–2000 no piso; P2 em cima, de 500 a 1500 (apoiada nos dois)
    // paletes CHEIOS (duas camadas completas de 2 × 3 caixas): o de cima apoia de verdade nos dois
    const grid = [0, 300].flatMap((z) => [0, 500].flatMap((x) => [0, 400, 800].map((y) => ({ id: `${x}-${y}-${z}`, packId: 'a', pos: { x, y, z }, orientation: 'LWH' as const, locked: false }))))
    const full = palletDoc({ packs: { a }, items: grid })
    const fullH = full.palletType.dims.h + 600
    const doc = loadDoc({ space: container('40HC'), pallets: { p: full }, packs: { a }, units: [P('a', 0, 0), P('b', 500, 0, fullH), P('c', 1000, 0)] })
    const m = expeditionModel(doc)
    const order = m.rows.map((r) => r.id)
    expect(order.indexOf('b')).toBeGreaterThan(order.indexOf('a'))
    expect(order.indexOf('b')).toBeGreaterThan(order.indexOf('c'))
    const b = m.rows.find((r) => r.id === 'b')!
    expect(b.stackedOn).toBe('P1 + P3')
    // a sequência nunca mostra a unidade de cima sem os apoios
    for (const st of m.steps) if (st.ids.includes('b')) expect(st.ids).toEqual(expect.arrayContaining(['a', 'c']))
  })

  it('apoio com folga de medida é reconhecido; elevada sem apoio fica sem "sobre"', () => {
    const m = expeditionModel(docWith([P('a', 0, 0), P('b', 0, 0, palH + 20), P('c', 3000, 0, 400)]))
    expect(m.rows.find((r) => r.id === 'b')!.stackedOn).toBe('P1')
    const c = m.rows.find((r) => r.id === 'c')!
    expect(c.stackedOn).toBeNull()
    expect(c.z0).toBe(400) // o PDF mostra "elevado (400 mm)", nunca "no piso"
  })

  it('lado pela parede mais próxima: dois paletes de 1000 mm = oeste e leste', () => {
    const W = 2352
    expect(sideOf(0, 1000, W)).toBe('OESTE')
    expect(sideOf(1000, 2000, W)).toBe('LESTE')
    expect(sideOf(1352, 2352, W)).toBe('LESTE')
    expect(sideOf(0, 1200, W)).toBe('OESTE')
    expect(sideOf(576, 1776, W)).toBe('CENTRO') // centralizado
    expect(sideOf(800, 1550, W)).toBe('CENTRO') // o do meio de três
  })

  it('volumes soltos com rótulos únicos, os mesmos do 3D e dos alertas (V = posição no plano)', () => {
    const doc = docWith([P('a', 0, 0), V('v1', 2000, 0), V('v2', 2600, 0)])
    expect(unitLabel(doc, 'a')).toBe('P1')
    expect(unitLabel(doc, 'v1')).toBe('V2')
    expect(unitLabel(doc, 'v2')).toBe('V3')
    const m = expeditionModel(doc)
    expect(new Set(m.rows.map((r) => r.label)).size).toBe(3)
  })

  it('espaço livre POR FAIXA: avisa a faixa que termina antes da porta', () => {
    const L = container('40HC').inner.l
    // paletes girados (1200 no comprimento, 1000 na largura): faixa oeste até perto da porta; faixa leste termina 2 paletes antes
    const R = (id: string, x: number, y: number): LoadUnit => ({ ...P(id, x, y), yaw: true }) as LoadUnit
    const n = Math.floor(L / 1200)
    const west = Array.from({ length: n }, (_, i) => R('w' + i, i * 1200, 0))
    const east = Array.from({ length: n - 2 }, (_, i) => R('e' + i, i * 1200, 1000))
    const m = expeditionModel(docWith([...west, ...east]))
    expect(m.rows.find((r) => r.id === 'e0')!.side).toBe('LESTE')
    const rear = m.notes.filter((n) => /TRASEIRA/.test(n))
    expect(rear.some((t) => /lado leste/.test(t) && t.includes(String(L - (n - 2) * 1200) + ' mm'))).toBe(true)
    // a faixa oeste só avisa se sobrar mais que 50 mm
    expect(rear.some((t) => /lado oeste/.test(t))).toBe(L - n * 1200 > 50)
    // a frente está encostada nas duas faixas: sem aviso de motorista
    expect(m.notes.some((t) => /FRENTE/.test(t))).toBe(false)
  })
  it('caixa solta sobre a 1ª camada de um palete PARCIAL: apoio = o palete e entra depois dele', () => {
    // palete 1000 × 1200 com a 1ª camada completa (2 × 3 caixas 500 × 400 × 300) e UMA caixa na 2ª camada
    const it1 = (id: string, x: number, y: number, z: number) => ({ id, packId: 'a', pos: { x, y, z }, orientation: 'LWH' as const, locked: false })
    const layer1 = [0, 500].flatMap((x) => [0, 400, 800].map((y) => it1(`${x}-${y}`, x, y, 0)))
    const partial = palletDoc({ packs: { a }, items: [...layer1, it1('top', 0, 0, 300)] })
    const base = partial.palletType.dims.h
    // a caixa solta avança 100 mm para a frente do palete (apoio parcial permitido)
    const doc = loadDoc({ space: container('40HC'), pallets: { p: partial }, packs: { a }, units: [V('v', 200, 400, base + 300), P('p1', 300, 0)] })
    const m = expeditionModel(doc)
    expect(m.rows.map((r) => r.id)).toEqual(['p1', 'v'])
    expect(m.rows.find((r) => r.id === 'v')!.stackedOn).toBe('P2')
  })

  it('unidade que passa em parte do limite continua na carga (com aviso); a de cima entra depois dela', () => {
    const L = container('40HC').inner.l
    const m = expeditionModel(docWith([P('a', 0, 0), V('v', L - 900, 0, palH), P('b', L - 970, 0)]))
    const b = m.rows.find((r) => r.id === 'b')!
    expect(b.outside).toBe(false)
    expect(b.overhang).toBe(true)
    expect(m.totals.pallets).toBe(2)
    expect(m.notes.some((n) => n.includes('P3') && /limites internos/.test(n))).toBe(true)
    const order = m.rows.map((r) => r.id)
    expect(order.indexOf('v')).toBeGreaterThan(order.indexOf('b'))
    expect(m.rows.find((r) => r.id === 'v')!.stackedOn).toBe('P3')
    // totalmente fora (zona de trabalho): fora da carga
    const m2 = expeditionModel(docWith([P('a', 0, 0), P('z', L + 500, 0)]))
    expect(m2.rows.find((r) => r.id === 'z')!.outside).toBe(true)
    expect(m2.totals.pallets).toBe(1)
  })

  it('mesmo espaço na frente em todas as faixas: um aviso só', () => {
    const R = (id: string, x: number, y: number): LoadUnit => ({ ...P(id, x, y), yaw: true }) as LoadUnit
    const m = expeditionModel(docWith([R('a', 300, 0), R('b', 300, 1000)]))
    const front = m.notes.filter((n) => /FRENTE/.test(n))
    expect(front).toHaveLength(1)
    expect(front[0]).toMatch(/300 mm junto à FRENTE/)
  })

})

describe('expedição: kits Hydroforce por tipo de caixa', () => {
  it('uma linha por tipo de caixa de kit (36 kits = caixa 69488), com os kits de cada uma', () => {
    const pt = palletType({ palletTypeId: 6, code: 'PCF-1150', dims: { l: 1150, w: 1150, h: 160 }, maxLoadKg: 2000, staticMaxKg: 2000, dynamicMaxKg: 2000 })
    const hf = pack({ sku: 'HF-5K', packagingVersionId: 21, dims: { l: 1140, w: 570, h: 110 }, grossKg: 17.16, netKg: 12.3, boxesPerPallet: 36, companions: [{ sku: 'KIT-HF', qty: 1 }] })
    const kit = pack({ sku: 'KIT-HF', packagingVersionId: 155, dims: { l: 200, w: 200, h: 200 }, grossKg: 2, netKg: 2 })
    const p = optimizeMixedPallets(
      [
        { packId: 'pv21', pack: hf, boxes: 36 },
        { packId: 'pv155', pack: kit, boxes: 36 },
      ],
      { palletTypes: [pt], maxHeightMm: 2597 },
    ).pallets[0].doc
    const m = expeditionModel(placePallets(loadDoc({ space: container('40HC') }), 'hf', p, 1).doc)
    expect(m.rows[0].items.map((i) => [i.sku, i.boxes, i.units, i.box ?? null])).toEqual([
      ['HF-5K', 36, 36, null],
      // planilha da produção (12/10/2026): o palete de 36 HF 5K leva os 36 kits numa caixa 69488
      ['KIT-HF', 1, 36, 'caixa 69488 (36 kits)'],
    ])
  })
  it('composição de cada palete: montagens iguais juntas, caixas, medida da caixa e camadas', () => {
    const doc = placePallets(loadDoc({ space: container('40HC') }), 'p', pal, 3).doc
    const m = expeditionModel(doc)
    expect(m.pallets).toHaveLength(1)
    const c = m.pallets[0]
    expect(c.labels).toEqual(['P1', 'P2', 'P3'])
    expect(c.boxes).toBe(2)
    expect(c.items).toEqual([{ sku: 'SB-A', name: expect.any(String), boxes: 2, units: 2, dims: a.dims }])
    // duas caixas em alturas diferentes = duas camadas iguais (1 × SB-A), juntas
    expect(c.layers).toEqual([{ from: 1, to: 2, text: '1 × SB-A' }])
    expect(c.fullBoxes).toBeNull()
  })
  it('camadas diferentes ficam separadas, de baixo para cima', () => {
    const b = pack({ sku: 'KIT-X', packagingVersionId: 2, grossKg: 5, netKg: 4 })
    const mixed = palletDoc({ packs: { a, b }, items: [item('1', 0), { ...item('2', 0), pos: { x: 500, y: 0, z: 0 } }, { id: '3', packId: 'b', pos: { x: 0, y: 0, z: 400 }, orientation: 'LWH' as const, locked: false }] })
    expect(palletLayers(mixed)).toEqual([
      { from: 1, to: 1, text: '2 × SB-A' },
      { from: 2, to: 2, text: '1 × KIT-X' },
    ])
  })
  it('camadas: kits pelo tipo de caixa e caixa deitada com a altura em que vai', () => {
    const big = pack({ sku: 'KIT-HF', packagingVersionId: 3, dims: { l: 1140, w: 570, h: 250 }, kitBox: { kind: 'BIG', code: '79583', kits: 26 } as never })
    const ind = pack({ sku: 'KIT-HF', packagingVersionId: 4, dims: { l: 200, w: 200, h: 200 } })
    const tall = pack({ sku: 'SB-T', packagingVersionId: 5, dims: { l: 330, w: 330, h: 520 }, allowedOrientations: ['LWH', 'LHW'] })
    const p = palletDoc({
      packs: { big, ind, tall },
      items: [
        { id: '1', packId: 'tall', pos: { x: 0, y: 0, z: 0 }, orientation: 'LHW', locked: false },
        { id: '2', packId: 'big', pos: { x: 0, y: 0, z: 330 }, orientation: 'LWH', locked: false },
        { id: '3', packId: 'ind', pos: { x: 600, y: 0, z: 330 }, orientation: 'LWH', locked: false },
      ],
    })
    const ls = palletLayers(p)
    expect(ls[0].text).toBe('1 × SB-T (deitada, altura 330 mm)')
    expect(ls[1].text).toContain('1 × KIT-HF (caixa 79583')
    expect(ls[1].text).toContain('1 × KIT-HF (caixa individual)')
  })
  it('camadas pela caixa de apoio: alturas diferentes na mesma camada não viram camadas a mais', () => {
    const lo = pack({ sku: 'LO', packagingVersionId: 6, dims: { l: 500, w: 400, h: 250 } })
    const hi = pack({ sku: 'HI', packagingVersionId: 7, dims: { l: 500, w: 400, h: 300 } })
    const p = palletDoc({
      packs: { lo, hi },
      items: [
        { id: '1', packId: 'lo', pos: { x: 0, y: 0, z: 0 }, orientation: 'LWH', locked: false },
        { id: '2', packId: 'hi', pos: { x: 500, y: 0, z: 0 }, orientation: 'LWH', locked: false },
        { id: '3', packId: 'hi', pos: { x: 0, y: 0, z: 250 }, orientation: 'LWH', locked: false },
        { id: '4', packId: 'lo', pos: { x: 500, y: 0, z: 300 }, orientation: 'LWH', locked: false },
      ],
    })
    // z 0/0 e 250/300: duas camadas físicas (não três), iguais e juntas
    expect(palletLayers(p)).toEqual([{ from: 1, to: 2, text: '1 × HI + 1 × LO' }])
  })
  it('paletes com a mesma montagem e chaves diferentes ficam juntos', () => {
    const doc = loadDoc({ space: container('40HC'), pallets: { p1: pal, p2: { ...pal, name: 'outra' } }, packs: { a }, units: [
        { id: 'x', kind: 'PALLET', palletKey: 'p1', pos: { x: 0, y: 0, z: 0 }, yaw: false, locked: false },
        { id: 'y', kind: 'PALLET', palletKey: 'p2', pos: { x: 3000, y: 0, z: 0 }, yaw: false, locked: false },
      ] })
    const m = expeditionModel(doc)
    expect(m.pallets).toHaveLength(1)
    expect(m.pallets[0].labels).toEqual(['P1', 'P2'])
  })
})
