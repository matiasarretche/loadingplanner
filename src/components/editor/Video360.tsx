'use client'

import { useEffect, useRef, useState } from 'react'
import type { PdfLang } from '@/lib/pdf/i18n'
import { PDF_LOGO_PATH, pdfText } from '@/lib/pdf/i18n'
import type { UnitGeometry } from '@/domain/load'
import { kitBoxLines, kitFamilyOf } from '@/domain/kitBoxes'
import type { PackSnapshot } from '@/domain/types'
import { IntroStep, loadLogo, recordOrbitMp4, VideoUnsupportedError } from '@/lib/video/orbitVideo'
import type { OrbitRecorder } from '../three/Scene3D'

export interface VideoInfo {
  name: string
  customer?: string | null
  orderRef?: string | null
  destination?: string | null
}

const T: Record<PdfLang, { order: string; pallets: string; boxes: string; gross: string; to: string; loading: (n: number, t: number) => string; loose: string }> = {
  pt: { order: 'Pedido', pallets: 'paletes', boxes: 'volumes', gross: 'kg brutos', to: 'Destino', loading: (n, t) => `CARREGANDO ${n} DE ${t}`, loose: 'Volumes soltos' },
  es: { order: 'Pedido', pallets: 'pallets', boxes: 'bultos', gross: 'kg brutos', to: 'Destino', loading: (n, t) => `CARGANDO ${n} DE ${t}`, loose: 'Bultos sueltos' },
  en: { order: 'Order', pallets: 'pallets', boxes: 'packages', gross: 'kg gross', to: 'Destination', loading: (n, t) => `LOADING ${n} OF ${t}`, loose: 'Loose packages' },
}

/** no máximo este número de passos na entrada (cargas grandes entram em grupos) */
const MAX_STEPS = 40

/** Quantidade de um produto num passo; kits em caixas coletivas (KIT-HF) contam KITS, com as caixas. */
export type IntroCount = { name: string; n: number; kitPacks?: PackSnapshot[] }

/**
 * Passos da entrada da carga, na ordem de carregamento (da frente/norte para a traseira/sul, de baixo para
 * cima): cada palete é um passo com o produto e a quantidade; volumes soltos do mesmo produto entram
 * em grupos. Cargas com muitos itens são agrupadas para a entrada caber em ~12 s.
 * Kits com caixas coletivas: a quantidade é em kits (52, não "2 caixas"); packsOf dá as caixas da unidade
 * (uma embalagem por caixa física) para o detalhe por tipo de caixa.
 */
export function introSteps(geoms: UnitGeometry[], labelOf: (g: UnitGeometry) => string | null, looseTitle: string, packsOf?: (g: UnitGeometry) => PackSnapshot[]): { ids: string[]; title: string; counts: Map<string, IntroCount> }[] {
  const ordered = [...geoms].sort((a, b) => a.box.min.x - b.box.min.x || a.box.min.z - b.box.min.z || a.box.min.y - b.box.min.y)
  type Step = { ids: string[]; titles: string[]; counts: Map<string, IntroCount> }
  const add = (st: Step, g: UnitGeometry) => {
    st.ids.push(g.unit.id)
    const t = labelOf(g)
    if (t && !st.titles.includes(t)) st.titles.push(t)
    for (const l of g.bySku) {
      const kit = Boolean(kitFamilyOf(l.sku))
      const c = st.counts.get(l.sku) ?? { name: l.name, n: 0 }
      c.n += kit ? l.units : l.packages
      if (kit && packsOf) c.kitPacks = [...(c.kitPacks ?? []), ...packsOf(g).filter((p) => p.sku === l.sku)]
      st.counts.set(l.sku, c)
    }
  }
  let steps: Step[] = []
  const pallets = ordered.filter((g) => g.unit.kind === 'PALLET').length
  const loose = ordered.length - pallets
  // volumes soltos: grupos do mesmo produto, consecutivos na ordem de carregamento
  const chunk = Math.max(1, Math.ceil(loose / Math.max(1, MAX_STEPS - pallets)))
  for (const g of ordered) {
    const last = steps.at(-1)
    if (g.unit.kind === 'PACKAGE' && last && last.titles[0] === looseTitle && last.ids.length < chunk && last.counts.has(g.bySku[0]?.sku ?? '') && last.counts.size === 1) {
      add(last, g)
      continue
    }
    const st: Step = { ids: [], titles: g.unit.kind === 'PACKAGE' ? [looseTitle] : [], counts: new Map() }
    add(st, g)
    steps.push(st)
  }
  // ainda muitos passos: junta vizinhos
  if (steps.length > MAX_STEPS) {
    const k = Math.ceil(steps.length / MAX_STEPS)
    const merged: Step[] = []
    for (let i = 0; i < steps.length; i += k) {
      const st: Step = { ids: [], titles: [], counts: new Map() }
      for (const x of steps.slice(i, i + k)) {
        st.ids.push(...x.ids)
        for (const t of x.titles) if (!st.titles.includes(t)) st.titles.push(t)
        for (const [sku, c] of x.counts) {
          const cur = st.counts.get(sku) ?? { name: c.name, n: 0 }
          cur.n += c.n
          if (c.kitPacks) cur.kitPacks = [...(cur.kitPacks ?? []), ...c.kitPacks]
          st.counts.set(sku, cur)
        }
      }
      merged.push(st)
    }
    steps = merged
  }
  return steps.map((s) => ({ ids: s.ids, title: s.titles.length > 2 ? `${s.titles[0]}–${s.titles.at(-1)}` : s.titles.join(' + '), counts: s.counts }))
}

/**
 * "Gravar 360°": gera o vídeo do giro da câmera em volta da carga (MP4), mostra a prévia e permite
 * baixar ou compartilhar. A gravação começa ao abrir.
 */
