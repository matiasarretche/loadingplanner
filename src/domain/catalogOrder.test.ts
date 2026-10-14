import { describe, expect, it } from 'vitest'
import { type CatalogOrderKey, compareCatalogOrder } from './catalogOrder'

const FT = 0.3048
const sb = (sku: string, d: number, lengthM: number, um: number, sfx = ''): CatalogOrderKey => ({
  sku,
  widthM: d * FT,
  lengthM,
  thicknessUm: um,
  name: `Silo-bolsa ${d} pés × ${lengthM} m × ${um} µm${sfx ? ` (${sfx})` : ''}`,
})

describe('ordem dos produtos na lista: largura → comprimento → espessura', () => {
  it('a lista de silo-bolsas da captura de 14/10/2026 sai na ordem pedida', () => {
    // na ordem em que o PDF saiu (largura, comprimento e depois código)
    const items = [
      sb('19641', 6, 60, 180),
      sb('SB-PAC-6X75-180', 6, 75, 180),
      sb('SB-PAC-6X100-180', 6, 100, 180),
      sb('16690', 9, 60, 240, 'BPT'),
      sb('16859', 9, 60, 240, 'BBT'),
      sb('18143', 9, 60, 210),
      sb('18174', 9, 60, 210, 'BPM'),
      sb('19293', 9, 60, 225),
      sb('19609', 9, 60, 240),
      sb('16860', 9, 75, 240, 'BPT'),
      sb('16932', 9, 75, 225),
      sb('17039', 9, 75, 210),
      sb('18654', 9, 75, 240),
      sb('16862', 9, 100, 240, 'BPT'),
      sb('16863', 9, 100, 240, 'BBT'),
      sb('19590', 9, 100, 225),
      sb('19607', 9, 100, 240),
      sb('19635', 9, 100, 210),
      sb('SB-PAC-10X60-235', 10, 60, 235),
      sb('19528', 10, 75, 235),
      sb('SB-PAC-10X100-235', 10, 100, 235),
    ]
    expect([...items].sort(compareCatalogOrder).map((x) => x.sku)).toEqual([
      '19641', 'SB-PAC-6X75-180', 'SB-PAC-6X100-180',
      '18143', '18174', '19293', '19609', '16859', '16690',
      '17039', '16932', '18654', '16860',
      '19635', '19590', '19607', '16863', '16862',
      'SB-PAC-10X60-235', '19528', 'SB-PAC-10X100-235',
    ])
  })
  it('a espessura vem depois do comprimento (nunca antes)', () => {
    const a = sb('a', 9, 75, 210)
    const b = sb('b', 9, 60, 240)
    expect([a, b].sort(compareCatalogOrder).map((x) => x.sku)).toEqual(['b', 'a'])
  })
  it('lonas: largura em metros, depois comprimento, depois espessura', () => {
    const lona = (sku: string, w: number, l: number, um: number): CatalogOrderKey => ({ sku, widthM: w, lengthM: l, thicknessUm: um, name: `Lona padrão ${w} × ${l} m × ${um} µm` })
    const out = [lona('c', 12, 50, 125), lona('a', 8, 100, 120), lona('b', 8, 50, 150), lona('d', 8, 50, 125)].sort(compareCatalogOrder)
    expect(out.map((x) => x.sku)).toEqual(['d', 'b', 'a', 'c'])
  })
  it('comprimento em pés entra pelo valor em metros (200 pés = 60,96 m vem depois de 60 m)', () => {
    const out = [sb('ft', 10, 60.96, 235), sb('m', 10, 60, 235)].sort(compareCatalogOrder)
    expect(out.map((x) => x.sku)).toEqual(['m', 'ft'])
  })
  it('Hidrosilo: com a mesma medida, a capacidade desempata; sem capacidade vai para o fim', () => {
    const hs = (sku: string, cap: number | null): CatalogOrderKey => ({ sku, widthM: 2, lengthM: 10, thicknessUm: 600, capacityL: cap, name: `Hidrosilo ${sku}` })
    expect([hs('c', null), hs('b', 12000), hs('a', 10000)].sort(compareCatalogOrder).map((x) => x.sku)).toEqual(['a', 'b', 'c'])
  })
  it('nome com número compara como número: c/2 un antes de c/15 un', () => {
    const pk = (sku: string, n: number): CatalogOrderKey => ({ sku, widthM: 1.2, lengthM: 1.65, thicknessUm: 500, name: `Hidrosilo 1,2 × 1,65 m × 500 µm — c/${n} un` })
    expect([pk('15', 15), pk('17', 17), pk('2', 2)].sort(compareCatalogOrder).map((x) => x.sku)).toEqual(['2', '15', '17'])
  })
})
