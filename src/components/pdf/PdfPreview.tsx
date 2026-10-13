'use client'

import { useEffect, useMemo, useState } from 'react'
import type { PdfLang } from '@/lib/pdf/i18n'
import { downloadPdfBlob, printPdfBlob } from '@/lib/pdf/printPdf'
import { BODY_LIMITS, fmtMB } from '@/components/intake/limits'

// mensagem só para o e-mail; no WhatsApp/compartilhamento vai SÓ o arquivo, sem texto
const MSG: Record<PdfLang, { body: (doc: string) => string }> = {
  pt: {
    body: (d) => `Olá,\n\nSegue em anexo ${d}.\n\nFicamos à disposição para qualquer dúvida.\n\nAtenciosamente,\nPacifil Brasil — Departamento de Exportação`,
  },
  es: {
    body: (d) => `Hola,\n\nAdjuntamos ${d}.\n\nQuedamos a disposición por cualquier consulta.\n\nSaludos cordiales,\nPacifil Brasil — Departamento de Exportación`,
  },
  en: {
    body: (d) => `Hello,\n\nPlease find attached ${d}.\n\nPlease let us know if you have any questions.\n\nBest regards,\nPacifil Brasil — Export Department`,
  },
}

/**
 * Contexto do documento enviado por e-mail (vai junto no formulário; o servidor registra o envio onde couber).
 * export-summary: resumo para o cliente das Exportações → "Resumo enviado ao cliente" no histórico das operações.
 */
export type PdfEmailContext = { kind: 'export-summary'; operationIds: number[] }

/**
 * Prévia do PDF gerado, com as ações: baixar, imprimir, enviar por e-mail (pelo servidor, com anexo)
 * e compartilhar (WhatsApp/apps do sistema). Nada sai da plataforma sem o clique do usuário.
 */
