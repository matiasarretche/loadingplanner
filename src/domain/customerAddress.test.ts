import { describe, expect, it } from 'vitest'
import { addressPart, customerLabel, customerSearch, formatCustomerAddress } from './customerAddress'

describe('endereço do cliente em uma linha', () => {
  it('Montevidéu: marcador ".." do ERP some; estado igual à cidade não se repete', () => {
    expect(formatCustomerAddress({ address: 'CAMINO DEL JEFE 2520', district: '..', postalCode: '12400', city: 'MONTEVIDEO', state: 'Montevideo', country: 'Uruguai' })).toBe('CAMINO DEL JEFE 2520, 12400 MONTEVIDEO')
  })
  it('Póvoa de Santa Iria: complemento que já está na rua não se repete; CEP antes da cidade', () => {
    expect(
      formatCustomerAddress({ address: 'RUA FERNANDO BARROS FERREIRA LEAL,5/LJ1', addressComplement: 'LJ1', district: '..', postalCode: '2625-186', city: 'Póvoa de Santa Iria', state: 'Lisboa', country: 'Portugal' }),
    ).toBe('RUA FERNANDO BARROS FERREIRA LEAL,5/LJ1, 2625-186 Póvoa de Santa Iria, Lisboa')
  })
  it('Miami FL 33172: nos EUA o código postal vem depois do estado', () => {
    const c = { address: '7500 NW 25TH ST', addressComplement: 'SUITE 237', city: 'MIAMI', state: 'FL', postalCode: '33172', country: 'Estados Unidos' }
    expect(formatCustomerAddress(c)).toBe('7500 NW 25TH ST, SUITE 237, MIAMI, FL 33172')
    expect(formatCustomerAddress(c, { withCountry: true, lang: 'en' })).toBe('7500 NW 25TH ST, SUITE 237, MIAMI, FL 33172, United States')
  })
  it('Bogotá: rua, complemento, bairro, CEP cidade, estado', () => {
    expect(formatCustomerAddress({ address: 'AV CALLE 26 # 68C-61', addressComplement: 'OF 501', district: 'Salitre', postalCode: '111071', city: 'Bogotá', state: 'Bogotá D.C.', country: 'Colômbia' })).toBe(
      'AV CALLE 26 # 68C-61, OF 501, Salitre, 111071 Bogotá, Bogotá D.C.',
    )
  })
  it('CEP e estado que o ERP deixou dentro da cidade não se repetem', () => {
    expect(formatCustomerAddress({ address: '123 MAIN ST', city: 'HOUSTON TX 77033', state: 'TX', postalCode: '77033', country: 'Estados Unidos' })).toBe('123 MAIN ST, HOUSTON TX 77033')
  })
  it('sem nada além de marcadores → vazio; partes que faltam não deixam vírgulas soltas', () => {
    expect(formatCustomerAddress({ address: '..,..', addressComplement: '..', district: '...', city: '.', country: 'Canadá' })).toBe('')
    expect(formatCustomerAddress({})).toBe('')
    expect(formatCustomerAddress({ city: 'Managua', country: 'Nicarágua' })).toBe('Managua')
    expect(formatCustomerAddress({ postalCode: '90100', city: 'MACHAKOS', country: 'Quênia' })).toBe('MACHAKOS 90100')
  })
  it('país opcional, no idioma do documento, sem repetir', () => {
    const c = { address: 'CAMINO DEL JEFE 2520', city: 'Montevideo', country: 'Uruguai' }
    expect(formatCustomerAddress(c, { withCountry: true })).toBe('CAMINO DEL JEFE 2520, Montevideo, Uruguai')
    expect(formatCustomerAddress(c, { withCountry: true, lang: 'es' })).toBe('CAMINO DEL JEFE 2520, Montevideo, Uruguay')
    expect(formatCustomerAddress({ address: 'CALLE 50', city: 'PANAMA', country: 'Panamá' }, { withCountry: true })).toBe('CALLE 50, PANAMA')
    // cidade colombiana com nome de país não é confundida
    expect(formatCustomerAddress({ city: 'ARMENIA', country: 'Colômbia' }, { withCountry: true })).toBe('ARMENIA, Colômbia')
  })
  it('uma linha, até 300 caracteres', () => {
    const r = formatCustomerAddress({ address: `RUA ${'X'.repeat(280)}`, addressComplement: 'BLOCO 2\nAPTO 3', city: 'Montevideo' })
    expect(r.length).toBeLessThanOrEqual(300)
    expect(r).not.toMatch(/\n|,$/)
  })
  it('limpeza de cada parte', () => {
    expect(addressPart('  ..  ')).toBe('')
    expect(addressPart('2625-')).toBe('2625')
    expect(addressPart(' S/N ')).toBe('S/N')
    expect(addressPart(null)).toBe('')
  })
})

describe('seletor de clientes', () => {
  const cs = [
    { id: 1, name: 'AGROPECUARIA EL SOL', code: '609', city: 'Salto', country: 'Uruguai' },
    { id: 2, name: 'HENDERSON & CIA S/A', code: '1421', city: 'Montevideo', country: 'Uruguai' },
    { id: 3, name: 'HENDERSON & CIA S/A', code: '9839', city: 'Montevideo', country: 'Uruguai' },
    { id: 4, name: 'PLASTICOS LA UNION', code: '3056', city: 'Bogotá', country: 'Colômbia' },
    { id: 5, name: 'SOL AGRO', code: null, city: null, country: 'Paraguai' },
    { id: 6, name: 'TRIPLE P FEEDS', code: '6090', city: 'Lodi', country: 'Estados Unidos' },
  ]
  it('rótulo: razão social — cidade, país · código', () => {
    expect(customerLabel(cs[1])).toBe('HENDERSON & CIA S/A — Montevideo, Uruguai · cód. 1421')
    expect(customerLabel(cs[4])).toBe('SOL AGRO — Paraguai')
    expect(customerLabel({ name: 'Novo' })).toBe('Novo')
  })
  it('busca por parte do nome, cidade, país ou código (sem acento/caixa)', () => {
    const search = customerSearch(cs)
    expect(search('hend').map((c) => c.id)).toEqual([2, 3])
    expect(search('bogota').map((c) => c.id)).toEqual([4])
    expect(search('plast union').map((c) => c.id)).toEqual([4])
    expect(search('paraguai').map((c) => c.id)).toEqual([5])
    expect(search('9839').map((c) => c.id)).toEqual([3])
    expect(search('   ')).toHaveLength(cs.length)
    expect(search('xyz')).toEqual([])
  })
  it('código exato primeiro, depois nome que começa com o texto', () => {
    const search = customerSearch(cs)
    expect(search('609').map((c) => c.id)).toEqual([1, 6])
    expect(search('sol').map((c) => c.id)).toEqual([5, 1])
  })
  it('250+ clientes: índice montado uma vez, busca rápida', () => {
    const many = Array.from({ length: 3000 }, (_, i) => ({ id: i, name: `CLIENTE ${i} AGRO`, code: String(1000 + i), city: i % 2 ? 'Montevideo' : 'Asunción', country: 'Uruguai' }))
    const search = customerSearch(many)
    const t0 = performance.now()
    for (let k = 0; k < 20; k++) search(`agro ${k}`)
    expect(performance.now() - t0).toBeLessThan(500)
    expect(search('1999')[0].id).toBe(999)
  })
})
