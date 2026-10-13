import { describe, expect, it } from 'vitest'
import { pack } from './fixtures'
import { describeKitBoxes, kitBaseOf, kitBoxLines, kitBoxPack, kitFallback, kitLayerEstimate, kitOrderLines, KitFill, packKeyOf, packKits } from './kitBoxes'
import { packSnapshotSchema } from './schemas'

const kit = pack({ sku: 'KIT-HF', name: 'Kit Hydroforce', packagingVersionId: 155, dims: { l: 200, w: 200, h: 200 }, grossKg: 2, netKg: 2, allowedOrientations: ['LWH', 'WLH', 'LHW', 'HLW', 'WHL', 'HWL'], price: { amount: 0, currency: 'USD', per: 'UNIT' } })
const fmt = (fs: KitFill[]) => fs.map((f) => (f.box === 'BIG' ? String(f.kits) : f.box === 'HALF' ? `M${f.kits}` : 'I')).join(' ')

describe('caixas de kits: regra de embalagem (1 Hydroforce = 1 kit)', () => {
  it('caixas de 26 primeiro; resto 1–12 individuais, 13 uma meia caixa, 14–25 duas meias caixas', () => {
    expect(packKits(0)).toEqual([])
    expect(fmt(packKits(1))).toBe('I')
    expect(fmt(packKits(9))).toBe(Array(9).fill('I').join(' '))
    expect(fmt(packKits(10))).toBe(Array(10).fill('I').join(' '))
    expect(fmt(packKits(12))).toBe(Array(12).fill('I').join(' '))
    expect(fmt(packKits(13))).toBe('M13')
    expect(fmt(packKits(14))).toBe('M13 M1')
    expect(fmt(packKits(16))).toBe('M13 M3')
    expect(fmt(packKits(22))).toBe('M13 M9')
    expect(fmt(packKits(24))).toBe('M13 M11')
    expect(fmt(packKits(25))).toBe('M13 M12')
    expect(fmt(packKits(26))).toBe('26')
    expect(fmt(packKits(27))).toBe('26 I')
    expect(fmt(packKits(34))).toBe(`26 ${Array(8).fill('I').join(' ')}`)
    // planilha da produção (12/10/2026): 36 kits (o palete de 36 HF 5K) = 1 caixa 69488 de 36
    expect(fmt(packKits(36))).toBe('36')
    expect(packKits(36)).toEqual([{ box: 'BIG', kits: 36 }])
    expect(fmt(packKits(37))).toBe('26 I I I I I I I I I I I')
    expect(fmt(packKits(38))).toBe(`26 ${Array(12).fill('I').join(' ')}`)
    expect(fmt(packKits(39))).toBe('26 M13')
    expect(fmt(packKits(52))).toBe('26 26')
    expect(fmt(packKits(53))).toBe('26 26 I')
    expect(fmt(packKits(104))).toBe('26 26 26 26')
  })
  it('propriedades para 0…300 kits: total exato, maiores primeiro, nunca mais caixas que o necessário', () => {
    const rank = { BIG: 0, HALF: 1, IND: 2 }
    for (let n = 0; n <= 300; n++) {
      const fs = packKits(n)
      expect(fs.reduce((s, f) => s + f.kits, 0), `n=${n}`).toBe(n)
      expect(fs.every((f, i) => i === 0 || rank[fs[i - 1].box] <= rank[f.box])).toBe(true)
      expect(fs.filter((f) => f.box === 'BIG').every((f) => f.kits === 26 || (n === 36 && f.kits === 36))).toBe(true)
      expect(fs.filter((f) => f.box === 'HALF').every((f) => f.kits >= 1 && f.kits <= 13)).toBe(true)
      expect(fs.filter((f) => f.box === 'HALF').length).toBeLessThanOrEqual(2)
      const ind = fs.filter((f) => f.box === 'IND').length
      expect(ind).toBeLessThan(13)
      // individuais e meias caixas nunca juntas (resto < 13 → individuais; ≥ 13 → meias caixas)
      expect(ind > 0 && fs.some((f) => f.box === 'HALF')).toBe(false)
      expect(fs.filter((f) => f.box === 'BIG').length).toBe(Math.floor(n / 26))
    }
  })
  it('sem família de caixas: uma caixa individual por kit', () => {
    expect(packKits(3, 'OUTRO-KIT')).toEqual([{ box: 'IND', kits: 1 }, { box: 'IND', kits: 1 }, { box: 'IND', kits: 1 }])
  })
  it('reserva: caixa de 36 (69488) → regra de sempre (26 + 10 individuais)', () => {
    expect(fmt(kitFallback({ box: 'BIG', kits: 36 }))).toBe(`26 ${Array(10).fill('I').join(' ')}`)
  })
  it('reserva: caixa de 26 → 2 meias caixas; meia caixa → individuais', () => {
    expect(kitFallback({ box: 'BIG', kits: 26 })).toEqual([{ box: 'HALF', kits: 13 }, { box: 'HALF', kits: 13 }])
    expect(kitFallback({ box: 'HALF', kits: 3 })).toEqual([{ box: 'IND', kits: 1 }, { box: 'IND', kits: 1 }, { box: 'IND', kits: 1 }])
    expect(kitFallback({ box: 'IND', kits: 1 })).toEqual([])
  })
})

