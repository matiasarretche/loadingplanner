import { describe, expect, it } from 'vitest'
import { palletDisplayName, plannerPalletName } from './mixedLoad'
import type { PalletDoc } from './types'

/** palete só com o que o nome usa: os packs (SKU e acompanhantes) */
const pal = (packs: { sku: string; companions?: { sku: string; qty: number }[] }[]): PalletDoc => ({ name: '', packs: Object.fromEntries(packs.map((p, i) => [`p${i}`, p])) }) as unknown as PalletDoc

describe('nome dos paletes do planejador', () => {
  it('palete de um produto só leva o código do produto (sem "Misto" nem número)', () => {
    expect(plannerPalletName(pal([{ sku: 'HS-2M-50K' }]), 5)).toBe('HS-2M-50K')
  })

  it('acompanhantes obrigatórios (KIT-HF) não fazem o palete misto', () => {
    expect(plannerPalletName(pal([{ sku: 'HF-2M-10K', companions: [{ sku: 'KIT-HF', qty: 1 }] }, { sku: 'KIT-HF' }]), 2)).toBe('HF-2M-10K + KIT-HF')
  })

  it('mais de um produto: "Misto N · A+B"', () => {
    expect(plannerPalletName(pal([{ sku: 'HS-2M-10K' }, { sku: 'HS-2M-20K' }]), 3)).toBe('Misto 3 · HS-2M-10K+HS-2M-20K')
  })

  it('cargas antigas: "Misto N · …" é recalculado pelo conteúdo; mistos de verdade e outros nomes não mudam', () => {
    expect(palletDisplayName({ ...pal([{ sku: 'HS-2M-50K' }]), name: 'Misto 5 · HS-2M-50K' })).toBe('HS-2M-50K')
    expect(palletDisplayName({ ...pal([{ sku: 'HF-2M-50K', companions: [{ sku: 'KIT-HF', qty: 1 }] }, { sku: 'KIT-HF' }]), name: 'Misto 1 · HF-2M-50K+KIT-HF' })).toBe('HF-2M-50K + KIT-HF')
    expect(palletDisplayName({ ...pal([{ sku: 'HS-2M-10K' }, { sku: 'HS-2M-20K' }]), name: 'Misto 3 · HS-2M-10K+HS-2M-20K' })).toBe('Misto 3 · HS-2M-10K+HS-2M-20K')
    expect(palletDisplayName({ ...pal([{ sku: 'HF-10K' }]), name: 'REF · HF-10K · 26 u' })).toBe('REF · HF-10K · 26 u')
  })
})
