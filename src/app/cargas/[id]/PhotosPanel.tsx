'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { dt } from '@/components/format'
import { heicToJpeg, isHeic } from '@/components/intake/attach'
import { BODY_LIMITS, fmtMB } from '@/components/intake/limits'
import { deletePhotoAction, updatePhotoCaptionAction } from '../actions'

export interface PhotoItem {
  id: number
  caption: string | null
  takenAt: string | null
  createdAt: string
  createdBy: string | null
  width: number | null
  height: number | null
  sizeBytes: number
}

/** Reduz a imagem no navegador: JPEG com o lado maior ≤ max px (foto de celular de 5 MB → ~300 KB). */
async function shrink(file: File, max: number, quality: number): Promise<{ blob: Blob; w: number; h: number }> {
  const bmp = await createImageBitmap(file)
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height))
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  c.getContext('2d')!.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  const blob = await new Promise<Blob>((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error('falha ao converter'))), 'image/jpeg', quality))
  return { blob, w, h }
}

/**
 * FOTOS DO CARREGAMENTO: registro de como a carga ficou realmente carregada. Só depois de aprovada.
 * Galeria com miniaturas (clique abre a foto inteira), legenda, exclusão e envio de várias fotos.
 */
export function PhotosPanel({ planId, photos, approved, editable, canUpload = editable, open }: { planId: number; photos: PhotoItem[]; approved: boolean; editable: boolean; canUpload?: boolean; open?: boolean }) {
  const router = useRouter()
  const input = useRef<HTMLInputElement>(null)
  const camera = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ type: 'ok' | 'error' | 'warn'; text: string } | null>(null)
  const [captions, setCaptions] = useState<Record<number, string>>({})

  async function upload(files: FileList | null) {
    if (!files?.length) return
    setMsg(null)
    let ok = 0
    const errors: string[] = []
    const all = [...files]
    const list = all.filter((f) => f.type.startsWith('image/') || isHeic(f))
    // arquivo que não é imagem: avisa (não conta como enviado)
    errors.push(...all.filter((f) => !list.includes(f)).map((f) => `${f.name}: não é uma imagem`))
    for (const [i, f0] of list.entries()) {
      setBusy(`Enviando ${i + 1} de ${list.length}…`)
      try {
        // HEIC do iPhone (vindo do computador) vira JPEG antes de reduzir
        const f = isHeic(f0) ? await heicToJpeg(f0) : f0
        let big = await shrink(f, 1600, 0.82)
        const small = await shrink(f, 360, 0.7)
        const medium = await shrink(f, 1000, 0.72)
        // o envio (foto + média + miniatura) cabe no limite do servidor; foto muito detalhada: reduz mais
        const rest = small.blob.size + medium.blob.size
        if (big.blob.size + rest > BODY_LIMITS.photoUpload) big = await shrink(f, 1280, 0.72)
        if (big.blob.size + rest > BODY_LIMITS.photoUpload) {
          errors.push(`${f0.name}: foto grande demais para enviar mesmo reduzida (máx. ${fmtMB(BODY_LIMITS.photoUpload)})`)
          continue
        }
        const fd = new FormData()
        fd.set('photo', big.blob, 'foto.jpg')
        fd.set('thumb', small.blob, 'mini.jpg')
        fd.set('medium', medium.blob, 'media.jpg')
        fd.set('width', String(big.w))
        fd.set('height', String(big.h))
        fd.set('takenAt', String(f0.lastModified || Date.now()))
        const r = await fetch(`/cargas/${planId}/fotos`, { method: 'POST', body: fd })
        const j = (await r.json().catch(() => null)) as { ok?: boolean; error?: string } | null
        if (j?.ok) ok++
        else if (j?.error) errors.push(`${f0.name}: ${j.error}`)
        // corte da plataforma (resposta sem JSON): corpo acima do limite
        else if (r.status === 413) errors.push(`${f0.name}: foto grande demais para enviar (máx. ${fmtMB(BODY_LIMITS.photoUpload)} por foto). Tente de novo ou tire a foto com resolução menor`)
        else errors.push(`${f0.name}: falha no envio`)
      } catch {
        errors.push(`${f0.name}: não foi possível ler a imagem`)
      }
    }
    setBusy(null)
    if (input.current) input.current.value = ''
    if (camera.current) camera.current.value = ''
    setMsg(errors.length ? { type: ok ? 'warn' : 'error', text: `${ok} foto(s) anexada(s). ${errors.join(' · ')}` } : { type: 'ok', text: `${ok} foto(s) anexada(s).` })
    router.refresh()
  }

  async function saveCaption(id: number) {
    const r = await updatePhotoCaptionAction(planId, id, captions[id] ?? '').catch(() => ({ ok: false as const, error: 'Falha de comunicação.' }))
    if (!r.ok) return setMsg({ type: 'error', text: r.error })
    setCaptions((c) => Object.fromEntries(Object.entries(c).filter(([k]) => Number(k) !== id)))
    router.refresh()
  }

  async function remove(id: number) {
    if (!window.confirm('Excluir esta foto do carregamento?')) return
    const r = await deletePhotoAction(planId, id).catch(() => ({ ok: false as const, error: 'Falha de comunicação.' }))
    if (!r.ok) return setMsg({ type: 'error', text: r.error })
    router.refresh()
  }

  return (
    <details className="panel no-print" style={{ marginBottom: 8 }} open={open}>
      <summary style={{ cursor: 'pointer' }}>
        <strong>📷 Fotos do carregamento</strong>{' '}
        <span className="muted">
          {photos.length ? `(${photos.length}) · como a carga ficou realmente carregada` : approved ? '· nenhuma ainda — anexe as fotos de como a carga ficou' : '· disponível depois que a carga for aprovada'}
        </span>
      </summary>
      {canUpload && approved && (
        <div className="row" style={{ gap: 8, margin: '8px 0', alignItems: 'center', flexWrap: 'wrap' }}>
          <input ref={input} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={(e) => void upload(e.target.files)} />
          {/* celular: abre direto a câmera traseira */}
          <input ref={camera} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={(e) => void upload(e.target.files)} />
          <button className="primary photo-camera" disabled={Boolean(busy)} onClick={() => camera.current?.click()}>
            {busy ?? '📷 Tirar foto'}
          </button>
          <button disabled={Boolean(busy)} onClick={() => input.current?.click()}>
            🖼 Anexar fotos
          </button>
          <small className="muted">Várias de uma vez (celular ou computador). As fotos são reduzidas antes de enviar e podem sair no PDF do pedido.</small>
        </div>
      )}
      {!approved && <p className="muted" style={{ margin: '6px 0' }}>Aprove a carga para anexar as fotos do carregamento.</p>}
      {msg && <div className={`alert ${msg.type}`}>{msg.text}</div>}
      {photos.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 10, marginTop: 8 }}>
          {photos.map((p) => {
            const cap = captions[p.id] ?? p.caption ?? ''
            const dirty = captions[p.id] != null && captions[p.id] !== (p.caption ?? '')
            return (
              <figure key={p.id} style={{ margin: 0, border: '1px solid var(--line, #e3e8ec)', borderRadius: 8, padding: 6 }}>
                <a href={`/cargas/${planId}/fotos/${p.id}`} target="_blank" rel="noopener noreferrer" title="Abrir a foto inteira">
                  {/* eslint-disable-next-line @next/next/no-img-element -- imagem servida pela rota autenticada */}
                  <img src={`/cargas/${planId}/fotos/${p.id}?thumb=1`} alt={p.caption ?? 'foto do carregamento'} style={{ width: '100%', aspectRatio: '4 / 3', objectFit: 'cover', borderRadius: 4, background: '#eef1f4' }} loading="lazy" />
                </a>
                <figcaption style={{ fontSize: 11 }}>
                  {editable ? (
                    <input value={cap} onChange={(e) => setCaptions({ ...captions, [p.id]: e.target.value })} placeholder="legenda (opcional)" maxLength={200} style={{ width: '100%', fontSize: 11, marginTop: 4 }} onKeyDown={(e) => e.key === 'Enter' && dirty && void saveCaption(p.id)} />
                  ) : (
                    p.caption && <div style={{ marginTop: 4 }}>{p.caption}</div>
                  )}
                  <div className="muted" style={{ marginTop: 2 }}>
                    {dt(p.takenAt ?? p.createdAt)}
                    {p.createdBy ? ` · ${p.createdBy}` : ''}
                  </div>
                  {editable && (
                    <div className="row" style={{ gap: 4, marginTop: 4 }}>
                      {dirty && (
                        <button className="small primary" onClick={() => void saveCaption(p.id)}>
                          Salvar legenda
                        </button>
                      )}
                      <span className="spacer" />
                      <button className="small" onClick={() => void remove(p.id)} title="Excluir foto">
                        🗑
                      </button>
                    </div>
                  )}
                </figcaption>
              </figure>
            )
          })}
        </div>
      )}
    </details>
  )
}
