/**
 * Vídeo 360° da carga (MP4/H.264, roda no navegador): a cena 3D é renderizada quadro a quadro pela
 * órbita da câmera (Scene3D → OrbitRecorder), cada quadro recebe uma tarja discreta com o logo e os
 * dados da carga e é codificado pelo navegador (WebCodecs) e empacotado em MP4 (Mediabunny).
 * MP4 H.264 + "fast start" = abre em WhatsApp, e-mail e qualquer reprodutor.
 */
import { BufferTarget, canEncodeVideo, CanvasSource, Mp4OutputFormat, Output, QUALITY_MEDIUM } from 'mediabunny'
import type { FrameInfo, OrbitRecorder } from '@/components/three/Scene3D'

export interface VideoOverlay {
  /** linha principal (ex.: cliente) */
  title: string
  /** até 2 linhas curtas (pedido, equipamento, destino, paletes/peso) */
  lines: string[]
  logo?: HTMLImageElement | null
}

/** Um passo da entrada da carga: unidades que entram juntas e o texto mostrado (o que e quanto). */
export interface IntroStep {
  ids: string[]
  /** ex.: "P5" ou "P5–P6" */
  title: string
  /** ex.: "8 × Silo-bolsa 9 pés × 75 m (SB-PAC-9X75-210)" */
  lines: string[]
}

export class VideoUnsupportedError extends Error {}

/** Resolução suportada pelo codificador H.264 do navegador (1080p, senão 720p). */
async function pickSize(): Promise<{ w: number; h: number }> {
  if (typeof VideoEncoder === 'undefined') throw new VideoUnsupportedError('Este navegador não gera vídeo MP4. Use o Google Chrome ou o Microsoft Edge atualizados.')
  for (const [w, h] of [
    [1920, 1080],
    [1280, 720],
  ])
    if (await canEncodeVideo('avc', { width: w, height: h, quality: QUALITY_MEDIUM })) return { w, h }
  throw new VideoUnsupportedError('O navegador não tem codificador H.264 (MP4) disponível. Use o Google Chrome ou o Microsoft Edge atualizados.')
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath()
  g.roundRect(x, y, w, h, r)
}

/** Tarja no canto inferior esquerdo (aparece suavemente no começo). */
function drawOverlay(g: CanvasRenderingContext2D, W: number, H: number, o: VideoOverlay, alpha: number) {
  if (alpha <= 0) return
  g.save()
  g.globalAlpha = alpha
  const pad = H * 0.022
  const titleFs = Math.round(H * 0.03)
  const lineFs = Math.round(H * 0.021)
  const logoH = o.logo ? H * 0.075 : 0
  const logoW = o.logo ? (o.logo.naturalWidth / o.logo.naturalHeight) * logoH : 0
  g.font = `bold ${titleFs}px Arial, sans-serif`
  let textW = g.measureText(o.title).width
  g.font = `${lineFs}px Arial, sans-serif`
  for (const l of o.lines) textW = Math.max(textW, g.measureText(l).width)
  const textH = titleFs + o.lines.length * (lineFs * 1.35)
  const boxH = Math.max(logoH, textH) + 2 * pad
  const gap = o.logo ? pad * 1.2 : 0
  const boxW = Math.min(W * 0.6, pad * 2 + logoW + gap + textW + (o.logo ? pad * 0.4 : 0))
  const x = H * 0.035, y = H - H * 0.035 - boxH
  g.shadowColor = 'rgba(0,0,0,0.18)'
  g.shadowBlur = H * 0.012
  g.fillStyle = 'rgba(255,255,255,0.9)'
  roundRect(g, x, y, boxW, boxH, H * 0.014)
  g.fill()
  g.shadowBlur = 0
  // filete verde Pacifil à esquerda
  g.fillStyle = '#0b6e4f'
  roundRect(g, x, y, H * 0.006, boxH, H * 0.003)
  g.fill()
  let tx = x + pad
  if (o.logo) {
    g.drawImage(o.logo, tx, y + (boxH - logoH) / 2, logoW, logoH)
    tx += logoW + gap
    g.fillStyle = 'rgba(11,110,79,0.25)'
    g.fillRect(tx - gap / 2, y + pad, 1.5, boxH - 2 * pad)
  }
  let ty = y + (boxH - textH) / 2
  g.textBaseline = 'top'
  g.fillStyle = '#0d2b22'
  g.font = `bold ${titleFs}px Arial, sans-serif`
  g.fillText(o.title, tx, ty, boxW - (tx - x) - pad)
  ty += titleFs * 1.15
  g.fillStyle = '#3d4a54'
  g.font = `${lineFs}px Arial, sans-serif`
  for (const l of o.lines) {
    ty += lineFs * 0.2
    g.fillText(l, tx, ty, boxW - (tx - x) - pad)
    ty += lineFs * 1.15
  }
  g.restore()
}

