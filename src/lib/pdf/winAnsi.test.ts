import { PDFDocument, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { clean, pdfUnsupportedChars } from './winAnsi'

describe('texto para as fontes padrão do PDF (WinAnsi)', () => {
  it('emojis somem (nada de "??") sem deixar espaço duplo; ≥ ≤ ≠ viram equivalentes', () => {
    expect(clean('Hola 👋 su carga ≥ lista ✅')).toBe('Hola su carga >= lista')
    expect(clean('Hola 👋 su carga ≥ lista ✅ ✓ 👍🏽 ❤️')).toBe('Hola su carga >= lista')
    expect(clean('✅ Carga lista')).toBe('Carga lista')
    expect(clean('a 👨‍👩‍👧 b')).toBe('a b')
    expect(clean('Bandera 🇺🇾 ok')).toBe('Bandera ok')
    expect(clean('1️⃣ Booking')).toBe('1 Booking')
    expect(clean('Estimado cliente 👋:')).toBe('Estimado cliente:')
    expect(clean('Su carga zarpó 🚢. Saludos')).toBe('Su carga zarpó. Saludos')
    expect(clean('x ≤ 5, y ≠ 3')).toBe('x <= 5, y <> 3')
  })

  it('© ® ™ ficam (o WinAnsi tem); outro caractere sem equivalente vira UM "?" (inclusive fora do plano básico)', () => {
    expect(clean('PACIFIL NXT™ — ® ©')).toBe('PACIFIL NXT™ — ® ©')
    expect(clean('Ω 𝐀 x')).toBe('? ? x')
  })

  it('o resultado sempre pode ser desenhado com a Helvetica padrão', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    expect(() => font.widthOfTextAtSize(clean('Hola 👋🏽 ≥ ✅ ✓ Ω 𝐀 🇧🇷 1️⃣ “x” → ok'), 9)).not.toThrow()
  })

  it('aviso no formulário: lista o que não aparece no PDF (sem repetir); equivalentes e texto normal não entram', () => {
    expect(pdfUnsupportedChars('Hola 👋 su carga ≥ lista ✅ ✅ Ω')).toEqual(['👋', '✅', 'Ω'])
    expect(pdfUnsupportedChars('Estimado cliente: “Su carga” → zarpó… ™ ® ç ñ €')).toEqual([])
    expect(pdfUnsupportedChars('')).toEqual([])
  })
})
