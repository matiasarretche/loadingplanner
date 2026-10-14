/**
 * Leitura dos textos da planilha de produtos: espessura (coluna D) e medidas (coluna C).
 * Porta de scratchpad/catalog-analysis/scripts/normalize.js (validado nas 667 linhas da planilha).
 */
import { PE_DENSITY_KG_M3 } from '@/domain/siloPerimeter'

export const FT_M = 0.3048
export const MIL_UM = 25.4
/** densidade do filme de PE (kg/m³): 0,932 g/cm³, a mesma de todos os produtos Pacifil (domain/siloPerimeter) */
export const PE_DENSITY = PE_DENSITY_KG_M3

export const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d
const dec = (s: string) => parseFloat(s.replace(',', '.'))

export interface ParsedThickness {
  thicknessUm: number | null
  unit: 'MIC' | 'MIL' | 'GAUGE' | null
  value: number | null
  /** a coluna D traz a cor (fitas), não a espessura */
  color: string | null
  /** acabamentos entre parênteses ou escritos: NATURAL, POLIAMIDA, C/ DESLIZANTE, CILINDRO GOFRADO, MEDIA… */
  tags: string[]
  notes: string[]
}

const TAG_RE = /\(([^)]+)\)|C\/\s*DESLIZANTE|S\/\s*DESLIZANTE|CILINDRO\s+GOFRADO|CILINDRO\s+LISO|\/\s*MEDIA/g

/** Espessura: "125 MICRAS", "150MIC (NATURAL)", "10MIL", "10MILL", "2.362 GAUGE", "BRANCA"… */
export function parseThickness(raw: string | null): ParsedThickness {
  const out: ParsedThickness = { thicknessUm: null, unit: null, value: null, color: null, tags: [], notes: [] }
  if (!raw) return out
  let t = raw.toUpperCase().replace(/\s+/g, ' ').trim()
  if (/^(BRANCA|TRANSPARENTE)/.test(t)) {
    out.color = t
    return out
  }
  for (const m of t.matchAll(TAG_RE)) out.tags.push((m[1] || m[0]).replace(/\s+/g, ' ').replace(/^\/\s*/, '').trim())
  t = t.replace(TAG_RE, ' ').replace(/\s+/g, ' ').trim()
  let m: RegExpExecArray | null
  if ((m = /^(\d+(?:[.,]\d+)?)\s*(MIC|MICRAS)\b/.exec(t))) {
    out.value = dec(m[1])
    out.unit = 'MIC'
    out.thicknessUm = Math.round(out.value)
  } else if ((m = /^(\d+(?:[.,]\d+)?)\s*MILL?\b/.exec(t))) {
    out.value = dec(m[1])
    out.unit = 'MIL'
    out.thicknessUm = Math.round(out.value * MIL_UM)
    out.notes.push(`${m[0].trim()} = ${out.thicknessUm} µm (milésimos de polegada)`)
  } else if ((m = /^(\d[\d.,]*)\s*GAUGE\b/.exec(t))) {
    // "2.362 GAUGE": ponto de milhar → 2362 gauge = 23,62 mil ≈ 600 µm (lido literalmente seria 0,6 µm)
    const g = parseFloat(m[1].replace(/\./g, '').replace(',', '.'))
    out.value = g
    out.unit = 'GAUGE'
    out.thicknessUm = Math.round((g / 100) * MIL_UM)
    out.notes.push(`"${m[0].trim()}" lido como ${g} gauge ≈ ${out.thicknessUm} µm (ponto = separador de milhar)`)
  } else out.notes.push(`espessura "${raw}" não reconhecida`)
  const rest = t.replace(/^(\d[\d.,]*)\s*(MICRAS|MIC|MILL|MIL|GAUGE)\b/, '').trim()
  if (rest && out.thicknessUm != null) out.notes.push(`sobra no texto da espessura: "${rest}"`)
  return out
}

export interface MeasureDims {
  kind: 'CM' | 'FT' | 'M'
  a: number
  aUnit: 'cm' | 'ft' | 'm'
  b: number
  bUnit: 'cm' | 'ft' | 'm'
}

export interface ParsedMeasure {
  /** texto antes das medidas ("BPF", "BIGSAFE PLUSX3", "BPT"…) */
  prefix: string | null
  /** texto depois das medidas ("ECOBAG 110", "B/P"…) */
  suffix: string | null
  /** "C/ n UN": pacote com n unidades (pesos da linha = do pacote) */
  unitsPerPack: number | null
  /** "10.000L" */
  capacityL: number | null
  /** "4V" */
  valves: number | null
  dims: MeasureDims | null
  notes: string[]
}

