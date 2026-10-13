'use client'

import { useEffect, useRef, useState } from 'react'

/** API de reconhecimento de voz do navegador (Chrome/Edge/Safari: webkitSpeechRecognition). Tipos mínimos. */
interface RecognitionResult {
  isFinal: boolean
  0: { transcript: string }
}
interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  abort?(): void
  onresult: ((e: { resultIndex: number; results: ArrayLike<RecognitionResult> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}
type RecognitionCtor = new () => Recognition

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

const LANGS = [
  { value: 'es-AR', label: 'ES' },
  { value: 'pt-BR', label: 'PT' },
  { value: 'en-US', label: 'EN' },
]
const LS_KEY = 'lp:dictation:lang'

/** encerra um reconhecimento sem deixar um resultado atrasado escrever no campo */
function silence(r: Recognition | null) {
  if (!r) return
  r.onresult = null
  if (r.abort) r.abort()
  else r.stop()
}

/**
 * Microfone: transcreve a fala em texto (o navegador faz o reconhecimento — no iPhone, o Ditado da Apple).
 * O texto vai para o campo para o usuário conferir/corrigir; NÃO envia sozinho — o envio é com Enter ou com o
 * botão, como digitado. O ditado é acrescentado ao texto que já estava no campo (`value`) e entregue em `onChange`.
 */
export function DictationButton({ value, onChange, disabled, size = 'normal' }: { value: string; onChange: (text: string) => void; disabled?: boolean; size?: 'normal' | 'small' }) {
  const [supported, setSupported] = useState(false)
  const [on, setOn] = useState(false)
  const [lang, setLang] = useState('es-AR')
  const [err, setErr] = useState<string | null>(null)
  const rec = useRef<Recognition | null>(null)
  const base = useRef('')

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- detecção do navegador e preferência local (só no cliente) */
    setSupported(Boolean(recognitionCtor()))
    try {
      const l = localStorage.getItem(LS_KEY)
      if (l && LANGS.some((x) => x.value === l)) setLang(l)
    } catch {
      /* sem armazenamento local */
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    return () => silence(rec.current)
  }, [])

  // o campo foi enviado (tela ocupada): para o ditado, senão o texto enviado volta para o campo
  useEffect(() => {
    if (!disabled || !rec.current) return
    silence(rec.current)
    rec.current = null
    // o botão volta ao estado "parado"
    setOn(false)
  }, [disabled])

  if (!supported) return null

  function start() {
    const Ctor = recognitionCtor()
    if (!Ctor) return
    silence(rec.current)
    const r = new Ctor()
    r.lang = lang
    r.continuous = true
    r.interimResults = true
    base.current = value.trim() ? `${value.trim()} ` : ''
    r.onresult = (e) => {
      if (rec.current !== r) return // reconhecimento antigo: ignora
      // o texto inteiro desta sessão a cada evento: o Safari do iPhone reenvia resultados já finais,
      // e somar só os novos duplicaria frases. Só o ditado é normalizado (o texto anterior fica como estava).
      let all = ''
      for (let i = 0; i < e.results.length; i++) all += `${e.results[i][0].transcript} `
      onChange(base.current + all.replace(/\s+/g, ' ').trimStart())
    }
    r.onerror = (e) => {
      if (rec.current !== r) return
      if (e.error === 'aborted') return
      setErr(
        e.error === 'not-allowed'
          ? 'Permita o uso do microfone no navegador.'
          : e.error === 'service-not-allowed'
            ? 'Ative o Ditado do aparelho (iPhone: Ajustes › Geral › Teclado › Ativar Ditado) ou use o microfone do teclado.'
            : e.error === 'no-speech'
              ? 'Não ouvi nada. Tente de novo.'
              : 'Falha no reconhecimento de voz.',
      )
      setOn(false)
    }
    r.onend = () => {
      if (rec.current === r) setOn(false)
    }
    rec.current = r
    setErr(null)
    setOn(true)
    r.start()
  }

  function stop() {
    // stop (não abort): o último trecho ainda é entregue, pelo mesmo reconhecimento
    rec.current?.stop()
    setOn(false)
  }

  const s = size === 'small' ? { fontSize: 12, padding: '2px 6px' } : {}
  return (
    <span className="dictation" style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      <button
        type="button"
        className={on ? 'danger' : undefined}
        style={s}
        disabled={disabled && !on}
        onClick={() => (on ? stop() : start())}
        title={on ? 'Parar de ditar (depois confira o texto e envie com Enter)' : 'Ditar por voz: fale e o texto aparece no campo para você conferir antes de enviar'}
        aria-pressed={on}
      >
        {on ? '⏹ Parar' : '🎤'}
      </button>
      <select
        className="dictation-lang"
        value={lang}
        disabled={on || disabled}
        onChange={(e) => {
          setLang(e.target.value)
          try {
            localStorage.setItem(LS_KEY, e.target.value)
          } catch {
            /* sem armazenamento local */
          }
        }}
        title="Idioma do ditado"
        aria-label="Idioma do ditado"
        style={{ fontSize: 11, padding: '2px 2px', width: 46 }}
      >
        {LANGS.map((l) => (
          <option key={l.value} value={l.value}>
            {l.label}
          </option>
        ))}
      </select>
      {err && <small style={{ color: '#d62728', marginLeft: 4 }}>{err}</small>}
    </span>
  )
}
