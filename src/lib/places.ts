import { COMPANY } from './pdf/i18n'

/** endereço de coleta padrão: a fábrica de Sapiranga, onde se carrega praticamente todo pedido */
export const DEFAULT_PICKUP = `Pacifil Sapiranga – ${COMPANY.address}`

/** origem mostrada e gravada: no rodoviário (endereço de coleta), vazia e não editada → a fábrica */
export const originOrDefault = (value: string, placeMode: string | null | undefined, touched: boolean) => (value || touched || placeMode !== 'ROAD' ? value : DEFAULT_PICKUP)

/**
 * Origem e destino do envio conforme a modalidade: portos (marítimo), aeroportos (aéreo) ou
 * endereços físicos (rodoviário). Os textos ficam no pedido (shipment); nada é deduzido.
 */
export function placeLabels(mode: string | null | undefined): { origin: string; destination: string; originHint: string; destinationHint: string } {
  if (mode === 'AIR') return { origin: 'Aeroporto de origem', destination: 'Aeroporto de destino', originHint: 'ex.: GRU – Guarulhos', destinationHint: 'ex.: MVD – Montevidéu' }
  if (mode === 'ROAD') return { origin: 'Endereço de coleta (origem)', destination: 'Endereço de entrega (destino)', originHint: 'rua, número, cidade', destinationHint: 'rua, número, cidade, país' }
  return { origin: 'Porto de origem', destination: 'Porto de destino', originHint: 'ex.: Rio Grande', destinationHint: 'ex.: Montevidéu' }
}

/** texto livre do formulário → valor salvo (vazio = null) */
export const placeValue = (v: string | null | undefined) => {
  const t = (v ?? '').trim().replace(/\s+/g, ' ')
  return t ? t.slice(0, 300) : null
}
