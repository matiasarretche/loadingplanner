/**
 * Imprime um PDF direto do navegador: carrega o arquivo num iframe oculto e abre o diálogo de impressão.
 * Se o navegador não permitir (alguns bloqueiam print() em PDFs embutidos), abre o PDF numa aba nova
 * para imprimir de lá.
 */
export function printPdfBlob(blob: Blob) {
  const url = URL.createObjectURL(blob)
  const frame = document.createElement('iframe')
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
  frame.src = url
  const cleanup = () => {
    frame.remove()
    URL.revokeObjectURL(url)
  }
  frame.onload = () => {
    try {
      frame.contentWindow?.focus()
      frame.contentWindow?.print()
      // o diálogo é assíncrono em alguns navegadores: remove só bem depois
      setTimeout(cleanup, 60_000)
    } catch {
      window.open(url, '_blank')
      setTimeout(cleanup, 60_000)
    }
  }
  document.body.appendChild(frame)
}

/** Baixa o PDF com o nome dado. */
export function downloadPdfBlob(blob: Blob, name: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}
