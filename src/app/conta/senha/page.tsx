import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { PasswordForm } from './PasswordForm'

export default async function PasswordPage() {
  const u = await getCurrentUser()
  if (!u) redirect('/login')
  return (
    <div className="login panel">
      <h1>Alterar senha</h1>
      {u.mustChangePassword && <div className="alert warn">Defina uma nova senha para continuar.</div>}
      <PasswordForm />
    </div>
  )
}
