/**
 * Redefine a senha de um usuário (uso local do administrador). A senha é digitada no terminal,
 * sem eco, e nunca fica em arquivo nem no histórico.
 * Uso: npx tsx --env-file=.env scripts/reset-password.ts email@empresa.com
 */
import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import { db, schema } from '../src/db'

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin
    process.stdout.write(question)
    stdin.setRawMode?.(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let s = ''
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode?.(false)
          stdin.pause()
          stdin.off('data', onData)
          process.stdout.write('\n')
          return resolve(s)
        }
        if (c === '\u0003') process.exit(1) // Ctrl+C
        if (c === '\u007f' || c === '\b') s = s.slice(0, -1)
        else s += c
      }
    }
    stdin.on('data', onData)
  })
}

async function main() {
  const email = (process.argv[2] ?? '').trim().toLowerCase()
  if (!email) throw new Error('Informe o e-mail: npx tsx --env-file=.env scripts/reset-password.ts email@empresa.com')
  const u = await db.query.users.findFirst({ where: eq(schema.users.email, email) })
  if (!u) throw new Error(`Usuário ${email} não encontrado.`)
  const p1 = await ask('Nova senha (mín. 10 caracteres): ')
  if (p1.length < 10) throw new Error('A senha deve ter pelo menos 10 caracteres.')
  const p2 = await ask('Repita a nova senha: ')
  if (p1 !== p2) throw new Error('As senhas não conferem.')
  await db.update(schema.users).set({ passwordHash: await bcrypt.hash(p1, 12), active: true, mustChangePassword: false, updatedAt: new Date() }).where(eq(schema.users.id, u.id))
  await db.insert(schema.auditLog).values({ entity: 'app_user', entityId: u.id, action: 'reset_password_cli', diff: { email } })
  console.log(`Senha de ${email} redefinida. Já pode entrar em http://localhost:3000/login`)
}
main().then(() => process.exit(0), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
