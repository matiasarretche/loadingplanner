/** Cria/atualiza o usuário de QA local (EXPORT_MANAGER) a partir de QA_EMAIL/QA_PASSWORD do .env. */
import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import { db, schema } from '../src/db'

async function main() {
  const email = process.env.QA_EMAIL?.toLowerCase()
  const pw = process.env.QA_PASSWORD
  if (!email || !pw) throw new Error('QA_EMAIL/QA_PASSWORD ausentes no .env')
  const hash = await bcrypt.hash(pw, 12)
  const u = await db.query.users.findFirst({ where: eq(schema.users.email, email) })
  if (u) await db.update(schema.users).set({ passwordHash: hash, mustChangePassword: false, active: true }).where(eq(schema.users.id, u.id))
  else await db.insert(schema.users).values({ email, name: 'QA local', role: 'EXPORT_MANAGER', passwordHash: hash, mustChangePassword: false })
  console.log(`Usuário QA pronto: ${email}`)
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
