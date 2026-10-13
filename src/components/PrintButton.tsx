'use client'

export function PrintButton() {
  return (
    <button className="primary" onClick={() => window.print()}>
      Imprimir / salvar PDF
    </button>
  )
}
