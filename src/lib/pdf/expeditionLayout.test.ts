import { describe, expect, it } from 'vitest'
import type { ExpeditionRow } from '@/domain/expedition'
import { fitSize, labelSpot, sideViewOrder } from './expeditionLayout'

const W = 2352
const row = (id: string, x0: number, x1: number, y0: number, y1: number, z0: number, height: number): ExpeditionRow => ({
  order: 0, id, label: id, kind: 'PALLET', carrier: 'PBR', items: [], grossKg: 0, x0, x1, y0, y1, z0, height, side: 'OESTE', rotated: false, stackedOn: null, outside: false, overhang: false,
})

describe('vistas laterais do PDF de expedição', () => {
  it('ordem de desenho: do fundo para perto de quem olha, em cada lado', () => {
    const w = row('w', 0, 1200, 0, 1000, 0, 1000)
    const e = row('e', 0, 1200, 1000, 2000, 0, 1000)
    expect(sideViewOrder([w, e], 'OESTE', W).map((r) => r.id)).toEqual(['e', 'w'])
    expect(sideViewOrder([w, e], 'LESTE', W).map((r) => r.id)).toEqual(['w', 'e'])
  })

  it('unidade totalmente tapada pela da frente: sem rótulo; na vista do outro lado, com rótulo', () => {
    const w = row('w', 0, 1200, 0, 1000, 0, 1000)
    const e = row('e', 0, 1200, 1000, 2000, 0, 1000)
    expect(labelSpot(e, [w, e], 'OESTE', W, 200, 100)).toBeNull()
    expect(labelSpot(e, [w, e], 'LESTE', W, 200, 100)).not.toBeNull()
  })

  it('tapada por DUAS unidades da frente juntas: sem rótulo', () => {
    const back = row('b', 0, 1200, 1000, 2000, 0, 1600)
    const f1 = row('f1', 0, 1200, 0, 1000, 0, 800)
    const f2 = row('f2', 0, 1200, 0, 1000, 800, 800)
    expect(labelSpot(back, [back, f1, f2], 'OESTE', W, 200, 100)).toBeNull()
  })

  it('mais alta que a da frente: rótulo na parte de cima, que aparece', () => {
    const back = row('b', 0, 1200, 1000, 2000, 0, 2000)
    const front = row('f', 0, 1200, 0, 1000, 0, 1200)
    const s = labelSpot(back, [back, front], 'OESTE', W, 200, 100)
    expect(s).not.toBeNull()
    expect(s!.z - 50).toBeGreaterThanOrEqual(1200)
  })

  it('aparece só num trecho (deslocada): rótulo nesse trecho', () => {
    const back = row('b', 600, 1800, 1000, 2000, 0, 1000)
    const front = row('f', 0, 1200, 0, 1000, 0, 1000)
    const s = labelSpot(back, [back, front], 'OESTE', W, 200, 100)
    expect(s).not.toBeNull()
    expect(s!.x - 100).toBeGreaterThanOrEqual(1200)
  })

  it('tamanho do texto: nunca abaixo de 4 pt e encontra o que cabe', () => {
    const widthAt = (s: number) => s * 5 // largura proporcional ao tamanho
    expect(fitSize(widthAt, 100, 40, 9)).toBe(9)
    // 7,3 pt de partida (altura) e só cabe com 4 pt: não pode pular o 4
    expect(fitSize(widthAt, 22, 16.3, 9)).toBe(4)
    expect(fitSize(widthAt, 15, 40, 9)).toBeNull()
    expect(fitSize(widthAt, 100, 6, 9)).toBeNull()
  })
})
