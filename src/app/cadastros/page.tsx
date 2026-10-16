import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { RESOURCES } from '@/lib/resources'

const DESC: Record<string, string> = {
  paletes: 'Medidas, tara, capacidade, overhang e ISPM-15 de cada tipo de palete.',
  conteineres: 'Interno, porta, tara, payload e bruto por tipo/naviera. Referências editáveis.',
  veiculos: 'Caminhões, semirreboques e chassis porta-contêiner, com a geometria dos eixos.',
  cavalos: 'Cavalos mecânicos: entre-eixos, 5ª roda e taras por eixo (distribuição de peso).',
  'limites-eixo': 'Limites legais por conjunto de eixos e PBTC, por país (Brasil, MERCOSUL…).',
  perfis: 'Limites de transportador, legais, de rota e tolerâncias operacionais de validação.',
  clientes: 'Clientes: código do ERP, razão social, endereço e agente (vendas com comissão).',
  transportadoras: 'Empresas transportadoras: código, contato, telefone e e-mail. Escolhidas em cada carga.',
  agentes: 'Agentes comerciais: as exceções de comissão ficam em Preços exportação.',
}

export default async function CadastrosPage() {
  await requireUser()
  return (
    <>
      <h1>Cadastros</h1>
      <div className="grid two">
        {Object.entries(RESOURCES).map(([k, r]) => (
          <Link key={k} href={`/cadastros/${k}`} className="panel">
            <strong>{r.title}</strong>
            <div className="muted">{DESC[k]}</div>
          </Link>
        ))}
        <Link href="/catalogo" className="panel">
          <strong>Catálogo logístico</strong>
          <div className="muted">Produtos, SKUs, embalagens e paletes padrão.</div>
        </Link>
      </div>
    </>
  )
}
