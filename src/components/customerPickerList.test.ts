import { describe, expect, it } from 'vitest'
import { MAX_SHOWN, pickerList } from './customerPickerList'

const many = Array.from({ length: 250 }, (_, i) => ({ id: i + 1, name: `CLIENTE ${String(i + 1).padStart(3, '0')}` }))
const byId = new Map(many.map((c) => [c.id, c]))

describe('lista do seletor de clientes', () => {
  it('sem busca, o cliente escolhido fora dos primeiros 60 aparece (e o índice dele existe para o destaque)', () => {
    const sel = byId.get(200)!
    const l = pickerList(many, { query: '', byId, selected: sel })
    expect(l.shown[0]).toBe(sel)
    expect(l.shown.length).toBe(MAX_SHOWN + 1)
    expect(l.items.findIndex((c) => c?.id === 200)).toBe(1)
    expect(l.hidden).toBe(250 - MAX_SHOWN - 1)
  })
  it('escolhido já entre os primeiros: não se repete nem muda de lugar', () => {
    const l = pickerList(many, { query: '', byId, selected: byId.get(3)! })
    expect(l.shown.length).toBe(MAX_SHOWN)
    expect(l.items.filter((c) => c?.id === 3)).toHaveLength(1)
    expect(l.items.findIndex((c) => c?.id === 3)).toBe(3)
  })
  it('com busca, só os resultados (sem grupos do topo nem o escolhido forçado)', () => {
    const r = [byId.get(10)!, byId.get(100)!]
    const l = pickerList(r, { query: '10', byId, selected: byId.get(200)!, featured: [{ label: 'X', ids: [5] }] })
    expect(l.groups).toEqual([])
    expect(l.items).toEqual([null, ...r])
  })
  it('busca sem resultado: só a opção "novo cliente"', () => {
    expect(pickerList([], { query: 'zzz', byId, selected: null }).items).toEqual([null])
  })
  it('grupos do topo: homônimos e parecidos separados, sem repetir cliente nem grupo vazio, e fora de "Cadastrados"', () => {
    const l = pickerList(many, {
      query: '',
      byId,
      selected: null,
      featured: [
        { label: 'Mesmo nome do pedido', ids: [7, 8] },
        { label: 'Vazio', ids: [999] },
        { label: 'Parecidos com o do pedido', ids: [8, 9] },
      ],
    })
    expect(l.groups.map((g) => [g.label, g.items.map((c) => c.id)])).toEqual([
      ['Mesmo nome do pedido', [7, 8]],
      ['Parecidos com o do pedido', [9]],
    ])
    expect(l.items.slice(0, 4).map((c) => c?.id ?? null)).toEqual([null, 7, 8, 9])
    expect(l.shown.some((c) => [7, 8, 9].includes(c.id))).toBe(false)
  })
})
