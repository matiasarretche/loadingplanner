/**
 * Geometria das vistas do PDF de expedição (puro, sem pdf-lib — testável): ordem de desenho das
 * vistas laterais, posição do rótulo na parte VISÍVEL de cada unidade e tamanho de texto que cabe.
 * Medidas em mm do equipamento (x = 0 na frente/norte; y = 0 no oeste; z = altura).
 */
import type { ExpeditionRow } from '@/domain/expedition'

export type ViewSide = 'OESTE' | 'LESTE'

/** distância até quem olha de fora pelo lado indicado (menor = mais perto) */
export const viewDepth = (r: ExpeditionRow, side: ViewSide, W: number) => (side === 'OESTE' ? (r.y0 + r.y1) / 2 : W - (r.y0 + r.y1) / 2)

/** ordem de desenho: do fundo para a frente de quem olha (o que está mais perto tapa o de trás) */
export function sideViewOrder(rows: ExpeditionRow[], side: ViewSide, W: number): ExpeditionRow[] {
  return [...rows].sort((a, b) => viewDepth(b, side, W) - viewDepth(a, side, W))
}

/**
 * Centro do rótulo (x, z em mm) dentro da unidade e FORA de tudo o que está na frente dela nessa
 * vista; o mais perto possível do centro da unidade. null = nenhum lugar livre (unidade escondida).
 * `textW`/`textH` = tamanho do rótulo em mm.
 */
export function labelSpot(r: ExpeditionRow, rows: ExpeditionRow[], side: ViewSide, W: number, textW: number, textH: number): { x: number; z: number } | null {
  const x0 = r.x0, x1 = r.x1, z0 = r.z0, z1 = r.z0 + r.height
  if (textW > x1 - x0 || textH > z1 - z0) return null
  const d = viewDepth(r, side, W)
  const front = rows.filter((b) => b !== r && viewDepth(b, side, W) < d - 1 && b.x0 < x1 && x0 < b.x1 && b.z0 < z1 && z0 < b.z0 + b.height)
  const N = 12
  const cands: { x: number; z: number; dist: number }[] = []
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const x = x0 + textW / 2 + ((x1 - x0 - textW) * i) / N
      const z = z0 + textH / 2 + ((z1 - z0 - textH) * j) / N
      cands.push({ x, z, dist: Math.hypot(x - (x0 + x1) / 2, z - (z0 + z1) / 2) })
    }
  }
  cands.sort((a, b) => a.dist - b.dist)
  const t = 0.5
  for (const c of cands) {
    const lx0 = c.x - textW / 2, lx1 = c.x + textW / 2, lz0 = c.z - textH / 2, lz1 = c.z + textH / 2
    if (!front.some((b) => b.x0 < lx1 - t && lx0 + t < b.x1 && b.z0 < lz1 - t && lz0 + t < b.z0 + b.height)) return { x: c.x, z: c.z }
  }
  return null
}

/**
 * Maior tamanho de texto (até `max`, nunca abaixo de 4 pt) cuja largura cabe em `ww` (com 1 pt de
 * folga) e cuja altura cabe em `hh`. null = não cabe nem com 4 pt.
 */
export function fitSize(widthAt: (size: number) => number, ww: number, hh: number, max: number): number | null {
  let fs = Math.min(max, hh * 0.45)
  if (fs < 4) return null
  while (fs > 4 && widthAt(fs) > ww - 2) fs = Math.max(4, fs - 0.5)
  return widthAt(fs) <= ww - 1 ? fs : null
}
