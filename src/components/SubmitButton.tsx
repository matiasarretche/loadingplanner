'use client'

import { useFormStatus } from 'react-dom'

/** Botão de formulário que trava enquanto a ação roda (um clique só; sem envio duplicado). */
export function SubmitButton({ children, className, disabled, title, pendingText }: { children: React.ReactNode; className?: string; disabled?: boolean; title?: string; pendingText?: string }) {
  const { pending } = useFormStatus()
  return (
    <button className={className} disabled={disabled || pending} title={title} aria-busy={pending}>
      {pending ? pendingText ?? 'Aguarde…' : children}
    </button>
  )
}
