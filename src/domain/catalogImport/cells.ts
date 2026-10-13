/**
 * Conversão das células cruas (texto, número ou vazio) que os leitores das planilhas entregam ao motor.
 * Códigos e EAN são TEXTO: um número da planilha vira o inteiro exato em texto (nunca notação científica).
 */
import type { CellValue } from './types'

/** Texto da célula (trim; espaços internos colapsados); vazio → null. */
export function cellText(v: CellValue | undefined): string | null {
  if (v == null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null
  const t = String(v).replace(/\s+/g, ' ').trim()
  return t ? t : null
}

/**
 * Número da célula. Texto aceita vírgula decimal ("55,9") e ponto decimal ("55.9"); com os dois, o
 * formato brasileiro ("1.234,5"). Vazio ou inválido → null. Ruído binário limpo (máx. 6 decimais).
 */
export function cellNumber(v: CellValue | undefined): number | null {
  if (v == null) return null
  let n: number
  if (typeof v === 'number') n = v
  else {
    let t = String(v).replace(/\s+/g, '').trim()
    if (!t) return null
    if (t.includes(',') && t.includes('.')) t = t.replace(/\./g, '').replace(',', '.')
    else t = t.replace(',', '.')
    if (!/^-?\d+(\.\d+)?$/.test(t)) return null
    n = Number(t)
  }
  if (!Number.isFinite(n)) return null
  return Math.round(n * 1e6) / 1e6
}

/**
 * Código / EAN como texto exato: número inteiro → dígitos (EAN e GTIN-14 cabem no inteiro seguro, então
 * nada se perde); texto → trim (sem mudar mais nada). Número com decimais → o texto do número, que o
 * motor marca como inválido.
 */
export function cellDigits(v: CellValue | undefined): string | null {
  if (v == null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null
  const t = String(v).trim()
  return t ? t : null
}
