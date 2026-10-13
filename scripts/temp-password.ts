/**
 * Gera uma SENHA TEMPORÁRIA aleatória para um usuário, grava num arquivo local (não no terminal)
 * e obriga a troca no primeiro acesso.
 * Uso: npx tsx --env-file=.env scripts/temp-password.ts email@empresa.com caminho\arquivo.txt
 */
import bcrypt from 'bcryptjs'
import { randomInt } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { db, schema } from '../src/db'

// sem caracteres ambíguos (0/O, 1/l/I)
const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'

async function main() {
  const email = (process.argv[2] ?? '').trim().toLowerCase()
  const out = process.argv[3]
  if (!email || !out) throw new Error('Uso: temp-password.ts email arquivo.txt')
  const u = await db.query.users.findFirst({ where: eq(schema.users.email, email) })
  if (!u) throw new Error(`Usuário ${email} não encontrado.`)
  const pw = Array.from({ length: 12 }, () => CHARS[randomInt(CHARS.length)]).join('')
  await db.update(schema.users).set({ passwordHash: await bcrypt.hash(pw, 12), active: true, mustChangePassword: true, updatedAt: new Date() }).where(eq(schema.users.id, u.id))
  await db.insert(schema.auditLog).values({ entity: 'app_user', entityId: u.id, action: 'temp_password_cli', diff: { email } })
  writeFileSync(
    out,
    [
      'PACIFIL LOAD PLANNER - SENHA TEMPORARIA',
      '',
      `Endereco:  http://localhost:3000/login`,
      `E-mail:    ${email}`,
      `Senha:     ${pw}`,
      '',
      'Ao entrar, o sistema vai pedir para criar uma senha nova (minimo 10 caracteres).',
      'Depois de trocar, feche e apague este arquivo.',
    ].join('\r\n'),
  )
  console.log(`Senha temporária gerada para ${email} (gravada no arquivo, não exibida).`)
}
main().then(() => process.exit(0), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
