'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { PdfPreview } from '@/components/pdf/PdfPreview'
import { FIELD_LABEL, SUMMARY_MESSAGE_MAX, SUMMARY_SECTION_LABEL, SUMMARY_SECTIONS, SUMMARY_TRACKING_FIELDS, SummarySection } from '@/domain/exportTracking'
import { defaultPdfLang, PdfLang } from '@/lib/pdf/i18n'
import { pdfUnsupportedChars } from '@/lib/pdf/winAnsi'
import { useUnsavedTracking } from './UnsavedTracking'

const LANGS: [PdfLang, string][] = [
  ['es', 'Español'],
  ['pt', 'Português'],
  ['en', 'English'],
]

/** assunto do e-mail e descrição do documento na mensagem (no idioma do PDF) */
const SUBJECT: Record<PdfLang, (ref: string | null) => string> = {
  es: (r) => `Estado del embarque${r ? ` — ${r}` : ''} — Pacifil Brasil`,
  pt: (r) => `Status do embarque${r ? ` — ${r}` : ''} — Pacifil Brasil`,
  en: (r) => `Shipment status${r ? ` — ${r}` : ''} — Pacifil Brasil`,
}
const DOC_LABEL: Record<PdfLang, (ref: string | null) => string> = {
  es: (r) => `el estado actualizado del embarque${r ? ` (${r})` : ''}`,
  pt: (r) => `o status atualizado do embarque${r ? ` (${r})` : ''}`,
  en: (r) => `the updated shipment status${r ? ` (${r})` : ''}`,
}

/**
 * "Resumo para o cliente (PDF)" no seguimento de uma exportação: PDF "Status do embarque" para mandar ao
 * cliente (idioma, seções, outras cargas do pedido e uma mensagem opcional), aberto na prévia (baixar,
 * imprimir, e-mail, WhatsApp). O servidor monta o conteúdo só com dados que podem sair da empresa e registra
 * no histórico "Resumo para o cliente gerado" — e, se for enviado por e-mail pela plataforma, "Resumo enviado".
 */
