'use client'

import type { IntakeResult } from '@/domain/intake'
import { BODY_LIMITS, fmtMB, INTAKE_IMAGE, intakeSizeError } from './limits'

/** Formatos aceitos nos anexos de pedidos (imagens, PDF, Word, Excel, CSV, texto). */
export const ATTACH_ACCEPT =
  'image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,.heic,.heif,application/pdf,.pdf,.docx,.xlsx,.csv,.txt,text/plain,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
export const ATTACH_HINT = `Fotos/capturas (JPG, PNG, WebP, HEIC do iPhone), PDF, Word (.docx), Excel (.xlsx), CSV ou texto · até 8 arquivos e ${fmtMB(BODY_LIMITS.intakeTotal)} no total (fotos são reduzidas automaticamente)`
export const MAX_ATTACH = 8

/** foto HEIC/HEIF (formato do iPhone) */
export const isHeic = (f: File) => /^image\/hei[cf]/i.test(f.type) || /\.hei[cf]$/i.test(f.name)

/**
 * HEIC → JPEG no navegador (a IA não lê HEIC): o Safari (iPhone/Mac) decodifica sozinho; nos demais
 * navegadores, a conversão carrega o heic2any só quando precisa. Sem conversão → devolve o original
 * (o servidor explica como enviar como JPG).
 */
export async function heicToJpeg(f: File): Promise<File> {
  const name = f.name.replace(/\.\w+$/, '') + '.jpg'
  try {
    const bmp = await createImageBitmap(f)
    const c = document.createElement('canvas')
    c.width = bmp.width
    c.height = bmp.height
    c.getContext('2d')!.drawImage(bmp, 0, 0)
    bmp.close()
    const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/jpeg', 0.88))
    if (blob) return new File([blob], name, { type: 'image/jpeg' })
  } catch {
    /* navegador sem HEIC nativo: tenta o conversor */
  }
  try {
    const heic2any = (await import('heic2any')).default
    const out = await heic2any({ blob: f, toType: 'image/jpeg', quality: 0.88 })
    const blob = Array.isArray(out) ? out[0] : out
    return new File([blob], name, { type: 'image/jpeg' })
  } catch {
    return f
  }
}

/**
 * TODA imagem é reduzida no navegador antes de enviar: lado maior 1568 px, JPEG q0,8 (o modelo reduz
 * qualquer imagem maior do que isso; acima é só peso no envio, que na Vercel tem teto de 4,5 MB).
 * HEIC vira JPEG. Imagem já pequena que ficaria MAIOR em JPEG (captura PNG leve) segue como está.
 */
export async function shrinkImage(f0: File): Promise<File> {
  const f = isHeic(f0) ? await heicToJpeg(f0) : f0
  if (isHeic(f)) return f
  if (!f.type.startsWith('image/')) return f
  const url = URL.createObjectURL(f)
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => {
      const i = new Image()
      i.onload = () => ok(i)
      i.onerror = () => fail(new Error('imagem'))
      i.src = url
    })
    const k = Math.min(1, INTAKE_IMAGE.maxSide / Math.max(img.naturalWidth, img.naturalHeight))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(img.naturalWidth * k))
    c.height = Math.max(1, Math.round(img.naturalHeight * k))
    const g = c.getContext('2d')!
    // PNG/WebP com transparência: fundo branco (o JPEG não tem canal alfa e o transparente sairia preto)
    g.fillStyle = '#fff'
    g.fillRect(0, 0, c.width, c.height)
    g.drawImage(img, 0, 0, c.width, c.height)
    const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/jpeg', INTAKE_IMAGE.quality))
    if (!blob) return f
    // já no tamanho certo e mais leve no original: mantém (formato aceito pela IA)
    if (k === 1 && blob.size >= f.size && /^image\/(jpeg|png|webp|gif)$/.test(f.type)) return f
    return new File([blob], f.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' })
  } catch {
    return f
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Imagens coladas (Ctrl+V) viram anexos com nome legível. */
export function pastedImages(e: React.ClipboardEvent): File[] {
  return [...e.clipboardData.files].filter((f) => f.type.startsWith('image/')).map((f, i) => new File([f], f.name && f.name !== 'image.png' ? f.name : `captura-${Date.now()}-${i}.png`, { type: f.type }))
}

export const fileIcon = (f: File) => (f.type.startsWith('image/') ? '🖼' : /pdf/i.test(f.type) || f.name.toLowerCase().endsWith('.pdf') ? '📄' : /\.docx$/i.test(f.name) ? '📝' : '📊')

/** Envia anexos + texto para interpretação (nada é gravado). */
export async function interpretAttachments(text: string, files: File[], area?: string | null): Promise<{ ok: true; result: IntakeResult } | { ok: false; error: string }> {
  // o envio inteiro precisa caber no limite da função (4,5 MB na Vercel): avisa antes de mandar
  const tooBig = intakeSizeError(files, text)
  if (tooBig) return { ok: false, error: tooBig }
  try {
    const fd = new FormData()
    fd.set('text', text)
    // área do envio: define a linha das lonas até 14 m (exportação = plana, mercado interno = BPF)
    if (area) fd.set('area', area)
    for (const f of files) fd.append('files', f)
    const r = await fetch('/cargas/ia/interpretar', { method: 'POST', body: fd })
    const j = (await r.json().catch(() => null)) as { ok: boolean; result?: IntakeResult; error?: string } | null
    if (j?.ok && j.result) return { ok: true, result: j.result }
    if (j?.error) return { ok: false, error: j.error }
    // respostas da plataforma (sem JSON): corpo grande demais ou tempo esgotado
    if (r.status === 413) return { ok: false, error: `Os anexos passaram do limite de envio do servidor (${fmtMB(BODY_LIMITS.intakeTotal)} no total). Remova algum arquivo, envie só as páginas do pedido em PDF ou uma captura de tela.` }
    if (r.status === 504) return { ok: false, error: 'A leitura do pedido demorou demais e foi interrompida. Tente de novo com menos anexos (ou só as páginas do pedido).' }
    return { ok: false, error: 'Não foi possível interpretar o pedido.' }
  } catch {
    return { ok: false, error: 'Falha de comunicação com o servidor.' }
  }
}

/**
 * Anexos escolhidos na página principal ("Criar com IA") que seguem para a tela do pedido do cliente.
 * Fica em memória do navegador (navegação no próprio app); recarregar a página descarta.
 */
let pending: { text: string; files: File[] } | null = null
export const setPendingIntake = (p: { text: string; files: File[] }) => {
  pending = p
}
export const takePendingIntake = () => {
  const p = pending
  pending = null
  return p
}
