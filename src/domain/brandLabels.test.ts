import { describe, expect, it } from 'vitest'
import { brandLabelFor } from './brandLabels'

const id = (sku: string, name = '') => brandLabelFor({ sku, name })?.id ?? null

describe('brandLabelFor', () => {
  it('linhas Pacifil pelo código', () => {
    expect(id('HS-2M-10K', 'Hidrosilo 2 × 10 m × 600 µm — 10.000 L')).toBe('hidrosilo-pacifil')
    expect(id('HF-2M-10K', 'Hidroforce 3 × 5 m')).toBe('hidroforce-pacifil')
    expect(id('AC-PAC-2.3X100-240', 'Techo para ganado 2.3 × 100 m')).toBe('animal-comfort')
    expect(id('SB-PAC-9X60-220', 'Silo-bolsa 9 pés × 60 m × 220 µm (Grano)')).toBe('silobolsa-pacifil')
    expect(id('SB-PAC-10X100-254', 'Silo-bolsa Premium 9 pés × 75 m')).toBe('silobolsa-pacifil')
  })
  it('marcas próprias', () => {
    expect(id('SB-PRO-9X100-218', 'Silo-bolsa 9 pés × 75 m × 244 µm')).toBe('silobolsa-probag')
    expect(id('SB-ECO-10X100-214', 'Silo-bolsa 9 pés × 75 m × 244 µm')).toBe('silobolsa-ecobag')
  })
  it('lonas: BPF e BigSafe pelo nome/sufixo; as demais sem adesivo', () => {
    expect(id('LS-PAC-10X50-125-BPF', 'Lona BPF 8 × 50 m × 125 µm')).toBe('bpf-pacifil')
    expect(id('LS-PAC-16X50-125', 'Lona BigSafe 20 × 50 m × 125 µm')).toBe('bigsafe')
    expect(id('LS-PAC-10X50-125-STD', 'Lona padrão 8 × 50 m × 125 µm')).toBeNull()
    expect(id('LS-PAC-12X31-120-LP', 'Lona Plus 28 × 50 m × 120 µm')).toBeNull()
  })
  it('sem adesivo cadastrado: kit, ADP, Bridon', () => {
    expect(id('KIT-HF', 'Kit Hydroforce (mangueira + camlock + torneira)')).toBeNull()
    expect(id('SB-ADP-9X75-210', 'Silo-bolsa 9 pés × 75 m')).toBeNull()
    expect(id('SB-BRI-10X121.92-312', 'Silo-bolsa 9 pés')).toBeNull()
  })
  it('private label pelo nome', () => {
    expect(id('HS-AGR-10K', 'Hidrosilo Agromai 10.000 L')).toBe('agromai-hidrosilo')
    expect(id('SB-STA-9X60', 'Silo-bolsa STAAL 9 pés')).toBe('silobolsa-staal')
    expect(id('SB-AGM-6X60-180', 'Silo-bolsa Agromai 6 pés × 60 m × 180 µm')).toBe('agromai-silobolsa')
    expect(id('HF-AGM-2M-5K', 'Hidroforce Agromai 2 × 5.5 m × 600 µm — 5000 L')).toBe('agromai-hidroforce')
    // o adesivo Agromai de lona ("Lona para silo") não vale para as bolsas para silagem
    expect(id('BS-AGM-2X3-125-50', 'Bolsa para silagem Agromai 2 × 3 m × 125 µm — caixa c/50 un')).toBeNull()
  })
})

describe('brandLabelFor — códigos antigos', () => {
  it('silo-bolsa sem marca = Pacifil', () => expect(id('SB-9FT', 'Silo-bolsa 9 pés x 60 m - 210 mic')).toBe('silobolsa-pacifil'))
})