export function Video360({ recorder, info, equipment, totals, lang, onClose, geoms, labelOf, packsOf }: {
  recorder: () => OrbitRecorder | null
  /** unidades carregadas (para a entrada da carga no começo do vídeo) */
  geoms: UnitGeometry[]
  labelOf: (g: UnitGeometry) => string | null
  /** embalagens da unidade, uma por caixa física (detalhe das caixas de kits) */
  packsOf?: (g: UnitGeometry) => PackSnapshot[]
  info: VideoInfo
  equipment: string
  totals: { pallets: number; looseBoxes: number; grossKg: number }
  lang: PdfLang
  onClose: () => void
}) {
  const [progress, setProgress] = useState(0)
  const [video, setVideo] = useState<{ url: string; file: File } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)
  const t = T[lang]
  const nf = new Intl.NumberFormat(lang === 'en' ? 'en-US' : lang === 'es' ? 'es-AR' : 'pt-BR', { maximumFractionDigits: 0 })
  const fileName = `${(info.orderRef || info.name).replace(/[^\w.-]+/g, '_')}-360.mp4`

  async function record() {
    setError(null)
    setVideo(null)
    setProgress(0)
    const rec = recorder()
    if (!rec) return setError('O 3D ainda não está pronto. Aguarde a visualização aparecer e tente de novo.')
    try {
      const logo = await loadLogo(PDF_LOGO_PATH)
      const line1 = [info.orderRef ? (/^(proforma|pedido)\b/i.test(info.orderRef) ? info.orderRef : `${t.order} ${info.orderRef}`) : null, equipment, info.destination ? `${t.to}: ${info.destination}` : null].filter(Boolean).join(' · ')
      const units = [totals.pallets ? `${nf.format(totals.pallets)} ${t.pallets}` : null, totals.looseBoxes ? `${nf.format(totals.looseBoxes)} ${t.boxes}` : null, `${nf.format(totals.grossKg)} ${t.gross}`].filter(Boolean).join(' · ')
      // kits em caixas coletivas: "52 × Kit … — 2 × caixa 79583 (26 kits)" (nunca "2 × Kit")
      const boxesOf = (c: IntroCount) => (c.kitPacks?.some((p) => p.kitBox) ? ` — ${pdfText(lang).kitBoxes(kitBoxLines(c.kitPacks))}` : '')
      const intro: IntroStep[] = introSteps(geoms, labelOf, t.loose, packsOf).map((s) => ({
        ids: s.ids,
        title: s.title,
        lines: [...s.counts.entries()].map(([sku, c]) => `${nf.format(c.n)} × ${c.name}${c.name.includes(sku) ? '' : ` (${sku})`}${boxesOf(c)}`),
      }))
      const blob = await recordOrbitMp4(rec, { overlay: { title: info.customer || info.name, lines: [line1, units], logo }, intro, introLabel: t.loading, onProgress: setProgress })
      setVideo({ url: URL.createObjectURL(blob), file: new File([blob], fileName, { type: 'video/mp4' }) })
    } catch (e) {
      setError(e instanceof VideoUnsupportedError ? e.message : 'Não foi possível gerar o vídeo.')
    }
  }

  useEffect(() => {
    if (started.current) return
    started.current = true
    void record()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- grava uma vez ao abrir
  }, [])
  useEffect(() => () => {
    if (video) URL.revokeObjectURL(video.url)
  }, [video])

  const canShare = video && typeof navigator !== 'undefined' && navigator.canShare?.({ files: [video.file] })
  const recording = !video && !error

  return (
    <div className="overlay-full" style={{ display: 'grid', placeItems: 'center', background: 'rgba(13,43,34,.55)' }}>
      <div className="panel" style={{ width: 'min(900px, 94vw)', maxHeight: '94vh', overflow: 'auto' }}>
        <div className="row" style={{ alignItems: 'center', marginBottom: 8 }}>
          <h3 style={{ margin: 0 }}>🎥 Vídeo 360° da carga</h3>
          <span className="spacer" />
          <button onClick={onClose} disabled={recording}>
            Fechar
          </button>
        </div>
        {recording && (
          <div style={{ padding: '30px 0' }}>
            <div className="muted" style={{ marginBottom: 8 }}>Gravando o vídeo (entrada da carga, giro de 360° e giro aproximado)… {Math.round(progress * 100)}%</div>
            <div style={{ height: 10, background: '#e3e8ec', borderRadius: 5, overflow: 'hidden' }}>
              <div style={{ width: `${progress * 100}%`, height: '100%', background: '#0b6e4f', transition: 'width .2s' }} />
            </div>
            <small className="muted" style={{ display: 'block', marginTop: 8 }}>Leva alguns segundos. O 3D da tela fica parado durante a gravação.</small>
          </div>
        )}
        {error && (
          <>
            <div className="alert error">{error}</div>
            <button onClick={() => void record()}>Tentar de novo</button>
          </>
        )}
        {video && (
          <>
            <video src={video.url} controls autoPlay muted loop playsInline style={{ width: '100%', borderRadius: 8, background: '#000' }} />
            <div className="row" style={{ marginTop: 10, gap: 8, alignItems: 'center' }}>
              <a className="btn primary" href={video.url} download={fileName}>
                ⬇ Baixar MP4
              </a>
              {canShare && (
                <button onClick={() => void navigator.share({ files: [video.file] }).catch(() => {})} title="Abre o compartilhamento do sistema (WhatsApp, e-mail…)">
                  Compartilhar…
                </button>
              )}
              <button onClick={() => void record()}>Gravar de novo</button>
              <small className="muted">
                {fileName} · {(video.file.size / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB · MP4 (H.264), pronto para WhatsApp e e-mail
              </small>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