export function PdfPreview({ blob, fileName, subject, docLabel, lang, onClose, emailContext, onEmailSent }: {
  blob: Blob
  fileName: string
  /** assunto sugerido do e-mail */
  subject: string
  /** descrição do documento nas mensagens ("o resumo do pedido OC-123") */
  docLabel: string
  lang: PdfLang
  onClose: () => void
  /** opcional: contexto do documento, enviado com o e-mail (registro do envio no servidor) */
  emailContext?: PdfEmailContext
  /** opcional: chamado depois de um envio por e-mail bem-sucedido (ex.: atualizar o histórico na tela) */
  onEmailSent?: () => void
}) {
  // link do PDF criado e liberado no mesmo efeito (no modo estrito do React o efeito roda duas vezes)
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const u = URL.createObjectURL(blob)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- URL do blob depende do navegador
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [blob])
  const file = useMemo(() => new File([blob], fileName, { type: 'application/pdf' }), [blob, fileName])
  const [mail, setMail] = useState<{ to: string; cc: string; subject: string; message: string } | null>(null)
  const [sending, setSending] = useState(false)
  const [msg, setMsg] = useState<{ type: 'ok' | 'error' | 'warn'; text: string } | null>(null)
  const [mailConfigured, setMailConfigured] = useState<boolean | null>(null)
  const canShare = typeof navigator !== 'undefined' && Boolean(navigator.canShare?.({ files: [file] }))
  // o e-mail sai pelo servidor: o PDF sobe inteiro e a Vercel corta o corpo em 4,5 MB
  const tooBigForMail = blob.size > BODY_LIMITS.emailPdf
  const tooBigText = `Este PDF tem ${fmtMB(blob.size, true)} e passa do limite para envio pelo servidor (${fmtMB(BODY_LIMITS.emailPdf)}). Use “Baixar” e anexe no seu e-mail, ou “${canShare ? 'Compartilhar' : 'WhatsApp'}”; ou gere o PDF com menos fotos.`

  useEffect(() => {
    void fetch('/email/pdf')
      .then((r) => r.json())
      .then((j: { configured?: boolean }) => setMailConfigured(Boolean(j.configured)))
      .catch(() => setMailConfigured(false))
  }, [])

  async function sendMail() {
    if (!mail) return
    if (tooBigForMail) return setMsg({ type: 'warn', text: tooBigText })
    setSending(true)
    setMsg(null)
    try {
      const fd = new FormData()
      fd.set('to', mail.to)
      fd.set('cc', mail.cc)
      fd.set('subject', mail.subject)
      fd.set('message', mail.message)
      fd.set('file', file)
      if (emailContext) fd.set('context', JSON.stringify(emailContext))
      const r = await fetch('/email/pdf', { method: 'POST', body: fd })
      const j = (await r.json().catch(() => null)) as { ok?: boolean; error?: string } | null
      if (j?.ok) {
        setMsg({ type: 'ok', text: `E-mail enviado para ${mail.to}.` })
        setMail(null)
        onEmailSent?.()
      } else if (j?.error) setMsg({ type: 'error', text: j.error })
      // corte da plataforma (resposta sem JSON): corpo grande demais ou tempo esgotado
      else if (r.status === 413) setMsg({ type: 'error', text: tooBigText })
      else if (r.status === 504) setMsg({ type: 'error', text: 'O envio demorou demais e foi interrompido — o e-mail pode ter saído ou não. Confirme com o destinatário antes de tentar de novo, ou use “Baixar”.' })
      else setMsg({ type: 'error', text: 'Não foi possível enviar o e-mail.' })
    } catch {
      setMsg({ type: 'error', text: 'Falha de comunicação com o servidor.' })
    } finally {
      setSending(false)
    }
  }

  async function share() {
    try {
      // só o PDF: sem título nem texto (alguns apps enviam o título como mensagem)
      await navigator.share({ files: [file] })
    } catch {
      /* cancelado pelo usuário */
    }
  }

  /** WhatsApp sem compartilhamento do sistema: baixa o PDF e abre o WhatsApp Web, sem mensagem pronta (o arquivo é anexado no WhatsApp). */
  function whatsapp() {
    downloadPdfBlob(blob, fileName)
    window.open('https://web.whatsapp.com/', '_blank', 'noopener')
    setMsg({ type: 'warn', text: `O PDF foi baixado (${fileName}). No WhatsApp, escolha o contato e anexe o arquivo baixado (📎 → Documento).` })
  }

  return (
    <div className="overlay-full" style={{ display: 'grid', placeItems: 'center', background: 'rgba(13,43,34,.55)' }}>
      <div className="panel" style={{ width: 'min(1100px, 96vw)', height: '94vh', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="row" style={{ alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>📄 Prévia do PDF</h3>
          <small className="muted">{fileName}</small>
          <span className="spacer" />
          <button className="primary" onClick={() => downloadPdfBlob(blob, fileName)}>
            ⬇ Baixar
          </button>
          <button onClick={() => printPdfBlob(blob)}>🖨 Imprimir</button>
          <button
            // PDF acima do limite do servidor: explica e indica Baixar/Compartilhar (não abre o formulário)
            onClick={() => (tooBigForMail ? (setMail(null), setMsg({ type: 'warn', text: tooBigText })) : (setMsg(null), setMail(mail ? null : { to: '', cc: '', subject, message: MSG[lang].body(docLabel) })))}
            title={tooBigForMail ? `PDF grande demais para o envio pelo servidor (máx. ${fmtMB(BODY_LIMITS.emailPdf)}): use Baixar ou Compartilhar` : mailConfigured === false ? 'Envio pelo servidor ainda não configurado (veja a mensagem ao abrir)' : 'Envia o PDF anexado a partir da plataforma'}
          >
            ✉ E-mail
          </button>
          {canShare ? (
            <button onClick={() => void share()} title="Abre o compartilhamento do sistema com o PDF anexado (WhatsApp, Outlook, Teams…)">
              Compartilhar / WhatsApp
            </button>
          ) : (
            <button onClick={whatsapp} title="Baixa o PDF e abre o WhatsApp (sem mensagem; anexe o arquivo baixado)">
              WhatsApp
            </button>
          )}
          <button onClick={onClose}>Fechar</button>
        </div>
        {msg && <div className={`alert ${msg.type}`} style={{ margin: 0 }}>{msg.text}</div>}
        {mail && (
          <div className="panel" style={{ margin: 0, background: '#f7faf8' }}>
            {mailConfigured === false && (
              <div className="alert warn" style={{ marginTop: 0 }}>
                O envio de e-mail pelo servidor ainda não está configurado (falta a conta SMTP da empresa no servidor). Enquanto isso, use “Baixar” e anexe no seu e-mail, ou “Compartilhar”.
              </div>
            )}
            <div className="form-grid">
              <label className="field">
                Para *
                <input type="email" multiple value={mail.to} onChange={(e) => setMail({ ...mail, to: e.target.value })} placeholder="cliente@empresa.com (vários: separe com vírgula)" autoFocus />
              </label>
              <label className="field">
                Cc
                <input value={mail.cc} onChange={(e) => setMail({ ...mail, cc: e.target.value })} placeholder="opcional" />
              </label>
              <label className="field" style={{ gridColumn: 'span 2' }}>
                Assunto *
                <input value={mail.subject} onChange={(e) => setMail({ ...mail, subject: e.target.value })} />
              </label>
            </div>
            <label className="field">
              Mensagem
              <textarea rows={6} value={mail.message} onChange={(e) => setMail({ ...mail, message: e.target.value })} />
            </label>
            <div className="row" style={{ gap: 6, alignItems: 'center' }}>
              <button className="primary" disabled={sending || !mail.to.trim() || !mail.subject.trim() || mailConfigured === false || tooBigForMail} onClick={() => void sendMail()}>
                {sending ? 'Enviando…' : `Enviar com o PDF anexado`}
              </button>
              <button onClick={() => setMail(null)} disabled={sending}>
                Cancelar
              </button>
              <small className="muted">📎 {fileName} · as respostas do cliente chegam no seu e-mail</small>
            </div>
          </div>
        )}
        {url && <iframe src={url} title="Prévia do PDF" style={{ flex: 1, width: '100%', border: '1px solid #d5dde3', borderRadius: 8, background: '#fff' }} />}
      </div>
    </div>
  )
}
