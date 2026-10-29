import { expeditionModel } from '@/domain/expedition'
import { quadrantShares } from '@/domain/quadrants'
import type { LoadDoc } from '@/domain/types'
import { SPECIAL_TRANSPORT_LABEL, specialTransportCompany, transportCompanyLabel } from '@/domain/transportCompany'
import { PDF_LOGO_PATH } from '@/lib/pdf/i18n'
import type { CaptureFn, CaptureView } from '../three/Scene3D'

/**
 * Transportadora como aparece na EXPEDIÇÃO (tela e PDF): "Empresa · cód. 12"; as entradas especiais do ERP
 * viram o que significam para o depósito (DESTINATARIO → "Retirada pelo cliente (destinatário)", A DEFINIR,
 * PROPRIO, Correios — com o serviço postal entre parênteses: "Correios (SEDEX)"). Sem transportadora: null.
 * Pura (serve à página do servidor e ao editor).
 */
export function expeditionTransportLabel(c: { code: string; name: string } | null | undefined): string | null {
  if (!c) return null
  const kind = specialTransportCompany(c)
  if (!kind) return transportCompanyLabel(c)
  const label = SPECIAL_TRANSPORT_LABEL[kind]
  const name = c.name.replace(/\s+/g, ' ').trim()
  return kind === 'postal' && !/^correios?$/i.test(name) ? `${label} (${name})` : label
}

/** dados da carga no cabeçalho do PDF de expedição */
export interface ExpeditionInfo {
  planName: string
  version: number
  status: string
  customer?: string | null
  orderRef?: string | null
  destination?: string | null
  mode: string | null
  /** já rotulada (expeditionTransportLabel); null = a definir */
  transportCompany: string | null
  /** nome do usuário que gera o PDF (rodapé discreto) */
  generatedBy?: string | null
}

const VIEWS: [CaptureView, string][] = [
  ['iso-front', '3/4 frente (norte) — lado oeste (motorista)'],
  ['iso-front-east', '3/4 frente (norte) — lado leste (acompanhante)'],
  ['iso-rear', '3/4 traseira (sul) — lado leste (acompanhante)'],
  ['iso-rear-west', '3/4 traseira (sul) — lado oeste (motorista)'],
  ['top', 'De cima'],
  ['door', 'Pela traseira (sul)'],
  ['side-west', 'Lateral — lado oeste (motorista)'],
  ['side-east', 'Lateral — lado leste (acompanhante)'],
  ['front', 'Pela frente (norte, cabine)'],
]

/**
 * PDF de EXPEDIÇÃO (para quem monta a carga; sem preços): planta e vista lateral em vetor, 9 vistas 3D,
 * a sequência de carregamento passo a passo e a lista de carregamento. Gerado no navegador.
 * `view` = o que a tela mostra (no envio sem equipamento, o piso do tamanho do conteúdo, sem frente/traseira).
 * Sem 3D (capture null ou WebGL indisponível) o PDF sai com a planta, a vista lateral e a lista.
 */
export async function exportExpeditionPdf(o: { doc: LoadDoc; view: LoadDoc; capture: CaptureFn | null; info: ExpeditionInfo }): Promise<{ blob: Blob; name: string; withViews: boolean }> {
  const model = expeditionModel(o.view, { maxSteps: 6 })
  const bytesOf = (u: string) => Uint8Array.from(atob(u.split(',')[1] ?? ''), (c) => c.charCodeAt(0))
  let views: { title: string; bytes: Uint8Array }[] = []
  let steps: { title: string; bytes: Uint8Array }[] = []
  try {
    const imgs = o.capture?.(VIEWS.map((v) => v[0]), { width: 1400, height: 820, overlays: false }) ?? []
    views = imgs.map((u, i) => ({ title: VIEWS[i][1], bytes: bytesOf(u) }))
    steps = model.steps.flatMap((st) => {
      const [u] = o.capture?.(['iso-rear'], { width: 1400, height: 820, only: st.ids }) ?? []
      return u ? [{ title: st.title, bytes: bytesOf(u) }] : []
    })
  } catch {
    views = []
    steps = [] // sem WebGL: o PDF sai com a planta, a vista lateral e a lista
  }
  const logo = await fetch(PDF_LOGO_PATH)
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .then((b) => (b ? new Uint8Array(b) : null))
    .catch(() => null)
  const qs = o.view.space.kind === 'NONE' ? null : quadrantShares(o.view)
  const { buildExpeditionPdf } = await import('@/lib/pdf/expeditionPdf')
  const i = o.info
  const bytes = await buildExpeditionPdf(o.view, model, { planName: i.planName, version: i.version, status: i.status, generatedAt: new Date(), customer: i.customer, orderRef: i.orderRef, destination: i.destination, mode: i.mode, transportCompany: i.transportCompany, generatedBy: i.generatedBy ?? null, frontPct: qs && qs.totalKg > 0 ? qs.northPct : null, rearPct: qs && qs.totalKg > 0 ? qs.southPct : null, logo }, { views, steps })
  const ref = (i.orderRef || i.planName || 'carga').replace(/[^\w.-]+/g, '_')
  return { blob: new Blob([bytes as BlobPart], { type: 'application/pdf' }), name: `expedicao-${ref}-V${i.version}.pdf`, withViews: views.length > 0 }
}
