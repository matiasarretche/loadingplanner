'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'
import { AVATAR_EMOJIS, AvatarRef } from '@/lib/avatar'
import { saveAvatarAction } from './actions'

/** Recorta o centro da imagem em quadrado e reduz para 160 px (JPEG) antes de enviar. */
async function toSquareJpeg(file: File, size = 160): Promise<string> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => {
      const i = new Image()
      i.onload = () => ok(i)
      i.onerror = () => fail(new Error('Imagem inválida'))
      i.src = url
    })
    const side = Math.min(img.naturalWidth, img.naturalHeight)
    const c = document.createElement('canvas')
    c.width = c.height = size
    const g = c.getContext('2d')!
    g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size)
    return c.toDataURL('image/jpeg', 0.85)
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function AvatarPicker({ current, taken }: { current: AvatarRef; taken: Record<string, string> }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ type: 'ok' | 'error'; text: string } | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function save(input: { emoji?: string; photo?: string } | null, okText: string) {
    setBusy(true)
    setMsg(null)
    try {
      const r = await saveAvatarAction(input)
      if (r.ok) {
        setMsg({ type: 'ok', text: okText })
        setPreview(null)
        router.refresh()
      } else setMsg({ type: 'error', text: r.error })
    } catch {
      setMsg({ type: 'error', text: 'Falha de comunicação com o servidor.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>Avatar</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Escolha um emoji ou suba uma foto sua. Ele aparece na barra superior, em “Criado por” e na lista de usuários. Cada avatar é único: os já usados por colegas aparecem bloqueados.
      </p>
      {msg && <div className={`alert ${msg.type}`}>{msg.text}</div>}

      <div className="avatar-grid">
        {AVATAR_EMOJIS.map((e) => {
          const owner = taken[e]
          const mine = current === e
          return (
            <button
              key={e}
              className={`avatar-opt ${mine ? 'on' : ''}`}
              disabled={busy || Boolean(owner)}
              title={owner ? `Já usado por ${owner}` : mine ? 'Seu avatar atual' : 'Usar este emoji'}
              onClick={() => save({ emoji: e }, 'Avatar atualizado.')}
            >
              {e}
              {owner && <span className="avatar-taken">✕</span>}
            </button>
          )
        })}
      </div>

      <div className="row" style={{ marginTop: 14, alignItems: 'center' }}>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          style={{ display: 'none' }}
          onChange={async (e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (!f) return
            try {
              setPreview(await toSquareJpeg(f))
              setMsg(null)
            } catch {
              setMsg({ type: 'error', text: 'Não foi possível ler essa imagem.' })
            }
          }}
        />
        <button onClick={() => fileRef.current?.click()} disabled={busy}>
          📷 Subir uma foto…
        </button>
        {preview && (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element -- pré-visualização local (data URL) */}
            <img src={preview} alt="Pré-visualização" width={56} height={56} style={{ borderRadius: '50%', objectFit: 'cover' }} />
            <button className="primary" disabled={busy} onClick={() => save({ photo: preview }, 'Foto salva como avatar.')}>
              Usar esta foto
            </button>
            <button disabled={busy} onClick={() => setPreview(null)}>
              Cancelar
            </button>
          </>
        )}
        <span className="spacer" />
        {current && (
          <button className="danger" disabled={busy} onClick={() => save(null, 'Avatar removido: voltam as iniciais do nome.')}>
            Remover avatar
          </button>
        )}
      </div>
    </div>
  )
}
