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

describe('brandLabelFor — códigos oficiais numéricos (linha e marca pelo nome)', () => {
  it('silo-bolsa por marca', () => {
    expect(id('17994', 'Silo-bolsa 9 pés × 100 m × 210 µm')).toBe('silobolsa-pacifil')
    expect(id('19950', 'Silo-bolsa Ecobag 9 pés × 75 m × 200 µm')).toBe('silobolsa-ecobag')
    expect(id('19940', 'Silo-bolsa Probag 9 pés × 75 m × 235 µm')).toBe('silobolsa-probag')
    expect(id('19983', 'Silo-bolsa 12 pés × 500 pés (152,4 m) × 254 µm')).toBe('silobolsa-pacifil')
    expect(id('17303', 'Silo-bolsa 6 pés × 100 m × 160 µm (BPT)')).toBe('silobolsa-pacifil')
  })
  it('reservatórios', () => {
    expect(id('17308', 'Hidrosilo 2 × 10 m × 600 µm — 10.000 L')).toBe('hidrosilo-pacifil')
    expect(id('17657', 'Hidrosilo 2,15 × 50 m × 500 µm — 50.000 L 4V')).toBe('hidrosilo-pacifil')
    expect(id('18098', 'Hidrosilo 2 × 1 m × 600 µm — c/4 un')).toBe('hidrosilo-pacifil')
    expect(id('18074', 'Hidroforce 2 × 10 m × 600 µm — 10.000 L')).toBe('hidroforce-pacifil')
  })
  it('lonas: BPF (Pacifil e Ecobag), BigSafe (também Ecobag); padrão e Plus sem adesivo', () => {
    expect(id('19712', 'Lona BPF 8 × 50 m × 150 µm (natural)')).toBe('bpf-pacifil')
    expect(id('19729', 'Lona BPF Plus X3 10 × 50 m × 125 µm')).toBe('bpf-pacifil')
    expect(id('19867', 'Lona BPF Ecobag 8 × 50 m × 110 µm')).toBe('bpf-ecobag')
    expect(id('17774', 'Lona BigSafe 16 × 50 m × 125 µm')).toBe('bigsafe')
    expect(id('18072', 'Lona BigSafe Ecobag 12 × 50 m × 150 µm')).toBe('bigsafe')
    expect(id('18109', 'Lona BigSafe Plus X3 18 × 50 m × 125 µm')).toBe('bigsafe')
    expect(id('18113', 'Lona BigSafe 2,5 × 50 m × 240 µm')).toBe('bigsafe')
    expect(id('19771', 'Lona padrão 8 × 100 m × 120 µm')).toBeNull()
    expect(id('19894', 'Lona Plus 14 × 50 m × 120 µm')).toBeNull()
    expect(id('19934', 'Lona Big Silo Plus X3 24 × 50 m × 125 µm')).toBeNull()
    // lona Ecobag fora da linha BPF: nunca o adesivo de silo-bolsa Ecobag
    expect(id('99999', 'Lona padrão Ecobag 8 × 50 m × 110 µm')).toBeNull()
  })
  it('sem adesivo: fitas, adesivo de reparo, filmes, hidropeso, bolsa para silagem', () => {
    expect(id('76794', 'Fita de butil 41 × 35 cm')).toBeNull()
    expect(id('17700', 'Fita PE silo-bolsa 21 cm × 5 m branca')).toBeNull()
    expect(id('17712', 'Caixa de fitas PE silo-bolsa 41 cm × 5 m branca — c/10 un')).toBeNull()
    expect(id('17416', 'Adesivo de reparo Hidrosilo em PVC 25 × 25 cm')).toBeNull()
    expect(id('18054', 'Filme BPF 1,5 × 600 m × 40 µm')).toBeNull()
    expect(id('18135', 'Filme BigSafe 8 × 150 m × 50 µm (natural)')).toBeNull()
    expect(id('17751', 'Hidropeso 1,5 × 0,3 m × 500 µm')).toBeNull()
    expect(id('17607', 'Bolsa para silagem 2 × 3 m × 125 µm — caixa c/50 un')).toBeNull()
  })
  it('kit do Hidroforce continua sem adesivo', () => {
    expect(id('KIT-HF', 'Kit Hydroforce (mangueira + camlock + torneira)')).toBeNull()
  })
})

describe('brandLabelFor — códigos antigos', () => {
  it('silo-bolsa sem marca = Pacifil', () => expect(id('SB-9FT', 'Silo-bolsa 9 pés x 60 m - 210 mic')).toBe('silobolsa-pacifil'))
})
