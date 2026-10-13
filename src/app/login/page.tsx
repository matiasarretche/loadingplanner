import Image from 'next/image'
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { mailConfigured } from '@/lib/mailer'
import { LoginForm } from './LoginForm'

export default async function LoginPage() {
  if (await getCurrentUser()) redirect('/')
  return (
    <div className="login panel">
      <Image src="/brand/pacifil-brasil-verde.png" alt="Pacifil Brasil" width={150} height={74} priority style={{ display: 'block', margin: '0 auto 8px' }} />
      <h1>Export Load Planner</h1>
      <LoginForm resetByEmail={mailConfigured()} />
    </div>
  )
}
