'use server'

import { canAccessArea } from '@/lib/areas'
import { getCurrentUser } from '@/lib/auth'
import { can } from '@/lib/roles'
import { OrderParseError } from '@/lib/ai/orderParser'
import { priceListAssist, PriceListPreset } from '@/lib/ai/priceListAssistant'

/** Assistente da lista de preços: texto (digitado ou ditado) → opções da tela. Nada é gravado. */
export async function priceListAssistAction(message: string): Promise<{ ok: true; text: string; preset: PriceListPreset } | { ok: false; error: string }> {
  const u = await getCurrentUser()
  if (!u) return { ok: false, error: 'Sessão expirada. Entre novamente.' }
  if (u.mustChangePassword) return { ok: false, error: 'Defina uma nova senha antes de continuar.' }
  if (!can.viewPrices(u.role) || !canAccessArea(u, 'EXPORT')) return { ok: false, error: 'Sem permissão para listas de preços.' }
  const text = String(message ?? '').trim().slice(0, 2000)
  if (!text) return { ok: false, error: 'Escreva ou dite o que a lista deve ter.' }
  try {
    const r = await priceListAssist(u, text)
    return { ok: true, ...r }
  } catch (e) {
    if (e instanceof OrderParseError) return { ok: false, error: e.message }
    console.error('[assistente lista de preços]', e)
    return { ok: false, error: 'Não foi possível interpretar o pedido.' }
  }
}
