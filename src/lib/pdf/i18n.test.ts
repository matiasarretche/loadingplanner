import { describe, expect, it } from 'vitest'
import { courierPlan } from '@/domain/courier'
import { pack } from '@/domain/fixtures'
import { kitOrderLines } from '@/domain/kitBoxes'
import { defaultPdfLang, pdfText } from './i18n'

describe('textos dos PDFs: caixas de kits no idioma do documento', () => {
  const kit = pack({ sku: 'KIT-HF', name: 'Kit Hydroforce', packagingVersionId: 155, dims: { l: 200, w: 200, h: 200 }, grossKg: 2, netKg: 2 })
  it('lista de volumes do courier: o tipo da caixa traduzido (nunca em português no PDF em inglês/espanhol)', () => {
    const rows = courierPlan(kitOrderLines(kit, 'pv155', 39)).rows
    expect(rows.map((r) => (r.kitBox ? pdfText('en').kitBox(r.kitBox) : null))).toEqual(['box 79583 (26 kits)', 'half box (13 kits)'])
    expect(rows.map((r) => (r.kitBox ? pdfText('es').kitBox(r.kitBox) : null))).toEqual(['caja 79583 (26 kits)', 'media caja (13 kits)'])
    expect(rows.map((r) => (r.kitBox ? pdfText('pt').kitBox(r.kitBox) : null))).toEqual(['caixa 79583 (26 kits)', 'meia caixa (13 kits)'])
  })
})

describe('idioma sugerido pelo destino (defaultPdfLang)', () => {
  it('pelo nome que o sistema grava (pt-BR canônico), outras grafias e código ISO', () => {
    expect(defaultPdfLang('Porto Rico')).toBe('es')
    expect(defaultPdfLang('Puerto Rico')).toBe('es')
    expect(defaultPdfLang('PR')).toBe('es')
    expect(defaultPdfLang('Guiné Equatorial')).toBe('es')
    expect(defaultPdfLang('Uruguai')).toBe('es')
    expect(defaultPdfLang('República Dominicana')).toBe('es')
    expect(defaultPdfLang('Espanha')).toBe('es')
    expect(defaultPdfLang('Brasil')).toBe('pt')
    expect(defaultPdfLang('BR')).toBe('pt')
    expect(defaultPdfLang('Estados Unidos')).toBe('en')
    expect(defaultPdfLang('Etiópia')).toBe('en')
    // demais países (inclusive os de língua portuguesa): inglês, como documentado
    expect(defaultPdfLang('Angola')).toBe('en')
  })

  it('texto livre e vazio', () => {
    expect(defaultPdfLang('Montevideo, Uruguay')).toBe('es')
    expect(defaultPdfLang('San Juan, Porto Rico')).toBe('es')
    expect(defaultPdfLang('Santos, Brasil')).toBe('pt')
    expect(defaultPdfLang('')).toBe('pt')
    expect(defaultPdfLang(null)).toBe('pt')
  })
})