export function SummaryButton({ operationId, country, orderRef, siblingOps }: {
  operationId: number
  /** país de destino (idioma sugerido) */
  country: string
  /** referência rotulada ("Proforma 192.26") para o assunto do e-mail; null = sem referência */
  orderRef: string | null
  /** outras cargas do pedido que têm seguimento */
  siblingOps: number
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [lang, setLang] = useState<PdfLang>(() => defaultPdfLang(country))
  const [sections, setSections] = useState<SummarySection[]>(() => [...SUMMARY_SECTIONS])
  const [siblings, setSiblings] = useState(siblingOps > 0)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pdf, setPdf] = useState<{ blob: Blob; name: string; lang: PdfLang; operationIds: number[] } | null>(null)
  // campos do Seguimento que entram no resumo, alterados e não salvos: o PDF usa os dados salvos
  const unsaved = useUnsavedTracking()?.changed ?? []
  const pending = SUMMARY_TRACKING_FIELDS.filter((k) => unsaved.includes(k)).map((k) => FIELD_LABEL[k])
  // emojis e símbolos que as fontes do PDF (WinAnsi) não têm
  const lost = pdfUnsupportedChars(message)

  // Esc fecha (exceto durante a geração)
  useEffect(() => {
    if (!open) return
    const fn = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) setOpen(false)
    }
    document.addEventListener('keydown', fn)
    return () => document.removeEventListener('keydown', fn)
  }, [open, busy])

  const toggle = (s: SummarySection, on: boolean) => setSections((xs) => (on ? [...xs, s] : xs.filter((x) => x !== s)))

  async function generate() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/exportacoes/${operationId}/pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lang, sections: SUMMARY_SECTIONS.filter((s) => sections.includes(s)), message: message.trim() || null, includeSiblings: siblingOps > 0 && siblings }),
      })
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(j?.error ?? 'Não foi possível gerar o resumo.')
      }
      const blob = await res.blob()
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'status-embarque.pdf'
      const ids = (res.headers.get('X-Summary-Operations') ?? '')
        .split(',')
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0)
      setPdf({ blob, name, lang, operationIds: ids.length ? ids : [operationId] })
      setOpen(false)
      // histórico: "Resumo para o cliente gerado (…)"
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível gerar o resumo.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className="small"
        onClick={() => {
          setError(null)
          setOpen(true)
        }}
        title="PDF “Status do embarque” para o cliente: etapa atual, datas, embarque, contêineres e produtos (sem dados internos)"
      >
        Resumo para o cliente (PDF)
      </button>
      {open && (
        <div className="overlay-full" style={{ display: 'grid', placeItems: 'center', background: 'rgba(13,43,34,.55)' }} onClick={(e) => e.target === e.currentTarget && !busy && setOpen(false)}>
          <div className="panel" role="dialog" aria-modal="true" aria-labelledby="summary-pdf-title" style={{ width: 'min(560px, 94vw)', textAlign: 'left' }}>
            <h3 id="summary-pdf-title" style={{ marginTop: 0 }}>
              Resumo para o cliente (PDF)
            </h3>
            <p className="muted" style={{ margin: '0 0 12px', fontSize: 13 }}>
              Status do embarque para enviar ao cliente. Nunca entram: observações, incidência, atraso, responsável, pagamento, valores, origem dos dados e histórico.
            </p>
            <div style={{ display: 'grid', gap: 12 }}>
              <label className="field">
                Idioma
                <select value={lang} onChange={(e) => setLang(e.target.value as PdfLang)} disabled={busy}>
                  {LANGS.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset style={{ margin: 0 }}>
                <legend>Seções</legend>
                <div style={{ display: 'grid', gap: 6 }}>
                  {SUMMARY_SECTIONS.map((s) => (
                    <label key={s} className="check">
                      <input type="checkbox" checked={sections.includes(s)} onChange={(e) => toggle(s, e.target.checked)} disabled={busy} /> {SUMMARY_SECTION_LABEL[s]}
                    </label>
                  ))}
                </div>
                {!sections.length && (
                  <small style={{ color: 'var(--crit)', display: 'block', marginTop: 6 }}>Marque pelo menos uma seção.</small>
                )}
              </fieldset>
              {siblingOps > 0 && (
                <div>
                  <label className="check">
                    <input type="checkbox" checked={siblings} onChange={(e) => setSiblings(e.target.checked)} disabled={busy} /> Incluir as outras cargas do pedido
                  </label>
                  <small className="muted" style={{ display: 'block', paddingLeft: 26 }}>
                    Um só resumo com {siblingOps === 1 ? 'esta e a outra carga' : `esta e as outras ${siblingOps} cargas`} com seguimento: contêiner, lacre e produtos de cada uma; dados do embarque uma vez só quando forem iguais.
                  </small>
                </div>
              )}
              <label className="field">
                Mensagem ao cliente (opcional)
                <textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={SUMMARY_MESSAGE_MAX} disabled={busy} placeholder="Aparece em destaque no início do PDF, no idioma escolhido." />
                <small className="muted">
                  {message.length}/{SUMMARY_MESSAGE_MAX}
                </small>
                {lost.length > 0 && (
                  <small style={{ color: 'var(--warn)' }}>
                    Não aparecem no PDF (as fontes do PDF não têm esses caracteres): {lost.join(' ')}
                  </small>
                )}
              </label>
            </div>
            {pending.length > 0 && (
              <div className="alert warn" style={{ margin: '12px 0 0' }}>
                Salve o Seguimento antes: o resumo usa os dados salvos e há alterações não salvas em {pending.join(', ')}.
              </div>
            )}
            {error && (
              <div className="alert error" style={{ margin: '12px 0 0' }}>
                {error}
              </div>
            )}
            <div className="row" style={{ gap: 6, justifyContent: 'flex-end', marginTop: 14 }}>
              <button onClick={() => setOpen(false)} disabled={busy}>
                Cancelar
              </button>
              <button className="primary" disabled={busy || !sections.length || pending.length > 0} title={pending.length ? 'Salve antes: o resumo usa os dados salvos' : undefined} onClick={() => void generate()}>
                {busy ? 'Gerando…' : 'Gerar PDF'}
              </button>
            </div>
          </div>
        </div>
      )}
      {pdf && (
        <PdfPreview
          blob={pdf.blob}
          fileName={pdf.name}
          lang={pdf.lang}
          subject={SUBJECT[pdf.lang](orderRef)}
          docLabel={DOC_LABEL[pdf.lang](orderRef)}
          emailContext={{ kind: 'export-summary', operationIds: pdf.operationIds }}
          // histórico: "Resumo enviado ao cliente por e-mail (…)"
          onEmailSent={() => router.refresh()}
          onClose={() => setPdf(null)}
        />
      )}
    </>
  )
}