/**
 * Primeira ocorrência de `re` (com flag g) que NÃO começa logo depois de um dígito, ponto ou vírgula
 * (o mesmo que o lookbehind `(?<![\d.,])`, que não usamos para manter o alvo ES2017).
 */
function execNotAfterNumber(re: RegExp, s: string): RegExpExecArray | null {
  re.lastIndex = 0
  for (;;) {
    const m = re.exec(s)
    if (!m) return null
    if (m.index > 0 && /[\d.,]/.test(s[m.index - 1])) {
      re.lastIndex = m.index + 1
      continue
    }
    return m
  }
}

const NUM = '(\\d+(?:[.,]\\d+)?)'
const DIM_RES: { kind: MeasureDims['kind']; re: RegExp }[] = [
  { kind: 'CM', re: new RegExp(`${NUM}\\s*CM\\s*X\\s*${NUM}\\s*(CM|M)\\b`, 'g') },
  { kind: 'FT', re: new RegExp(`${NUM}\\s*PES\\s*X\\s*${NUM}\\s*(PES|M)\\b`, 'g') },
  { kind: 'M', re: new RegExp(`${NUM}\\s*(M?)\\s*X\\s*${NUM}\\s*(M?)(?![\\w])`, 'g') },
]

/** Medidas: "9PESX75M", "12PESX500PES", "BPF 8X50 ECOBAG 110", "2MX10M 10.000L", "4,3MX20M 4V", "41CM X 5M C/ 10 UN"… */
export function parseMeasure(raw: string): ParsedMeasure {
  const p: ParsedMeasure = { prefix: null, suffix: null, unitsPerPack: null, capacityL: null, valves: null, dims: null, notes: [] }
  let s = raw.toUpperCase().replace(/\s+/g, ' ').trim()
  let m: RegExpExecArray | null
  if ((m = /C\/\s*(\d+)\s*(UNI|UN|U)\b/.exec(s))) {
    p.unitsPerPack = Number(m[1])
    s = s.replace(m[0], ' ')
  }
  if ((m = execNotAfterNumber(/(\d{1,3}(?:\.\d{3})+|\d+)\s*L\b/g, s))) {
    p.capacityL = Number(m[1].replace(/\./g, ''))
    s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)
  }
  if ((m = /\b(\d)V\b/.exec(s))) {
    p.valves = Number(m[1])
    s = s.replace(m[0], ' ')
  }
  s = s.replace(/\s+/g, ' ').trim()
  for (const { kind, re } of DIM_RES) {
    m = execNotAfterNumber(re, s)
    if (!m) continue
    if (kind === 'CM') p.dims = { kind, a: dec(m[1]), aUnit: 'cm', b: dec(m[2]), bUnit: m[3] === 'CM' ? 'cm' : 'm' }
    else if (kind === 'FT') p.dims = { kind, a: dec(m[1]), aUnit: 'ft', b: dec(m[2]), bUnit: m[3] === 'PES' ? 'ft' : 'm' }
    else p.dims = { kind, a: dec(m[1]), aUnit: 'm', b: dec(m[3]), bUnit: 'm' }
    p.prefix = s.slice(0, m.index).trim() || null
    p.suffix = s.slice(m.index + m[0].length).trim() || null
    break
  }
  if (!p.dims) p.notes.push(`medidas não reconhecidas em "${raw}"`)
  return p
}

/**
 * Linha escrita na medida (prefixo + sufixo, sem marca nem espessura): "BIGSAFE PLUSX3", "BPF B/P", "BPT"…
 * Grafias unificadas: BIGSILOPLUSX3 / BIGSILO PLUSX3 / BPF PLUS X3.
 */
export function lineTextOf(pm: ParsedMeasure): string | null {
  const parts = [pm.prefix, pm.suffix]
    .filter(Boolean)
    .join(' ')
    .replace(/\b(ECOBAG|PROBAG)\s*\d*/g, '')
    .replace(/\b\d{2,3}$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return parts ? parts.replace(/^(BIGSILO|BIGSAFE)\s*PLUS\s*X3/, '$1 PLUSX3').replace(/^BPF PLUS X3/, 'BPF PLUSX3') : null
}
