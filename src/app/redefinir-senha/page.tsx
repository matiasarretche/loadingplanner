import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import { resetLinkInvalidMsg, resetTokenValid } from '@/lib/passwordReset'
import { ResetForm } from './ResetForm'

// o token vai na URL: não repassar a URL como Referer nem indexar a página
export const metadata: Metadata = { referrer: 'no-referrer', robots: { index: false, follow: false } }

/** Redefinição de senha pelo link enviado por e-mail (página pública; o token é validado no servidor). */
export default async function RedefinirSenhaPage({ searchParams }: PageProps<'/redefinir-senha'>) {
  const sp = await searchParams
  const token = typeof sp.token === 'string' ? sp.token : ''
  // só consulta (o consumo é atômico, no envio do formulário): link ruim já avisa sem pedir a senha nova
  const valid = await resetTokenValid(token)
  return (
    <div className="login panel">
      <Image src="/brand/pacifil-brasil-verde.png" alt="Pacifil Brasil" width={150} height={74} priority style={{ display: 'block', margin: '0 auto 8px' }} />
      <h1>Redefinir a senha</h1>
      {valid ? (
        <ResetForm token={token} />
      ) : (
        <div className="grid">
          <div className="alert error">{resetLinkInvalidMsg()}</div>
          <Link className="btn primary" href="/login">
            Ir para o login
          </Link>
        </div>
      )}
    </div>
  )
}
