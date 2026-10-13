import { describe, expect, it } from 'vitest'
import { packSnapshot } from '@/lib/snapshots'
import { courierLayout } from './courier'
import { pack } from './fixtures'
import { isRollPack, shapeFromAttrs } from './packShape'

describe('formato do volume (rolo × caixa)', () => {
  it('rolo pelo atributo do catálogo', () => {
    expect(shapeFromAttrs({ formato: 'rolo' })).toBe('ROLL')
    expect(shapeFromAttrs({ formato: ' Rolo ' })).toBe('ROLL')
    expect(shapeFromAttrs({ formato: 'caixa' })).toBeNull()
    expect(shapeFromAttrs({ capacidade_l: 10000 })).toBeNull()
    expect(shapeFromAttrs(null)).toBeNull()
    expect(shapeFromAttrs(undefined)).toBeNull()
  })
  it('códigos numéricos: só o formato decide', () => {
    expect(isRollPack({ sku: '19712', shape: 'ROLL' })).toBe(true)
    expect(isRollPack({ sku: '17308' })).toBe(false)
    expect(isRollPack({ sku: '17308', shape: null })).toBe(false)
  })
  it('snapshots antigos sem formato: lona pelo prefixo LS-', () => {
    expect(isRollPack({ sku: 'LS-PAC-8X50-150-STD' })).toBe(true)
    expect(isRollPack({ sku: 'ls-pac-8x50' })).toBe(true)
    expect(isRollPack({ sku: 'HS-2M-10K' })).toBe(false)
    expect(isRollPack({ sku: 'SB-PAC-9X60-210' })).toBe(false)
  })
  it('snapshot sem formato: lona/filme pelo nome', () => {
    expect(isRollPack({ sku: '19712', name: 'Lona BPF 8 × 50 m × 150 µm (natural)' })).toBe(true)
    expect(isRollPack({ sku: '18054', name: 'Filme BPF 1,5 × 600 m × 40 µm' })).toBe(true)
    expect(isRollPack({ sku: '17308', name: 'Hidrosilo 2 × 10 m × 600 µm — 10.000 L' })).toBe(false)
    expect(isRollPack({ sku: '17994', name: 'Silo-bolsa 9 pés × 100 m × 210 µm' })).toBe(false)
    expect(isRollPack({ sku: '17607', name: 'Bolsa para silagem 2 × 3 m × 125 µm — caixa c/50 un' })).toBe(false)
  })
  it('sem produto', () => {
    expect(isRollPack(null)).toBe(false)
    expect(isRollPack(undefined)).toBe(false)
    expect(isRollPack({})).toBe(false)
  })
})

describe('formato no snapshot e no courier', () => {
  type PV = Parameters<typeof packSnapshot>[0]
  type V = Parameters<typeof packSnapshot>[1]
  const pv = { id: 7, version: 1, packageType: 'Caixa', lengthMm: 1000, widthMm: 600, heightMm: 450, netKg: 55.9, grossKg: 60, unitsPerPackage: 1, allowedOrientations: ['LWH'], stackable: true, maxStackLayers: null, maxStackWeightKg: null, fragile: false, verification: 'ESTIMATED', unitsPerPallet: 12 } as unknown as PV
  const variant = (sku: string, name: string, attrs: Record<string, string | number | null>) => ({ sku, name, attrs, price: null, priceCurrency: 'USD', priceUnit: 'UNIT' }) as unknown as V
  it('lona do catálogo oficial (attrs.formato = rolo) leva shape ROLL; os demais nem têm a chave', () => {
    const lona = packSnapshot(pv, variant('19712', 'Lona BPF 8 × 50 m × 150 µm (natural)', { formato: 'rolo', linha: 'TARP_BPF' }))
    expect(lona.shape).toBe('ROLL')
    expect(isRollPack(lona)).toBe(true)
    const hs = packSnapshot(pv, variant('17308', 'Hidrosilo 2 × 10 m × 600 µm — 10.000 L', { capacidade_l: 10000 }))
    expect('shape' in hs).toBe(false)
    expect(isRollPack(hs)).toBe(false)
  })
  it('courier: cada volume carrega o formato do produto', () => {
    const lines = [
      { packId: 'a', boxes: 2, pack: pack({ sku: '19712', name: 'Lona BPF 8 × 50 m × 150 µm', shape: 'ROLL' }) },
      { packId: 'b', boxes: 1, pack: pack({ sku: '17308', name: 'Hidrosilo 2 × 10 m × 600 µm — 10.000 L' }) },
    ]
    const l = courierLayout(lines)
    expect(l.boxes.map((b) => [b.sku, b.shape ?? null, isRollPack(b)])).toEqual([
      ['19712', 'ROLL', true],
      ['19712', 'ROLL', true],
      ['17308', null, false],
    ])
  })
})