describe('caixas de kits: snapshots derivados da caixa individual', () => {
  const big = kitBoxPack(kit, 'BIG', 26)
  const half = kitBoxPack(kit, 'HALF', 10)
  it('medidas e pesos com a tara da caixa; kg líquido por kit e preço iguais aos da individual', () => {
    expect(big.dims).toEqual({ l: 1140, w: 570, h: 250 })
    expect(big).toMatchObject({ sku: 'KIT-HF', packagingVersionId: 155, unitsPerPackage: 26, netKg: 52, grossKg: 55.2, price: kit.price, color: kit.color })
    expect(half.dims).toEqual({ l: 570, w: 570, h: 250 })
    expect(half).toMatchObject({ unitsPerPackage: 10, netKg: 20, grossKg: 21.6 })
    for (const p of [big, half, kit]) expect(p.netKg / p.unitsPerPackage).toBe(2)
    expect(big.allowedOrientations).toEqual(['LWH', 'WLH'])
  })
  it('chave única por tipo/conteúdo; a individual mantém pv<id>', () => {
    const keys = [kit, big, half, kitBoxPack(kit, 'HALF', 13), kitBoxPack(kit, 'HALF', 9)].map(packKeyOf)
    expect(keys[0]).toBe('pv155')
    expect(new Set(keys).size).toBe(keys.length)
  })
  it('a individual é recuperada de qualquer caixa coletiva (e o zod mantém o campo kitBox)', () => {
    expect(kitBaseOf(big)).toEqual(kit)
    expect(kitBaseOf(kitBoxPack(big, 'HALF', 3))).toEqual(kit)
    const parsed = packSnapshotSchema.parse(JSON.parse(JSON.stringify(big)))
    expect(parsed.kitBox).toEqual(big.kitBox)
  })
  it('linhas de pedido sem palete (courier): uma por tipo de caixa', () => {
    const lines = kitOrderLines(kit, 'pv155', 36)
    expect(lines.map((l) => [l.packId, l.boxes, l.pack.unitsPerPackage])).toEqual([['pv155:69488x36', 1, 36]])
    expect(lines[0].pack.dims).toEqual({ l: 1000, w: 600, h: 400 })
    // 36 × 2 kg + 5,65 kg da caixa
    expect(lines[0].pack.grossKg).toBeCloseTo(77.65, 6)
    expect(kitOrderLines(kit, 'pv155', 37).map((l) => [l.packId, l.boxes])).toEqual([
      ['pv155:79583x26', 1],
      ['pv155', 11],
    ])
    expect(kitOrderLines(kit, 'pv155', 34).map((l) => [l.packId, l.boxes])).toEqual([
      ['pv155:79583x26', 1],
      ['pv155', 8],
    ])
  })
  it('descrição das caixas (PDF, expedição, 3D)', () => {
    const packs = [big, big, half, kit, kit]
    expect(describeKitBoxes(kitBoxLines(packs))).toBe('2 × caixa 79583 (26 kits) + 1 × meia caixa (10 kits) + 2 × caixa individual')
  })
})

describe('caixas de kits: estimativa da camada por cima do palete', () => {
  it('altura: uma camada de 250 mm até 4 quartos de 570 × 570; só individuais = 200 mm', () => {
    expect(kitLayerEstimate(52, kit).h).toBe(250)
    // 36: para planejar vale a regra de sempre (26 + 10, 250 mm); a caixa 69488 (400 mm) entra quando couber
    expect(kitLayerEstimate(36, kit).h).toBe(250)
    expect(kitLayerEstimate(26, kit).h).toBe(250)
    expect(kitLayerEstimate(104, kit).h).toBe(500)
    expect(kitLayerEstimate(53, kit).h).toBe(450)
    expect(kitLayerEstimate(12, kit).h).toBe(200) // 12 individuais
    expect(kitLayerEstimate(13, kit).h).toBe(250) // 1 meia caixa
    expect(kitLayerEstimate(9, kit).h).toBe(200)
    expect(kitLayerEstimate(0, kit)).toEqual({ h: 0, kg: 0, boxes: 0 })
  })
  it('peso inclui a tara das caixas coletivas', () => {
    expect(kitLayerEstimate(52, kit).kg).toBeCloseTo(110.4, 6)
    // 36 (planejamento) = caixa de 26 (52 + 3,2 kg) + 10 individuais (10 × 2 kg)
    expect(kitLayerEstimate(36, kit).kg).toBeCloseTo(55.2 + 20, 6)
    expect(kitLayerEstimate(36, kit).boxes).toBe(11)
    // 34 = caixa de 26 (52 + 3,2 kg) + 8 individuais (8 × 2 kg)
    expect(kitLayerEstimate(34, kit).kg).toBeCloseTo(55.2 + 16, 6)
  })
})