/** Legenda da entrada (canto superior esquerdo): contador, unidade e o que ela leva. */
function drawCaption(g: CanvasRenderingContext2D, W: number, H: number, st: IntroStep, counter: string, alpha: number) {
  if (alpha <= 0) return
  g.save()
  g.globalAlpha = alpha
  const pad = H * 0.02
  const smallFs = Math.round(H * 0.019), titleFs = Math.round(H * 0.034), lineFs = Math.round(H * 0.024)
  const lines = st.lines.slice(0, 4)
  g.font = `bold ${titleFs}px Arial, sans-serif`
  let tw = g.measureText(st.title).width
  g.font = `${lineFs}px Arial, sans-serif`
  for (const l of lines) tw = Math.max(tw, g.measureText(l).width)
  g.font = `bold ${smallFs}px Arial, sans-serif`
  tw = Math.max(tw, g.measureText(counter).width)
  const boxW = Math.min(W * 0.62, tw + 2 * pad + H * 0.01)
  const boxH = pad * 2 + smallFs * 1.4 + titleFs * 1.2 + lines.length * lineFs * 1.35
  const x = H * 0.035, y = H * 0.035
  g.shadowColor = 'rgba(0,0,0,0.18)'
  g.shadowBlur = H * 0.012
  g.fillStyle = 'rgba(255,255,255,0.92)'
  roundRect(g, x, y, boxW, boxH, H * 0.014)
  g.fill()
  g.shadowBlur = 0
  g.fillStyle = '#0b6e4f'
  roundRect(g, x, y, H * 0.006, boxH, H * 0.003)
  g.fill()
  const tx = x + pad + H * 0.004, maxW = boxW - 2 * pad
  let ty = y + pad
  g.textBaseline = 'top'
  g.fillStyle = '#0b6e4f'
  g.font = `bold ${smallFs}px Arial, sans-serif`
  g.fillText(counter, tx, ty, maxW)
  ty += smallFs * 1.4
  g.fillStyle = '#0d2b22'
  g.font = `bold ${titleFs}px Arial, sans-serif`
  g.fillText(st.title, tx, ty, maxW)
  ty += titleFs * 1.2
  g.fillStyle = '#3d4a54'
  g.font = `${lineFs}px Arial, sans-serif`
  for (const l of lines) {
    g.fillText(l, tx, ty, maxW)
    ty += lineFs * 1.35
  }
  g.restore()
}

/**
 * Grava o vídeo e devolve o MP4. Roteiro: (1) entrada das unidades pela porta, uma a uma, com o produto
 * e a quantidade de cada uma; (2) giro de 360° aberto; (3) aproximação e giro de 360° perto da carga.
 * `onProgress` recebe 0..1.
 */
export async function recordOrbitMp4(
  rec: OrbitRecorder,
  o: { overlay: VideoOverlay; intro?: IntroStep[]; introLabel?: (n: number, total: number) => string; orbitSeconds?: number; zoomSeconds?: number; fps?: number; onProgress?: (p: number) => void },
): Promise<Blob> {
  const { w, h } = await pickSize()
  const fps = o.fps ?? 30
  const intro = o.intro ?? []
  // entrada: ~12 s no total, entre 0,4 s e 1 s por passo
  const stepFrames = intro.length ? Math.round(fps * Math.min(1, Math.max(0.4, 12 / intro.length))) : 0
  const comp = document.createElement('canvas')
  comp.width = w
  comp.height = h
  const g = comp.getContext('2d')!
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() })
  const source = new CanvasSource(comp, { codec: 'avc', quality: QUALITY_MEDIUM, keyFrameInterval: 2 })
  output.addVideoTrack(source, { frameRate: fps })
  await output.start()
  const label = o.introLabel ?? ((n: number, t: number) => `${n} / ${t}`)
  await rec({
    width: w,
    height: h,
    intro: intro.map((s) => s.ids),
    stepFrames,
    holdFrames: Math.round(fps * 1),
    orbitFrames: Math.round((o.orbitSeconds ?? 12) * fps),
    transitionFrames: Math.round(fps * 1.5),
    zoomFrames: Math.round((o.zoomSeconds ?? 14) * fps),
    onFrame: async (i: number, src: HTMLCanvasElement, info: FrameInfo) => {
      g.fillStyle = '#e9eef2'
      g.fillRect(0, 0, w, h)
      g.drawImage(src, 0, 0, w, h)
      drawOverlay(g, w, h, o.overlay, Math.min(1, i / (fps * 0.6)))
      if (info.phase === 'intro' || info.phase === 'hold') {
        const st = intro[info.step]
        // aparece no começo do passo; na pausa final some suavemente
        const a = info.phase === 'hold' ? 1 - info.stepT : Math.min(1, info.stepT * 4)
        if (st) drawCaption(g, w, h, st, label(info.step + 1, intro.length), a)
      }
      await source.add(i / fps, 1 / fps)
      o.onProgress?.((i + 1) / info.total)
    },
  })
  await output.finalize()
  const buf = (output.target as BufferTarget).buffer
  if (!buf) throw new Error('vídeo vazio')
  return new Blob([buf], { type: 'video/mp4' })
}

/** Logo para a tarja (mesmo arquivo do PDF). */
export async function loadLogo(src: string): Promise<HTMLImageElement | null> {
  return new Promise((ok) => {
    const i = new Image()
    i.onload = () => ok(i)
    i.onerror = () => ok(null)
    i.src = src
  })
}
