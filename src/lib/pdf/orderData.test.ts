import { describe, expect, it } from 'vitest'
import { buyerPlace } from './orderData'

const miami = { city: 'MIAMI', country: 'Estados Unidos' }
const miamiAddr = '7500 NW 25TH ST, SUITE 237, MIAMI, FL 33172'

describe('cidade e endereço do comprador no PDF', () => {
  it('comprador em Miami, destino Honduras: o país do comprador vai no fim do endereço (idioma do PDF) e a cidade não se repete', () => {
    expect(buyerPlace(miami, { destination: 'Honduras', customerAddress: miamiAddr }, 'en')).toEqual({ city: null, address: `${miamiAddr}, United States` })
    expect(buyerPlace(miami, { destination: 'Honduras', customerAddress: miamiAddr }, 'es')).toEqual({ city: null, address: `${miamiAddr}, Estados Unidos` })
  })
  it('endereço que já termina no país (nome ou sigla): não acrescenta de novo', () => {
    expect(buyerPlace(miami, { destination: 'Honduras', customerAddress: `${miamiAddr}, USA` }, 'en').address).toBe(`${miamiAddr}, USA`)
    expect(buyerPlace(miami, { destination: 'Honduras', customerAddress: `${miamiAddr} - United States` }, 'pt').address).toBe(`${miamiAddr} - United States`)
  })
  it('destino = país do comprador: nada de país; cidade que já está no endereço some', () => {
    expect(buyerPlace({ city: 'MONTEVIDEO', country: 'Uruguai' }, { destination: 'Uruguay', customerAddress: 'CAMINO DEL JEFE 2520, 12400 MONTEVIDEO' }, 'es')).toEqual({ city: null, address: 'CAMINO DEL JEFE 2520, 12400 MONTEVIDEO' })
  })
  it('cidade que não está no endereço (ou só no nome da rua) continua na linha "Cidade"', () => {
    expect(buyerPlace({ city: 'Salto', country: 'Uruguai' }, { destination: 'Uruguai', customerAddress: 'Rua Salto Grande 12' }, 'pt')).toEqual({ city: 'Salto', address: 'Rua Salto Grande 12' })
    expect(buyerPlace({ city: 'Salto', country: 'Uruguai' }, { destination: 'Uruguai', customerAddress: 'Rua Salto Grande 12, Centro' }, 'pt').city).toBe('Salto')
    expect(buyerPlace({ city: 'Salto', country: 'Uruguai' }, { destination: 'Uruguai', customerAddress: 'Rua Uruguay 1200 Salto' }, 'pt').city).toBeNull()
  })
  it('sem endereço: país do comprador junto da cidade; sem cidade nem país, "—"', () => {
    expect(buyerPlace(miami, { destination: 'Honduras' }, 'pt')).toEqual({ city: 'MIAMI, Estados Unidos', address: null })
    expect(buyerPlace({ city: 'Asunción', country: 'Paraguai' }, { destination: 'Paraguai', customerAddress: '' }, 'pt')).toEqual({ city: 'Asunción', address: null })
    expect(buyerPlace({}, { destination: 'Paraguai' }, 'pt')).toEqual({ city: '—', address: null })
  })
})
