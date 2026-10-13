/**
 * COMPRIMENTO DO CAMINHÃO informado na carga (varia muito de um caminhão para outro): muda o
 * comprimento útil do espaço de carga desta carga, sem mudar o cadastro do veículo.
 *
 * Carga por eixo: o implemento cadastrado é adaptado pela diferença (Δ) em relação ao comprimento do
 * cadastro: semirreboque → o conjunto de eixos traseiro acompanha o fundo (pino-rei fica); caminhão
 * rígido → eixos ficam, o balanço traseiro cresce. A tara do implemento acompanha o centro.
 */
import type { CarrierSnapshot } from './axles'
import type { LoadDoc } from './types'

export const VEHICLE_LENGTH_LIMITS = { min: 2000, max: 25000 }

/** Carga com o comprimento útil informado (só veículos rodoviários). */
export function withVehicleLength(doc: LoadDoc, lengthMm: number): LoadDoc {
  if (doc.space.kind !== 'VEHICLE') return doc
  const L = Math.round(lengthMm)
  if (!Number.isFinite(L) || L < VEHICLE_LENGTH_LIMITS.min || L > VEHICLE_LENGTH_LIMITS.max) return doc
  const base = doc.space.baseInnerL ?? doc.space.inner.l
  return { ...doc, space: { ...doc.space, inner: { ...doc.space.inner, l: L }, baseInnerL: L === base ? undefined : base } }
}

/** Diferença entre o comprimento informado e o do cadastro (0 = sem alteração). */
export const vehicleLengthDelta = (doc: Pick<LoadDoc, 'space'>) => (doc.space.kind === 'VEHICLE' && doc.space.baseInnerL != null ? doc.space.inner.l - doc.space.baseInnerL : 0)

/** Implemento adaptado ao comprimento informado (para a carga por eixo). Chassi/contêiner: sem mudança. */
export function effectiveCarrier(doc: Pick<LoadDoc, 'space'>, c: CarrierSnapshot): CarrierSnapshot {
  const d = vehicleLengthDelta(doc)
  if (!d || c.kind === 'CHASSIS') return c
  const tareCg = c.tareCgMm != null ? c.tareCgMm + d / 2 : null
  if (c.kind === 'RIGID') return { ...c, lengthMm: c.lengthMm + d, tareCgMm: tareCg }
  // semirreboque: o conjunto traseiro fica na mesma distância do fundo
  return { ...c, lengthMm: c.lengthMm + d, groupCenterMm: c.groupCenterMm + d, tareCgMm: tareCg }
}
