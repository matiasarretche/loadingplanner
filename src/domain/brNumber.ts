/**
 * Números digitados no FORMATO BRASILEIRO: ponto separa milhares e vírgula separa decimais.
 * "1.800" = 1800 · "1800" = 1800 · "1,8" = 1,8 · "1.8" NÃO existe (inválido, nunca vira 18 nem 1,8).
 */

/** Número no formato brasileiro. Vazio → null; inválido → NaN. */
export function parseBrNumber(v: string | null | undefined): number | null {
  const t = String(v ?? '').trim().replace(/\s+/g, '')
  if (!t) return null
  if (!/^-?\d{1,3}(\.\d{3})*(,\d+)?$/.test(t) && !/^-?\d+(,\d+)?$/.test(t)) return NaN
  return Number(t.replace(/\./g, '').replace(',', '.'))
}

/**
 * Medida em MILÍMETROS, literal: "1.800" = 1800 mm; "1,8" = 1,8 mm (o campo é em mm). Aceita a unidade
 * escrita: "1,8 m" = 1800 mm, "180 cm" = 1800 mm, "1.800 mm" = 1800 mm. Vazio → null; inválido → NaN.
 */
export function parseMm(v: string | null | undefined): number | null {
  const t = String(v ?? '').trim().toLowerCase()
  if (!t) return null
  const m = /^(.*?)\s*(mm|cm|m)?$/.exec(t)
  const n = parseBrNumber(m?.[1] ?? t)
  if (n == null || Number.isNaN(n)) return NaN
  const unit = m?.[2] ?? 'mm'
  return Math.round((unit === 'm' ? n * 1000 : unit === 'cm' ? n * 10 : n) * 1000) / 1000
}
