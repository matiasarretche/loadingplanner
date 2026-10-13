import 'server-only'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { TECHNOLOGIES, TechKey } from '@/domain/technology'

/** PNG dos selos das tecnologias (public/brand); arquivo ausente = sem selo (o PDF sai só com o texto) */
export async function techSeals(): Promise<Partial<Record<TechKey, Uint8Array | null>>> {
  const keys = Object.keys(TECHNOLOGIES) as TechKey[]
  const files = await Promise.all(keys.map((k) => readFile(path.join(process.cwd(), 'public', TECHNOLOGIES[k].seal)).then((b) => new Uint8Array(b)).catch(() => null)))
  return Object.fromEntries(keys.map((k, i) => [k, files[i]]))
}
