/** Ícones de traço (SVG inline, sem dependências), 24×24, herdam a cor do texto. */
import type { ReactNode, SVGProps } from 'react'

const P: Record<string, ReactNode> = {
  box: (
    <>
      <path d="M21 8 12 3 3 8v8l9 5 9-5V8Z" />
      <path d="m3 8 9 5 9-5M12 13v8" />
    </>
  ),
  volume: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="1.5" />
      <path d="M7 6v13M11 6v13M15 6v13M19 6v13M3 10h18" />
    </>
  ),
  weight: (
    <>
      <path d="M6 8h12l2 12H4L6 8Z" />
      <circle cx="12" cy="5" r="2" />
    </>
  ),
  chart: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  review: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </>
  ),
  check: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" />
    </>
  ),
  ship: (
    <>
      <path d="M3 17l2 4h14l2-4H3Z" />
      <path d="M6 17V9h12v8M9 9V5h6v4" />
    </>
  ),
  truck: (
    <>
      <path d="M2 6h12v10H2zM14 10h4l3 3v3h-7" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="17" cy="18" r="2" />
    </>
  ),
  plane: <path d="M10 21l2-7-7-3V9l8 1 3-7h2l-1 8 6 1v2l-6 1 1 8h-2l-3-6-3 6z" />,
  status: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  filter: <path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z" />,
  download: <path d="M12 4v11m0 0-4-4m4 4 4-4M4 20h16" />,
  columns: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M15 4v16" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.3" />
      <circle cx="12" cy="12" r="1.3" />
      <circle cx="19" cy="12" r="1.3" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  sparkle: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3ZM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z" />,
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  board: (
    <>
      <rect x="3" y="4" width="5" height="16" rx="1" />
      <rect x="10" y="4" width="5" height="11" rx="1" />
      <rect x="17" y="4" width="4" height="7" rx="1" />
    </>
  ),
  alert: (
    <>
      <path d="M12 3 2 20h20L12 3Z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  chevron: <path d="m6 9 6 6 6-6" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
}

export type IconName = keyof typeof P

export function Icon({ name, size = 18, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>
      {P[name]}
    </svg>
  )
}
