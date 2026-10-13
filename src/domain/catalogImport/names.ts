/**
 * Nomes no formato atual do catálogo (decisão 6), com decimais pt-BR:
 *   "Silo-bolsa 9 pés × 60 m × 210 µm", "Silo-bolsa Ecobag 9 pés × 75 m × 200 µm", "Lona BPF 8 × 50 m × 125 µm",
 *   "Lona BigSafe 16 × 50 m × 125 µm", "Hidrosilo 2 × 10 m × 600 µm — 10.000 L"…
 * As lonas começam com a linha ("Lona padrão" / "Lona BPF" / "Lona Plus"…) — a regra comercial das lonas
 * (domain/lonaRule) lê a linha e a largura do nome; os silo-bolsas trazem "N pés" (diameterFtOf).
 */
import type { OfficialProduct } from './classify'
import type { ImportDecisions } from './decisions'
import { round } from './parseProduct'

/** Número pt-BR sem zeros à direita: 8.4 → "8,4"; 152.4 → "152,4". */
export const fmtNum = (n: number, decimals = 3) => String(round(n, decimals)).replace('.', ',')
/** Milhar com ponto: 10000 → "10.000". */
export const fmtThousands = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')

const ACCENTS: Record<string, string> = { media: 'média', poliamida: 'poliamida' }
const tagText = (t: string) => {
  const l = t.toLowerCase().replace(/\s+/g, ' ').trim()
  return ACCENTS[l] ?? l
}
const thTxt = (p: OfficialProduct) => (p.thicknessUm ? ` × ${p.thicknessUm} µm` : '')
const packTxt = (p: OfficialProduct) => (p.unitsPerPack ? ` — c/${p.unitsPerPack} un` : '')
const brandSfx = (p: OfficialProduct, prefix: string) => (p.brand && p.brand !== 'Pacifil' && !prefix.toLowerCase().includes(p.brand.toLowerCase()) ? ` ${p.brand}` : '')

/** "8 × 50 m" ou, em pés, "12,19 × 60,96 m (40 × 200 pés)". */
function sheetDims(p: OfficialProduct): string {
  const w = p.widthM ?? 0
  const l = p.lengthM ?? 0
  if (p.imperial || p.lengthFt != null) {
    const ft = p.widthFt != null ? `${fmtNum(p.widthFt)} × ${fmtNum(p.lengthFt ?? l / 0.3048, 1)} pés` : null
    return `${fmtNum(w, 2)} × ${fmtNum(l, 2)} m${ft ? ` (${ft})` : ''}`
  }
  return `${fmtNum(w)} × ${fmtNum(l)} m`
}

export function productName(p: OfficialProduct, d: ImportDecisions): string {
  const spec = d.lines[p.lineKey]
  const prefix = spec.namePrefix
  const tags = p.tags.map(tagText)
  switch (p.kind) {
    case 'SILO_BAG': {
      const len = p.lengthFt != null ? `${fmtNum(p.lengthFt)} pés (${fmtNum(p.lengthM ?? 0, 1)} m)` : `${fmtNum(p.lengthM ?? 0)} m`
      const tail = [p.subLine, ...tags].filter(Boolean)
      return `${prefix}${brandSfx(p, prefix)} ${fmtNum(p.diameterFt ?? 0)} pés × ${len}${thTxt(p)}${tail.length ? ` (${tail.join(', ')})` : ''}`
    }
    case 'TARP':
    case 'FILM_ROLL':
      return `${prefix}${brandSfx(p, prefix)} ${sheetDims(p)}${thTxt(p)}${p.color ? ` ${p.color.toLowerCase()}` : ''}${tags.length ? ` (${tags.join(', ')})` : ''}${packTxt(p)}`
    case 'HIDROSILO':
    case 'HYDROFORCE': {
      const film = p.widthBasis === 'FILM_WIDTH' && p.filmWidthM ? ` (filme ${fmtNum(p.filmWidthM)} m)` : ''
      return `${prefix}${brandSfx(p, prefix)} ${sheetDims(p)}${thTxt(p)}${p.capacityL ? ` — ${fmtThousands(p.capacityL)} L` : ''}${p.valves ? ` ${p.valves}V` : ''}${film}${packTxt(p)}`
    }
    case 'HIDROPESO':
      return `${prefix}${brandSfx(p, prefix)} ${sheetDims(p)}${thTxt(p)}`
    case 'SILAGE_BAG_BOX':
      return `${prefix}${brandSfx(p, prefix)} ${sheetDims(p)}${thTxt(p)}${p.unitsPerPack ? ` — caixa c/${p.unitsPerPack} un` : ''}`
    case 'TAPE_PE':
    case 'TAPE_PE_BOX': {
      const base = p.kind === 'TAPE_PE_BOX' ? prefix.replace(/^Fita /, 'Caixa de fitas ') : prefix
      const len = p.lengthM != null ? `${fmtNum(p.lengthM)} m` : p.lengthCm != null ? `${fmtNum(p.lengthCm)} cm` : ''
      return `${base}${brandSfx(p, base)} ${fmtNum(p.widthCm ?? 0)} cm × ${len}${p.color ? ` ${p.color.toLowerCase()}` : ''}${packTxt(p)}`
    }
    case 'TAPE_BUTYL':
    case 'TAPE_BUTYL_BOX':
    case 'REPAIR_PATCH_PVC': {
      const base = p.kind === 'TAPE_BUTYL_BOX' ? prefix.replace(/^Fita /, 'Caixa de fitas ') : prefix
      const b = p.lengthCm != null ? `${fmtNum(p.lengthCm)} cm` : p.lengthM != null ? `${fmtNum(p.lengthM)} m` : ''
      return `${base}${brandSfx(p, base)} ${fmtNum(p.widthCm ?? 0)} × ${b}${packTxt(p)}`
    }
  }
}
