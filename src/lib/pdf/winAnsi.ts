/**
 * Texto para as fontes padrão dos PDFs (Helvetica, codificação WinAnsi). Sem dependências: usado no layout
 * dos PDFs (servidor e navegador) e nos formulários que avisam o que não vai aparecer no documento.
 */

/** controles C1 (texto CP1252 lido como Latin-1, ex.: colado do Word/Excel) → o caractere pretendido */
const C1: Record<string, string> = { '\x80': '€', '\x85': '…', '\x91': '‘', '\x92': '’', '\x93': '"', '\x94': '"', '\x95': '•', '\x96': '–', '\x97': '—', '\x99': '™' }

/**
 * Emoji e pictogramas (menos © ® ™, que o WinAnsi tem), com o que vem grudado neles: tons de pele, ZWJ,
 * seletores de variação, keycap, bandeiras (indicadores regionais) e tags; mais os "vistos" ✓ ✔ ☑ ✗ ✘.
 * (RegExp montada de string: \p{…} exige ES2018 e o tsconfig ainda mira ES2017.)
 */
const PICTO = '(?:(?![\\u00A9\\u00AE\\u2122])\\p{Extended_Pictographic}|[\\u2611\\u2713-\\u2718\\u20E3\\u200D\\uFE0E\\uFE0F\\u{1F1E6}-\\u{1F1FF}\\u{1F3FB}-\\u{1F3FF}\\u{E0020}-\\u{E007F}])+'
const PICTOS = new RegExp(PICTO, 'gu')
/** pictogramas seguidos (separados ou não por espaços), com os espaços em volta: não sobra espaço duplo */
const PICTO_RUN = new RegExp(`[ \\t]*${PICTO}(?:[ \\t]*${PICTO})*[ \\t]*`, 'gu')
/** pontuação que fecha (sem espaço antes) */
const PUNCT_AFTER = /[.,;:!?)\]}»”’…]/
/** fora do WinAnsi (faixas com escapes — \xA0, não um espaço literal; DEL e C1, 0x7F–0x9F, o WinAnsi não codifica) */
const UNSUPPORTED = /[^\x20-\x7E\xA0-\xFF–—‘’•…€™]/gu

/** equivalentes de leitura óbvia para caracteres que o WinAnsi não tem */
function mapKnown(t: string): string {
  return (
    t
      .replace(/[›→]/g, '>')
      .replace(/[≈~]/g, '~')
      .replace(/[“”]/g, '"')
      .replace(/≥/g, '>=')
      .replace(/≤/g, '<=')
      .replace(/≠/g, '<>')
      // quebras de linha/tabulações (textareas) viram espaço, não '?'
      .replace(/[\t\r\n\u2028\u2029]+/g, ' ')
      .replace(/[\x7F-\x9F]/g, (c) => C1[c] ?? '?')
  )
}

/**
 * Fontes padrão do PDF usam WinAnsi: troca caracteres fora do conjunto para não quebrar o documento.
 * Emojis somem (em vez de virar "??"), sem deixar espaço duplo; o resto que não existe vira um '?' só
 * (inclusive caracteres fora do plano básico).
 */
export function clean(t: string): string {
  return (
    mapKnown(t)
      // "Hola 👋 su" → "Hola su"; no começo/fim do texto somem também os espaços ("✅ Lista" → "Lista") e
      // antes de pontuação também ("cliente 👋:" → "cliente:")
      .replace(PICTO_RUN, (m: string, at: number, s: string) => {
        const next = s[at + m.length]
        if (at === 0 || next === undefined || PUNCT_AFTER.test(next)) return ''
        return /^[ \t]|[ \t]$/.test(m) ? ' ' : ''
      })
      .replace(UNSUPPORTED, '?')
  )
}

/**
 * Caracteres do texto que NÃO aparecem no PDF (emojis somem, outros símbolos viram '?'), sem repetir —
 * para avisar no formulário antes de gerar. Vazio = tudo aparece (ou tem equivalente: ≥ → >=, “ → "…).
 */
export function pdfUnsupportedChars(t: string): string[] {
  const out = new Set<string>()
  const rest = mapKnown(t).replace(PICTOS, (m) => {
    out.add(m)
    return ' '
  })
  for (const c of rest.match(UNSUPPORTED) ?? []) out.add(c)
  return [...out]
}
