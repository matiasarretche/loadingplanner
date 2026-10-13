/** Violação de unicidade do PostgreSQL (23505), inclusive quando embrulhada pelo Drizzle. */
export function isUniqueViolation(e: unknown): boolean {
  for (let cur: unknown = e, i = 0; cur && i < 5; cur = (cur as { cause?: unknown }).cause, i++) {
    if ((cur as { code?: string }).code === '23505') return true
  }
  return false
}
