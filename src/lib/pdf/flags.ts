import { countryCode } from '@/lib/countries'

/** cache por processo/aba: a mesma bandeira não é baixada de novo */
const CACHE = new Map<string, Promise<Uint8Array | null>>()

/**
 * Bandeira do país (PNG 80 px de largura, flagcdn.com — a mesma fonte das bandeiras da plataforma)
 * para o cabeçalho dos PDFs. Funciona no servidor e no navegador; sem rede ou país desconhecido → null
 * (o PDF sai sem a bandeira).
 */
export function flagPng(country: string | null | undefined): Promise<Uint8Array | null> {
  const cc = countryCode(country)?.toLowerCase()
  if (!cc) return Promise.resolve(null)
  let p = CACHE.get(cc)
  if (!p) {
    p = (async () => {
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 4000)
        const r = await fetch(`https://flagcdn.com/w80/${cc}.png`, { signal: ctrl.signal })
        clearTimeout(timer)
        if (!r.ok) return null
        const b = new Uint8Array(await r.arrayBuffer())
        // PNG válido?
        return b[0] === 0x89 && b[1] === 0x50 ? b : null
      } catch {
        return null
      }
    })()
    CACHE.set(cc, p)
    // falha não fica em cache (tenta de novo no próximo PDF)
    void p.then((v) => {
      if (!v) CACHE.delete(cc)
    })
  }
  return p
}
