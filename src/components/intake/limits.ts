/**
 * LIMITES DE CORPO das rotas com envio/retorno de arquivos — os mesmos números no navegador e no servidor
 * (sem 'use client' nem 'server-only': os dois lados importam daqui).
 *
 * Na Vercel cada função aceita e devolve no máximo 4,5 MB (acima disso: 413 FUNCTION_PAYLOAD_TOO_LARGE,
 * antes de a rota rodar). Os limites ficam abaixo, com folga para os outros campos do formulário.
 */
const MB = 1024 * 1024

export const BODY_LIMITS = {
  /** teto da plataforma (4,5 MB decimais) — referência para as respostas */
  platform: 4_500_000,
  /** resposta de PDF/arquivo: acima disso a rota explica em vez de deixar a Vercel cortar */
  response: 4.2 * MB,
  /** pedido do cliente para a IA: soma dos anexos + texto */
  intakeTotal: 4 * MB,
  /** PDF enviado por e-mail pelo servidor */
  emailPdf: 4.2 * MB,
  /** uma foto do carregamento (foto + versão média + miniatura) */
  photoUpload: 3.5 * MB,
}

/** imagens dos anexos da IA: lado maior (o modelo reduz tudo o que passar disso) e qualidade JPEG */
export const INTAKE_IMAGE = { maxSide: 1568, quality: 0.8 }

/** "3,7 MB" / "4 MB" (pt-BR, até uma casa); `up` arredonda para cima (um total pouco acima do limite não aparece igual a ele) */
export const fmtMB = (bytes: number, up = false) => `${(up ? Math.ceil((bytes / MB) * 10) / 10 : bytes / MB).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`

/** Bytes que o texto ocupa no envio (UTF-8). */
export const textBytes = (s: string) => new TextEncoder().encode(s).length

/** Soma dos anexos + texto de um pedido para a IA; null = cabe no envio, senão a mensagem para o usuário. */
export function intakeSizeError(files: { size: number }[], text = ''): string | null {
  const total = files.reduce((s, f) => s + f.size, 0) + textBytes(text)
  if (total <= BODY_LIMITS.intakeTotal) return null
  return `Anexos grandes demais para enviar de uma vez: ${fmtMB(total, true)} (máx. ${fmtMB(BODY_LIMITS.intakeTotal)} no total). Remova algum arquivo, envie só as páginas do pedido em PDF ou uma captura de tela.`
}
