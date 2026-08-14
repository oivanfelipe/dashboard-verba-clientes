/* =========================================================
   Dashboard de verba — camada de dados e renderização.
   Sem framework e sem build: lê a REST do Supabase direto.
   ========================================================= */

import {
  SITUACOES, PLATAFORMAS, brl, dias, dataCurta, dataHora,
  larguraDias, situacaoDe, burnProjecao, diasRestantes,
  STATUS_OPERACIONAL, statusOperacionalDe, ordenarPorStatusOperacional,
  PERIODOS, faixaPeriodo,
} from './calc.js';

import { CONFIG } from './config.js';

const params = new URLSearchParams(location.search);
const MODO_DEMO = params.get('demo') === '1';

const estado = {
  contas: [],
  clientes: [],
  serie: [],
  campanhas: [],
  sinais: {},
  statusCampanhas: {},
  ultimoAporte: {},
  historico: [],
  historicoCarteira: [],
  aba: 'global',
  clienteSel: null,
  investCliente: null, // null = carteira inteira na aba Investimentos
  periodo: '30d',
  ultimoSync: null,
};

/* =========================================================
   Acesso a dados
   ========================================================= */

async function buscar(view, query = '') {
  const url = `${CONFIG.SUPABASE_URL}/rest/v1/${view}?select=*${query}`;
  const r = await fetch(url, {
    headers: {
      apikey: CONFIG.SUPABASE_KEY,
      Authorization: `Bearer ${CONFIG.SUPABASE_KEY}`,
      Accept: 'application/json',
    },
  });
  if (!r.ok) throw new Error(`${view}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function carregar() {
  if (MODO_DEMO) {
    const d = gerarDemo();
    Object.assign(estado, d);
    return;
  }
  const [contas, clientes, serie, campanhas, sinais, statusCampanhas, ultimoAporte,
         historico, histCarteira, sync] = await Promise.all([
    buscar('inv_account_status'),
    buscar('inv_client_overview'),
    buscar('inv_spend_series', '&order=data.asc'),
    buscar('inv_campanhas_resumo', '&order=gasto_30d.desc').catch(() => []),
    buscar('inv_sinal_saldo').catch(() => []),
    buscar('inv_status_campanhas').catch(() => []),
    buscar('inv_ultimo_aporte').catch(() => []),
    buscar('inv_historico_mensal', '&order=mes.asc').catch(() => []),
    buscar('inv_historico_carteira', '&order=mes.asc').catch(() => []),
    buscar('inv_sync_status').catch(() => []),
  ]);
  estado.contas = contas;
  estado.clientes = clientes;
  estado.serie = serie;
  estado.campanhas = campanhas;
  estado.sinais = Object.fromEntries(sinais.map((s) => [s.account_id, s]));
  estado.statusCampanhas = Object.fromEntries(statusCampanhas.map((s) => [s.account_id, s]));
  estado.ultimoAporte = Object.fromEntries(ultimoAporte.map((a) => [a.account_id, a]));
  estado.historico = historico;
  estado.historicoCarteira = histCarteira;
  estado.ultimoSync = sync?.[0]?.ultimo_sync_ok ?? null;
}

/* =========================================================
   Helpers de marcação
   ========================================================= */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// Cor da barra segue o mesmo status operacional exibido na coluna Status —
// um único vocabulário, não dois cruzados.
const corPorTom = (tom) => ({
  critico: 'var(--critico)', atencao: 'var(--atencao)', ok: 'var(--ok)',
}[tom] ?? 'var(--linha-forte)');

const barraDias = (d, statusOp) => `
  <div class="dias">
    <span class="dias-num">${d ?? '—'}</span>
    <span class="dias-barra" role="img" aria-label="${esc(dias(d))} restantes">
      <span class="dias-fill" style="width:${larguraDias(d)}%;background:${corPorTom(STATUS_OPERACIONAL[statusOp]?.chip)}"></span>
    </span>
  </div>`;

const plat = (p) =>
  `<span class="plat plat-${esc(p)}">${esc(PLATAFORMAS[p]?.rotulo ?? p)}</span>`;

/* ---------- Status operacional: UM status por conta ----------
   Substitui a antiga combinação de "situação" (ledger) + "sinal de
   entrega" (inferência) + "campanhas ativas" como colunas separadas.
   Ver calc.js:statusOperacionalDe para a ordem de prioridade. */

function calcularStatusOp(conta) {
  const sc = estado.statusCampanhas[conta.account_id];
  const sinal = estado.sinais[conta.account_id]?.sinal;
  return statusOperacionalDe({
    ativo: conta.ativo,
    campanhasTotal: sc ? sc.campanhas_total : null,
    campanhasAtivasHoje: sc ? sc.campanhas_ativas_hoje : null,
    diasSemDadoNovo: sc ? sc.dias_sem_dado_novo : null,
    sinal,
  });
}

function motivoStatusOp(conta, key) {
  const sc = estado.statusCampanhas[conta.account_id];
  const sinal = estado.sinais[conta.account_id];
  switch (key) {
    case 'parada':
      return `${sc?.campanhas_total ?? '?'} campanha(s) cadastrada(s), nenhuma ativa em ${dataCurta(sc?.ultimo_dado)}`;
    case 'sem_sync':
      return `o Windsor não traz dado novo desta conta há ${sc?.dias_sem_dado_novo} dias (última vez em ${dataCurta(sc?.ultimo_dado)})`;
    case 'sem_saldo':
      return `entregou em média ${sinal?.entrega_media_pct}% do orçamento nos últimos 7 dias`;
    case 'saldo_apertado':
      return `entregou em média ${sinal?.entrega_media_pct}% do orçamento — vale acompanhar`;
    case 'parcial':
      return `${sc?.campanhas_ativas_hoje} de ${sc?.campanhas_total} campanhas ativas`;
    case 'sem_campanha':
      return 'nenhuma campanha apareceu no relatório ainda';
    case 'inativa':
      return 'conta marcada como inativa no cadastro';
    default:
      return `${sc?.campanhas_ativas_hoje ?? 0} campanha(s) ativa(s), entregando dentro do esperado`;
  }
}

const chipStatusOp = (conta) => {
  const key = conta.statusOp ?? calcularStatusOp(conta);
  const def = STATUS_OPERACIONAL[key];
  if (!def) return '<span class="cel-sub">—</span>';
  return `<span class="chip chip-${def.chip}" title="${esc(motivoStatusOp(conta, key))}">${esc(def.rotulo)}</span>`;
};

/* ---------- Investimento por período (filtro da Carteira) ---------- */

function mapaInvestimentoPeriodo(periodo) {
  const { inicio, fim } = faixaPeriodo(periodo);
  const mapa = new Map();
  for (const s of estado.serie) {
    if (s.data < inicio || s.data > fim) continue;
    mapa.set(s.account_id, (mapa.get(s.account_id) || 0) + Number(s.spend || 0));
  }
  return mapa;
}

/* =========================================================
   Visão global
   ========================================================= */

function renderGlobal() {
  // Um status por conta, calculado uma vez e carregado na própria linha —
  // evita recalcular em cada função de apoio (ordenar, filtrar, exibir).
  const contas = estado.contas.map((c) => ({ ...c, statusOp: calcularStatusOp(c) }));
  const ativas = contas.filter((c) => c.ativo);

  const investPorConta = mapaInvestimentoPeriodo(estado.periodo);
  const investTotalPeriodo = ativas.reduce((s, c) => s + (investPorConta.get(c.account_id) || 0), 0);

  // Ação necessária agora: a conta parou ou está prestes a parar.
  const urgentes = ativas.filter((c) => ['parada', 'sem_sync', 'sem_saldo'].includes(c.statusOp));
  const emObservacao = ativas.filter((c) => c.statusOp === 'saldo_apertado');
  const rodando = ativas.filter((c) => ['investindo', 'parcial'].includes(c.statusOp));
  const clientesUrgentes = new Set(urgentes.map((c) => c.cliente)).size;

  const seletorPeriodo = `
    <div class="seletor-periodo">
      <label for="sel-periodo">Investimento no período</label>
      <select id="sel-periodo">
        ${Object.entries(PERIODOS).map(([k, v]) =>
          `<option value="${k}"${k === estado.periodo ? ' selected' : ''}>${esc(v.rotulo)}</option>`).join('')}
      </select>
    </div>`;

  const kpis = `
    <div class="kpis">
      <div class="kpi${urgentes.length ? ' destaque' : ''}">
        <div class="kpi-rotulo">Contas em risco agora</div>
        <div class="kpi-valor${urgentes.length ? ' alerta' : ''}">${urgentes.length}</div>
        <div class="kpi-nota">${clientesUrgentes} cliente${clientesUrgentes === 1 ? '' : 's'} afetado${clientesUrgentes === 1 ? '' : 's'}</div>
      </div>
      <div class="kpi">
        <div class="kpi-rotulo">Investido — ${esc(PERIODOS[estado.periodo].rotulo)}</div>
        <div class="kpi-valor">${brl(investTotalPeriodo)}</div>
        <div class="kpi-nota">${ativas.length} contas ativas</div>
      </div>
      <div class="kpi">
        <div class="kpi-rotulo">Contas investindo agora</div>
        <div class="kpi-valor">${rodando.length}<span style="font-size:16px;color:var(--tinta-3)"> de ${ativas.length}</span></div>
        <div class="kpi-nota">${ativas.length - rodando.length} sem campanha rodando</div>
      </div>
      <div class="kpi${emObservacao.length ? ' destaque' : ''}">
        <div class="kpi-rotulo">Saldo apertado</div>
        <div class="kpi-valor">${emObservacao.length}</div>
        <div class="kpi-nota">tende a virar risco nos próximos dias</div>
      </div>
    </div>`;

  const listaUrgente = (lista, titulo, tag, nota) => !lista.length ? '' : `
    <div class="alerta-grupo">
      <div class="alerta-cabeca">
        <span class="alerta-tag alerta-tag-${tag}">${esc(titulo)}</span>
        <span class="bloco-nota">${esc(nota)}</span>
      </div>
      <ul class="alerta-lista">
        ${lista.map((c) => `
          <li class="clicavel" data-cliente="${esc(c.cliente_slug)}" tabindex="0">
            <strong>${esc(c.cliente)}</strong> · ${esc(c.conta)} ${plat(c.platform)}
            <br><span class="cel-sub">${esc(motivoStatusOp(c, c.statusOp))}</span>
          </li>`).join('')}
      </ul>
    </div>`;

  const alerta = (urgentes.length || emObservacao.length) ? `
    <section class="bloco">
      <div class="alerta-saldo">
        ${listaUrgente(
          ordenarPorStatusOperacional(urgentes), 'Agir agora', 'critico',
          'parada, sem sincronizar ou provável sem saldo — clique para abrir o cliente',
        )}
        ${listaUrgente(
          ordenarPorStatusOperacional(emObservacao), 'Fique de olho', 'atencao',
          'entrega abaixo do orçamento nos últimos dias',
        )}
        <p class="alerta-rodape">
          "Provável sem saldo" e "Saldo apertado" são inferidos pela entrega das campanhas, não
          confirmados pela plataforma — também podem ser anúncio reprovado, público esgotado ou
          pausa manual. "Parada" e "Sem dado recente" são fatos: vêm direto do status da campanha.
        </p>
      </div>
    </section>` : '';

  const linhas = ordenarPorStatusOperacional(contas)
    .map((c) => `
      <tr class="clicavel" data-cliente="${esc(c.cliente_slug)}" tabindex="0">
        <td>
          <div class="cel-cliente">${esc(c.cliente)}</div>
          <div class="cel-sub">${esc(c.conta)}</div>
        </td>
        <td>${plat(c.platform)}</td>
        <td>${chipStatusOp(c)}</td>
        <td class="num">${c.tem_aporte ? brl(c.saldo) : '<span class="cel-sub">—</span>'}</td>
        <td class="num">${brl(investPorConta.get(c.account_id) || 0)}</td>
        <td class="num">${barraDias(c.dias_restantes, c.statusOp)}</td>
        <td class="cel-sub">${esc(c.gestor ?? '—')}</td>
      </tr>`).join('');

  const tabela = contas.length ? `
    <div class="tabela-caixa">
      <table>
        <caption class="oculto">Contas de anúncio ordenadas por urgência</caption>
        <thead>
          <tr>
            <th scope="col">Cliente / conta</th>
            <th scope="col">Plataforma</th>
            <th scope="col">Status</th>
            <th scope="col" class="num">Saldo</th>
            <th scope="col" class="num">Investido — ${esc(PERIODOS[estado.periodo].rotulo)}</th>
            <th scope="col" class="num">Dias restantes</th>
            <th scope="col">Gestor</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>` : vazio();

  return `
    ${kpis}
    ${alerta}
    <section class="bloco">
      <div class="bloco-cabeca">
        <h2>Todas as contas</h2>
        ${seletorPeriodo}
      </div>
      ${tabela}
    </section>
    ${estado.serie.length ? blocoGrafico(estado.serie, 'Investimento diário — carteira') : ''}`;
}

/* =========================================================
   Visão por cliente
   ========================================================= */

function renderCliente() {
  const slugs = [...new Set(estado.contas.map((c) => c.cliente_slug))].sort();
  if (!slugs.length) return vazio();

  // Pior status operacional por cliente — mesmo vocabulário da Carteira.
  // Antes este seletor usava a "situação" antiga (ledger), então o mesmo
  // cliente podia aparecer "Ok" aqui e "Provável sem saldo" na Carteira.
  const piorPorCliente = new Map();
  for (const c of estado.contas) {
    if (!c.ativo) continue;
    const op = calcularStatusOp(c);
    const atual = piorPorCliente.get(c.cliente_slug);
    if (!atual || (STATUS_OPERACIONAL[op]?.peso ?? 99) < (STATUS_OPERACIONAL[atual]?.peso ?? 99)) {
      piorPorCliente.set(c.cliente_slug, op);
    }
  }

  if (!estado.clienteSel || !slugs.includes(estado.clienteSel)) {
    const [urgente] = [...piorPorCliente.entries()]
      .sort((a, b) => (STATUS_OPERACIONAL[a[1]]?.peso ?? 99) - (STATUS_OPERACIONAL[b[1]]?.peso ?? 99));
    estado.clienteSel = urgente?.[0] ?? slugs[0];
  }

  const opcoes = [...estado.clientes]
    .sort((a, b) => {
      const pa = STATUS_OPERACIONAL[piorPorCliente.get(a.cliente_slug)]?.peso ?? 99;
      const pb = STATUS_OPERACIONAL[piorPorCliente.get(b.cliente_slug)]?.peso ?? 99;
      if (pa !== pb) return pa - pb;
      return String(a.cliente).localeCompare(String(b.cliente), 'pt-BR');
    })
    .map((c) => {
      const pior = piorPorCliente.get(c.cliente_slug);
      const rotulo = pior && pior !== 'investindo' ? ` — ${STATUS_OPERACIONAL[pior].rotulo}` : '';
      return `<option value="${esc(c.cliente_slug)}"${c.cliente_slug === estado.clienteSel ? ' selected' : ''}>
        ${esc(c.cliente)}${rotulo}
      </option>`;
    }).join('');

  const contas = estado.contas.filter((c) => c.cliente_slug === estado.clienteSel);
  const resumo = estado.clientes.find((c) => c.cliente_slug === estado.clienteSel);
  const serie = estado.serie.filter((s) => contas.some((c) => c.account_id === s.account_id));

  // saldo_total vem NULL do SQL quando nenhuma conta do cliente tem aporte
  // lançado (a soma é filtrada por tem_aporte). Number(null) é 0, então sem
  // este check o card mostraria "R$ 0" em vermelho — alarme falso de conta
  // zerada onde na verdade ninguém lançou aporte ainda.
  const temAporte = contas.some((c) => c.ativo && c.tem_aporte);

  const kpis = `
    <div class="kpis">
      <div class="kpi">
        <div class="kpi-rotulo">Saldo do cliente</div>
        <div class="kpi-valor${temAporte && Number(resumo?.saldo_total) <= 0 ? ' alerta' : ''}">${
          temAporte ? brl(resumo?.saldo_total) : '—'
        }</div>
        <div class="kpi-nota">${temAporte
          ? `${resumo?.contas_ativas ?? 0} conta(s) ativa(s)`
          : 'nenhum aporte lançado ainda'}</div>
      </div>
      <div class="kpi">
        <div class="kpi-rotulo">Queima por dia</div>
        <div class="kpi-valor">${brl(resumo?.burn_diario_total)}</div>
        <div class="kpi-nota">Meta + Google somados</div>
      </div>
      ${(() => {
        // Uma conta já sem verba não tem "dias restantes" — ela tem zero.
        // Sem isto o mínimo ignora o nulo e o cartão mostraria os dias da
        // conta saudável, escondendo justamente a que precisa de aporte.
        const zeradas = contas.filter((c) => c.ativo && c.situacao === 'sem_verba').length;
        const d = zeradas ? 0 : resumo?.dias_restantes_menor;
        const nota = zeradas
          ? `${zeradas} conta${zeradas > 1 ? 's' : ''} já sem verba`
          : 'conta que acaba primeiro';
        return `
      <div class="kpi">
        <div class="kpi-rotulo">Dias restantes</div>
        <div class="kpi-valor${(d ?? 99) < 7 ? ' alerta' : ''}">${d ?? '—'}</div>
        <div class="kpi-nota">${nota}</div>
      </div>`;
      })()}
      <div class="kpi">
        <div class="kpi-rotulo">Gasto no mês</div>
        <div class="kpi-valor">${brl(resumo?.gasto_mes_total)}</div>
        <div class="kpi-nota">${esc(resumo?.gestor ?? 'sem gestor definido')}</div>
      </div>
    </div>`;

  const cartoes = contas.map((c) => ({ ...c, statusOp: calcularStatusOp(c) }))
    .sort((a, b) => (STATUS_OPERACIONAL[a.statusOp]?.peso ?? 99) - (STATUS_OPERACIONAL[b.statusOp]?.peso ?? 99))
    .map((c) => {
      const aporte = estado.ultimoAporte[c.account_id];
      return `
    <article class="conta${['parada', 'sem_sync', 'sem_saldo'].includes(c.statusOp) ? ' urgente' : ''}">
      <div class="conta-topo">
        <div>
          <div class="conta-nome">${esc(c.conta)}</div>
          <div style="margin-top:4px">${plat(c.platform)}</div>
        </div>
        ${chipStatusOp(c)}
      </div>
      <div class="conta-saldo${c.tem_aporte && Number(c.saldo) <= 0 ? ' zerado' : ''}">${
        c.tem_aporte ? brl(c.saldo, { centavos: true }) : '—'
      }</div>
      <div class="cel-sub" style="margin-bottom:10px">
        ${!c.tem_aporte ? 'nenhum aporte lançado ainda'
          : c.balance_source === 'api' ? 'saldo lido da plataforma'
          : 'saldo = aportes − gasto'}
      </div>
      <dl>
        <div class="conta-linha"><dt>Dias restantes</dt><dd>${dias(c.dias_restantes)}</dd></div>
        <div class="conta-linha"><dt>Queima/dia</dt><dd>${brl(c.burn_projecao)}</dd></div>
        <div class="conta-linha"><dt>Orçamento configurado</dt><dd>${brl(c.burn_configurado)}</dd></div>
        <div class="conta-linha"><dt>Média real 7d</dt><dd>${brl(c.burn_real_7d)}</dd></div>
        <div class="conta-linha"><dt>Campanhas ativas</dt><dd>${c.campanhas_ativas ?? 0}</dd></div>
        <div class="conta-linha"><dt>Gasto no mês</dt><dd>${brl(c.gasto_mes_atual)}</dd></div>
        ${c.pct_verba_mensal != null
          ? `<div class="conta-linha"><dt>Da verba mensal</dt><dd>${c.pct_verba_mensal}%</dd></div>` : ''}
        <div class="conta-linha"><dt>Total aportado</dt><dd>${brl(c.total_aportado)}</dd></div>
        <div class="conta-linha">
          <dt>Última recarga</dt>
          <dd>${aporte ? `${brl(aporte.ultimo_valor)} em ${dataCurta(aporte.ultima_data)}` : 'nenhuma ainda'}</dd>
        </div>
      </dl>
    </article>`;
    }).join('');

  return `
    <div class="seletor">
      <label for="sel-cliente" class="bloco-nota">Cliente</label>
      <select id="sel-cliente">${opcoes}</select>
      <button class="botao" id="ver-investimento">
        Ver investimento completo
        <span aria-hidden="true">→</span>
      </button>
    </div>
    ${kpis}
    <section class="bloco">
      <div class="bloco-cabeca"><h2>Contas</h2></div>
      <div class="contas">${cartoes}</div>
    </section>
    ${serie.length ? blocoGrafico(serie, 'Investimento diário') : ''}`;
}

/* =========================================================
   Investimentos — visão completa vinda da plataforma de anúncio
   As abas Carteira e Por cliente vivem de saldo e ledger.
   Esta vive do detalhe por campanha que o Windsor traz.
   ========================================================= */

function renderInvestimentos() {
  if (!estado.campanhas.length) {
    return `<div class="vazio">
      <b>Sem detalhe de campanha ainda</b>
      Esta aba mostra o investimento campanha a campanha, direto da plataforma.
      Ela se preenche quando o sync do Windsor rodar.
    </div>`;
  }

  const todos = estado.campanhas;
  const sel = estado.investCliente;
  const linhas = sel ? todos.filter((c) => c.cliente_slug === sel) : todos;

  const clientesUnicos = [...new Map(todos.map((c) => [c.cliente_slug, c.cliente])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'));

  const soma = (f) => linhas.reduce((s, c) => s + Number(c[f] || 0), 0);
  const ativas = linhas.filter((c) => ['ACTIVE', 'ENABLED'].includes(String(c.status).toUpperCase()));
  const orcDia = ativas.reduce((s, c) => s + Number(c.orcamento || 0), 0);
  const gasto7 = soma('gasto_7d');
  const gasto30 = soma('gasto_30d');

  // Quanto do orçamento configurado está realmente sendo entregue.
  // Abaixo de 100% a campanha não gasta o que foi planejado — pode ser
  // falta de saldo, de audiência ou de aprovação.
  const entrega = orcDia > 0 ? (gasto7 / 7) / orcDia * 100 : null;

  const filtro = `
    <div class="seletor">
      <label for="sel-invest" class="bloco-nota">Cliente</label>
      <select id="sel-invest">
        <option value=""${!sel ? ' selected' : ''}>Todos os clientes</option>
        ${clientesUnicos.map(([slug, nome]) =>
          `<option value="${esc(slug)}"${slug === sel ? ' selected' : ''}>${esc(nome)}</option>`).join('')}
      </select>
      ${sel ? `<button class="botao-secundario" id="limpar-invest">Ver todos</button>` : ''}
    </div>`;

  const kpis = `
    <div class="kpis">
      <div class="kpi">
        <div class="kpi-rotulo">Investido em 30 dias</div>
        <div class="kpi-valor">${brl(gasto30)}</div>
        <div class="kpi-nota">${linhas.length} campanha${linhas.length === 1 ? '' : 's'}</div>
      </div>
      <div class="kpi">
        <div class="kpi-rotulo">Últimos 7 dias</div>
        <div class="kpi-valor">${brl(gasto7)}</div>
        <div class="kpi-nota">${brl(gasto7 / 7)} por dia</div>
      </div>
      <div class="kpi">
        <div class="kpi-rotulo">Orçamento/dia configurado</div>
        <div class="kpi-valor">${brl(orcDia)}</div>
        <div class="kpi-nota">${ativas.length} campanha(s) ativa(s)</div>
      </div>
      <div class="kpi">
        <div class="kpi-rotulo">Entrega do orçamento</div>
        <div class="kpi-valor${entrega != null && entrega < 70 ? ' alerta' : ''}">${entrega != null ? `${entrega.toFixed(0)}%` : '—'}</div>
        <div class="kpi-nota">gasto real sobre o planejado</div>
      </div>
    </div>`;

  const corpo = [...linhas]
    .sort((a, b) => Number(b.gasto_30d || 0) - Number(a.gasto_30d || 0))
    .map((c) => {
      const ativa = ['ACTIVE', 'ENABLED'].includes(String(c.status).toUpperCase());
      const media = Number(c.media_dia_7d || 0);
      const orc = Number(c.orcamento || 0);
      const pct = orc > 0 ? media / orc * 100 : null;
      return `
      <tr>
        <td>
          <div class="cel-cliente">${esc(c.campanha)}</div>
          <div class="cel-sub">${esc(c.cliente)} · ${esc(c.conta)}</div>
        </td>
        <td>${plat(c.platform)}</td>
        <td><span class="chip chip-${ativa ? 'ok' : 'inativo'}">${ativa ? 'Ativa' : 'Pausada'}</span></td>
        <td class="num">${orc > 0 ? brl(orc) : '<span class="cel-sub">no ad set</span>'}</td>
        <td class="num">${brl(media)}</td>
        <td class="num">${pct != null ? `${pct.toFixed(0)}%` : '—'}</td>
        <td class="num">${brl(c.gasto_7d)}</td>
        <td class="num">${brl(c.gasto_30d)}</td>
      </tr>`;
    }).join('');

  return `
    ${filtro}
    ${kpis}
    <section class="bloco">
      <div class="bloco-cabeca">
        <h2>Campanhas${sel ? ` — ${esc(clientesUnicos.find(([s]) => s === sel)?.[1] ?? '')}` : ''}</h2>
        <span class="bloco-nota">direto da plataforma de anúncio · ordenadas por investimento</span>
      </div>
      <div class="tabela-caixa">
        <table>
          <thead>
            <tr>
              <th scope="col">Campanha</th>
              <th scope="col">Plataforma</th>
              <th scope="col">Status</th>
              <th scope="col" class="num">Orçamento/dia</th>
              <th scope="col" class="num">Média/dia 7d</th>
              <th scope="col" class="num">Entrega</th>
              <th scope="col" class="num">Gasto 7d</th>
              <th scope="col" class="num">Gasto 30d</th>
            </tr>
          </thead>
          <tbody>${corpo}</tbody>
        </table>
      </div>
    </section>`;
}


/* =========================================================
   Histórico — evolução do investimento mês a mês
   O banco guarda o dado bruto para sempre; esta aba é a leitura
   acumulada dele. Métricas derivadas (CPM, CPC, CTR, CPA, ROAS) vêm
   calculadas do SQL sobre as somas — nunca são média de médias.
   ========================================================= */

const mesRotulo = (iso) => {
  const [a, m] = String(iso).slice(0, 7).split('-');
  const nomes = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
  return `${nomes[Number(m) - 1]}/${a.slice(2)}`;
};

const numero = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || v === null) return '—';
  return n.toLocaleString('pt-BR');
};

function renderHistorico() {
  const meses = estado.historicoCarteira;
  if (!meses.length) {
    return `<div class="vazio">
      <b>Histórico ainda vazio</b>
      Ele se preenche a cada sincronização — o banco nunca apaga o que já entrou.
    </div>`;
  }

  const total = meses.reduce((s, m) => s + Number(m.investimento || 0), 0);
  const atual = meses[meses.length - 1];
  const anterior = meses.length > 1 ? meses[meses.length - 2] : null;
  const varPct = anterior && Number(anterior.investimento) > 0
    ? ((Number(atual.investimento) / Number(anterior.investimento)) - 1) * 100
    : null;

  // O SQL marca como parcial tanto o mês corrente quanto o primeiro da
  // série, que começou no meio do mês. Comparar um parcial com um fechado
  // exagera a queda, então o rótulo precisa avisar.
  const mesCorrente = atual.parcial === true;

  const kpis = `
    <div class="kpis">
      <div class="kpi">
        <div class="kpi-rotulo">Investimento acumulado</div>
        <div class="kpi-valor">${brl(total)}</div>
        <div class="kpi-nota">${meses.length} ${meses.length === 1 ? 'mês' : 'meses'} de histórico</div>
      </div>
      <div class="kpi">
        <div class="kpi-rotulo">${mesRotulo(atual.mes)}</div>
        <div class="kpi-valor">${brl(atual.investimento)}</div>
        <div class="kpi-nota">${mesCorrente ? 'mês incompleto' : 'mês fechado'}</div>
      </div>
      <div class="kpi">
        <div class="kpi-rotulo">Contra o mês anterior</div>
        <div class="kpi-valor">${varPct === null ? '—' : `${varPct > 0 ? '+' : ''}${varPct.toFixed(0)}%`}</div>
        <div class="kpi-nota">${mesCorrente ? 'mês parcial, tende a subir' : 'meses fechados'}</div>
      </div>
      <div class="kpi">
        <div class="kpi-rotulo">Clientes no mês</div>
        <div class="kpi-valor">${atual.clientes ?? '—'}</div>
        <div class="kpi-nota">${atual.contas ?? 0} contas com veiculação</div>
      </div>
    </div>`;

  // ---- Barras: investimento por mês ----
  const W = 1000, H = 220, mL = 70, mR = 16, mT = 14, mB = 30;
  const iw = W - mL - mR, ih = H - mT - mB;
  const maxV = Math.max(...meses.map((m) => Number(m.investimento))) || 1;
  const teto = maxV * 1.15;
  const passo = iw / meses.length;
  const larg = Math.min(72, passo * 0.6);

  const grade = [0, .5, 1].map((f) => {
    const y = mT + ih - f * ih;
    return `<line class="gr-grid" x1="${mL}" y1="${y}" x2="${W - mR}" y2="${y}"/>
            <text class="gr-eixo" x="${mL - 8}" y="${y + 4}" text-anchor="end">${brl(teto * f)}</text>`;
  }).join('');

  const barras = meses.map((m, i) => {
    const v = Number(m.investimento);
    const h = (v / teto) * ih;
    const x = mL + passo * i + (passo - larg) / 2;
    const y = mT + ih - h;
    const parcial = m.parcial === true;
    return `
      <rect x="${x}" y="${y}" width="${larg}" height="${Math.max(h, 2)}" rx="4"
            fill="${parcial ? 'var(--linha-forte)' : 'var(--marca)'}">
        <title>${mesRotulo(m.mes)}: ${brl(v)}${parcial ? ' (mês incompleto)' : ''}</title>
      </rect>
      <text class="gr-eixo" x="${x + larg / 2}" y="${y - 6}" text-anchor="middle"
            style="font-weight:600">${brl(v)}</text>
      <text class="gr-eixo" x="${x + larg / 2}" y="${H - 10}" text-anchor="middle">${mesRotulo(m.mes)}</text>`;
  }).join('');

  const grafico = `
    <section class="bloco">
      <div class="bloco-cabeca">
        <h2>Investimento da carteira por mês</h2>
        <span class="bloco-nota">barra cinza = mês incompleto, não comparável</span>
      </div>
      <div class="gr-caixa">
        <svg class="grafico" viewBox="0 0 ${W} ${H}" role="img"
             aria-label="Investimento mensal da carteira">${grade}${barras}</svg>
      </div>
    </section>`;

  // ---- Pivô cliente × mês ----
  const chaves = meses.map((m) => String(m.mes).slice(0, 10));
  const porCliente = new Map();
  for (const l of estado.historico) {
    if (!porCliente.has(l.cliente)) porCliente.set(l.cliente, { cliente: l.cliente, meses: {}, total: 0 });
    const alvo = porCliente.get(l.cliente);
    const k = String(l.mes).slice(0, 10);
    alvo.meses[k] = (alvo.meses[k] || 0) + Number(l.investimento || 0);
    alvo.total += Number(l.investimento || 0);
  }

  const linhasPivot = [...porCliente.values()]
    .sort((a, b) => b.total - a.total)
    .map((c) => `
      <tr>
        <td class="cel-cliente">${esc(c.cliente)}</td>
        ${chaves.map((k) => `<td class="num">${c.meses[k] ? brl(c.meses[k]) : '<span class="cel-sub">—</span>'}</td>`).join('')}
        <td class="num" style="font-weight:650">${brl(c.total)}</td>
      </tr>`).join('');

  const pivot = `
    <section class="bloco">
      <div class="bloco-cabeca">
        <h2>Investimento por cliente</h2>
        <span class="bloco-nota">Meta e Google somados · ordenado pelo acumulado</span>
      </div>
      <div class="tabela-caixa">
        <table>
          <thead>
            <tr>
              <th scope="col">Cliente</th>
              ${chaves.map((k) => `<th scope="col" class="num">${mesRotulo(k)}</th>`).join('')}
              <th scope="col" class="num">Acumulado</th>
            </tr>
          </thead>
          <tbody>${linhasPivot}</tbody>
        </table>
      </div>
    </section>`;

  // ---- Performance do mês mais recente ----
  const doMes = estado.historico.filter((l) => String(l.mes).slice(0, 10) === chaves[chaves.length - 1]);
  const perf = doMes.length ? `
    <section class="bloco">
      <div class="bloco-cabeca">
        <h2>Performance em ${mesRotulo(chaves[chaves.length - 1])}</h2>
        <span class="bloco-nota">o conector do Meta não expõe conversões — por isso aparecem só no Google</span>
      </div>
      <div class="tabela-caixa">
        <table>
          <thead>
            <tr>
              <th scope="col">Cliente</th>
              <th scope="col">Plataforma</th>
              <th scope="col" class="num">Investimento</th>
              <th scope="col" class="num">Impressões</th>
              <th scope="col" class="num">Cliques</th>
              <th scope="col" class="num">CTR</th>
              <th scope="col" class="num">CPC</th>
              <th scope="col" class="num">CPM</th>
              <th scope="col" class="num">Conversões</th>
              <th scope="col" class="num">CPA</th>
            </tr>
          </thead>
          <tbody>
            ${doMes.sort((a, b) => Number(b.investimento) - Number(a.investimento)).map((l) => `
              <tr>
                <td class="cel-cliente">${esc(l.cliente)}</td>
                <td>${plat(l.platform)}</td>
                <td class="num">${brl(l.investimento)}</td>
                <td class="num">${numero(l.impressoes)}</td>
                <td class="num">${numero(l.cliques)}</td>
                <td class="num">${Number.isFinite(Number(l.ctr)) ? `${l.ctr}%` : '—'}</td>
                <td class="num">${Number.isFinite(Number(l.cpc)) ? brl(l.cpc, { centavos: true }) : '—'}</td>
                <td class="num">${Number.isFinite(Number(l.cpm)) ? brl(l.cpm, { centavos: true }) : '—'}</td>
                <td class="num">${l.conversoes ? numero(Math.round(l.conversoes)) : '<span class="cel-sub">—</span>'}</td>
                <td class="num">${Number.isFinite(Number(l.cpa)) ? brl(l.cpa) : '<span class="cel-sub">—</span>'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </section>` : '';

  return `${kpis}${grafico}${pivot}${perf}`;
}

/* =========================================================
   Gráfico de linha — gasto diário por plataforma
   ========================================================= */

function blocoGrafico(serie, titulo) {
  const porData = new Map();
  for (const r of serie) {
    const d = String(r.data).slice(0, 10);
    if (!porData.has(d)) porData.set(d, { data: d, meta: 0, google: 0 });
    porData.get(d)[r.platform] += Number(r.spend || 0);
  }
  const pontos = [...porData.values()].sort((a, b) => a.data.localeCompare(b.data)).slice(-90);
  if (pontos.length < 2) return '';

  const usadas = ['meta', 'google'].filter((p) => pontos.some((d) => d[p] > 0));
  // Conta com histórico só de zeros (ex.: parada o período inteiro) não tem
  // o que plotar. Sem este corte, Math.max(...[]) vira -Infinity e o eixo
  // do gráfico mostra "—" em vez de valores — pior que não mostrar nada.
  if (!usadas.length) {
    return `
      <section class="bloco">
        <div class="bloco-cabeca"><h2>${esc(titulo)}</h2></div>
        <div class="vazio">Nenhum investimento registrado nesse período.</div>
      </section>`;
  }

  const W = 1000, H = 260, mL = 58, mR = 16, mT = 12, mB = 28;
  const iw = W - mL - mR, ih = H - mT - mB;
  const max = Math.max(...pontos.flatMap((d) => usadas.map((p) => d[p]))) || 1;
  const teto = max * 1.12;

  const x = (i) => mL + (pontos.length === 1 ? iw / 2 : (i / (pontos.length - 1)) * iw);
  const y = (v) => mT + ih - (v / teto) * ih;

  const grade = [0, .25, .5, .75, 1].map((f) => {
    const yy = mT + ih - f * ih;
    return `<line class="gr-grid" x1="${mL}" y1="${yy}" x2="${W - mR}" y2="${yy}"/>
            <text class="gr-eixo" x="${mL - 8}" y="${yy + 4}" text-anchor="end">${brl(teto * f)}</text>`;
  }).join('');

  const passo = Math.max(1, Math.ceil(pontos.length / 8));
  const rotulos = pontos.map((d, i) => (i % passo === 0 || i === pontos.length - 1)
    ? `<text class="gr-eixo" x="${x(i)}" y="${H - 8}" text-anchor="middle">${dataCurta(d.data)}</text>` : '').join('');

  const linhas = usadas.map((p) => {
    const d = pontos.map((pt, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(pt[p]).toFixed(1)}`).join(' ');
    return `<path class="gr-linha" d="${d}" stroke="${PLATAFORMAS[p].cor}"/>`;
  }).join('');

  const legenda = usadas.map((p) =>
    `<span><i style="background:${PLATAFORMAS[p].cor}"></i>${PLATAFORMAS[p].rotulo}</span>`).join('');

  const dados = encodeURIComponent(JSON.stringify({ pontos, usadas, geo: { W, H, mL, mR, mT, mB, teto } }));

  return `
    <section class="bloco">
      <div class="bloco-cabeca">
        <h2>${esc(titulo)}</h2>
        <span class="bloco-nota">últimos ${pontos.length} dias</span>
      </div>
      <div class="gr-caixa">
        <div class="gr-legenda">${legenda}</div>
        <svg class="grafico" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
             role="img" aria-label="${esc(titulo)}, série diária" data-grafico="${dados}">
          ${grade}${rotulos}${linhas}
          <g class="gr-hover"></g>
          <rect x="${mL}" y="${mT}" width="${iw}" height="${ih}" fill="transparent" class="gr-captura"/>
        </svg>
      </div>
    </section>`;
}

function ligarGrafico(svg) {
  const { pontos, usadas, geo } = JSON.parse(decodeURIComponent(svg.dataset.grafico));
  const { W, mL, mR, mT, mB, teto, H } = geo;
  const iw = W - mL - mR, ih = H - mT - mB;
  const grupo = svg.querySelector('.gr-hover');
  const tip = document.getElementById('tooltip');

  const x = (i) => mL + (i / (pontos.length - 1)) * iw;
  const y = (v) => mT + ih - (v / teto) * ih;

  const mover = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(pontos.length - 1,
      Math.round(((px - mL) / iw) * (pontos.length - 1))));
    const p = pontos[i];

    grupo.innerHTML = `
      <line class="gr-cursor" x1="${x(i)}" y1="${mT}" x2="${x(i)}" y2="${mT + ih}"/>
      ${usadas.map((s) => `<circle class="gr-ponto" cx="${x(i)}" cy="${y(p[s])}" r="4.5" fill="${PLATAFORMAS[s].cor}"/>`).join('')}`;

    tip.innerHTML = `<b>${dataCurta(p.data)}</b>` + usadas.map((s) =>
      `<div class="tt-serie"><i style="background:${PLATAFORMAS[s].cor}"></i>${PLATAFORMAS[s].rotulo}: <b>${brl(p[s], { centavos: true })}</b></div>`).join('');
    tip.classList.add('on');
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(ev.clientX + 14, window.innerWidth - tw - 10)}px`;
    tip.style.top = `${ev.clientY - tip.offsetHeight - 12}px`;
  };

  const sair = () => { grupo.innerHTML = ''; tip.classList.remove('on'); };

  svg.addEventListener('pointermove', mover);
  svg.addEventListener('pointerleave', sair);
}

/* =========================================================
   Estados vazios
   ========================================================= */

function vazio() {
  return `
    <div class="vazio">
      <b>Nenhuma conta cadastrada ainda</b>
      Cadastre os clientes e as contas em <code>inv_clients</code> e <code>inv_ad_accounts</code>,
      e rode o sync do Windsor.<br><br>
      Para ver o dashboard funcionando com dados fictícios,
      abra <code>?demo=1</code> na URL.
    </div>`;
}

function erro(msg) {
  return `<div class="vazio erro"><b>Não consegui carregar os dados</b>${esc(msg)}</div>`;
}

/* =========================================================
   Montagem
   ========================================================= */

function render() {
  const alvo = document.getElementById('conteudo');
  alvo.innerHTML = estado.aba === 'global' ? renderGlobal()
    : estado.aba === 'cliente' ? renderCliente()
    : estado.aba === 'historico' ? renderHistorico()
    : renderInvestimentos();

  document.getElementById('sync-info').textContent = MODO_DEMO
    ? 'dados fictícios'
    : estado.ultimoSync ? `atualizado ${dataHora(estado.ultimoSync)}` : 'nunca sincronizado';

  alvo.querySelectorAll('svg[data-grafico]').forEach(ligarGrafico);

  const sel = document.getElementById('sel-cliente');
  if (sel) sel.addEventListener('change', (e) => { estado.clienteSel = e.target.value; render(); });

  const selPeriodo = document.getElementById('sel-periodo');
  if (selPeriodo) selPeriodo.addEventListener('change', (e) => { estado.periodo = e.target.value; render(); });

  const selInv = document.getElementById('sel-invest');
  if (selInv) selInv.addEventListener('change', (e) => {
    estado.investCliente = e.target.value || null;
    render();
  });

  const limpar = document.getElementById('limpar-invest');
  if (limpar) limpar.addEventListener('click', () => { estado.investCliente = null; render(); });

  // Botão do cliente que leva ao detalhe completo já filtrado nele.
  const verInvest = document.getElementById('ver-investimento');
  if (verInvest) verInvest.addEventListener('click', () => {
    estado.investCliente = estado.clienteSel;
    trocarAba('investimentos');
  });

  alvo.querySelectorAll('.clicavel[data-cliente]').forEach((el) => {
    const abrir = () => {
      estado.clienteSel = el.dataset.cliente;
      trocarAba('cliente');
    };
    el.addEventListener('click', abrir);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') abrir(); });
  });
}

function trocarAba(aba) {
  estado.aba = aba;
  document.querySelectorAll('.aba').forEach((b) =>
    b.setAttribute('aria-selected', String(b.dataset.aba === aba)));
  render();
}

async function iniciar() {
  document.querySelectorAll('.aba').forEach((b) =>
    b.addEventListener('click', () => trocarAba(b.dataset.aba)));

  if (MODO_DEMO) document.getElementById('faixa-demo').classList.remove('oculto');

  try {
    await carregar();
    render();
  } catch (e) {
    document.getElementById('conteudo').innerHTML = erro(e.message);
    console.error(e);
  }
}

/* =========================================================
   Modo demo — dados fictícios para avaliar a interface
   antes de o Windsor estar ligado.
   ========================================================= */

function gerarDemo() {
  const base = [
    ['Rede Sumirê', 'rede-sumire', 'Ivan', [['meta', 'Sumirê Sorocaba', 12400, 780], ['google', 'Sumirê Search', 6200, 410]]],
    ['Ophicina Footwear', 'ophicina-footwear', 'Ivan', [['meta', 'Ophicina Tatuapé', 1850, 640], ['meta', 'Ophicina Campinas', 320, 520]]],
    ['CVC Osasco', 'cvc-osasco', 'Ana', [['meta', 'CVC Osasco Plaza', 0, 300], ['google', 'CVC Osasco Search', 4100, 260]]],
    ['Gráfica Duo Paper', 'duo-paper', 'Ana', [['meta', 'Duo Paper', 9800, 350], ['google', 'Duo Paper Perf. Max', 7300, 290]]],
    ['Grupo Luchini', 'grupo-luchini', 'Rafa', [['meta', 'Luchini Consórcio', 23500, 1150]]],
    ['Loja Japonesa', 'loja-japonesa', 'Rafa', [['meta', 'Loja Japonesa SP', 640, 480], ['google', 'Loja Japonesa Shop', 1200, 220]]],
    ['Mistura Forte', 'mistura-forte', 'Ivan', [['google', 'Mistura Forte Search', 15200, 340]]],
    ['Tricotá', 'tricota', 'Ana', [['meta', 'Tricotá', 5400, 0]]],
  ];

  const contas = [], clientes = [], serie = [];
  let n = 0;

  for (const [nome, slug, gestor, cs] of base) {
    const doCliente = [];
    for (const [pl, cNome, saldo, burnCfg] of cs) {
      const id = `demo-${++n}`;
      const burnReal = Math.round(burnCfg * (0.72 + Math.random() * 0.3));
      const burn = burnProjecao(burnCfg, burnReal);
      const d = diasRestantes(saldo, burn);
      const sit = situacaoDe({ saldo, burn });
      const gastoMes = Math.round(burnReal * (new Date().getDate()));

      const conta = {
        account_id: id, client_id: slug, cliente: nome, cliente_slug: slug, gestor,
        platform: pl, conta: cNome, currency: 'BRL', billing_model: 'prepago',
        balance_source: 'ledger', ativo: true, tem_aporte: true,
        campanhas_ativas: burnCfg > 0 ? 2 + (n % 3) : 0,
        burn_configurado: burnCfg, burn_real_7d: burnReal, burn_projecao: burn,
        total_aportado: saldo + gastoMes * 2, total_gasto_ledger: gastoMes * 2,
        gasto_mes_atual: gastoMes, saldo, dias_restantes: d, situacao: sit,
        verba_mensal: null, pct_verba_mensal: null,
      };
      contas.push(conta);
      doCliente.push(conta);

      for (let k = 89; k >= 0; k--) {
        const dt = new Date(); dt.setDate(dt.getDate() - k);
        const fds = [0, 6].includes(dt.getDay()) ? 0.6 : 1;
        serie.push({
          account_id: id, client_id: slug, platform: pl,
          data: dt.toISOString().slice(0, 10),
          spend: Math.round(burnReal * fds * (0.7 + Math.random() * 0.6)),
        });
      }
    }

    const ativos = doCliente;
    clientes.push({
      client_id: slug, cliente: nome, cliente_slug: slug, gestor,
      contas_ativas: ativos.length,
      saldo_total: ativos.reduce((s, c) => s + c.saldo, 0),
      burn_diario_total: ativos.reduce((s, c) => s + c.burn_projecao, 0),
      gasto_mes_total: ativos.reduce((s, c) => s + c.gasto_mes_atual, 0),
      dias_restantes_menor: (() => {
        const ds = ativos.map((c) => c.dias_restantes).filter((d) => d != null);
        return ds.length ? Math.min(...ds) : null;
      })(),
      situacao_pior: ativos.map((c) => c.situacao)
        .sort((a, b) => SITUACOES[a].peso - SITUACOES[b].peso)[0],
    });
  }

  // Detalhe por campanha, para a aba Investimentos.
  const campanhas = [];
  for (const c of contas) {
    const qtd = c.campanhas_ativas || 1;
    for (let i = 1; i <= qtd; i++) {
      const orc = Math.round((c.burn_configurado / qtd) * 100) / 100;
      const media = Math.round(orc * (0.55 + Math.random() * 0.55) * 100) / 100;
      campanhas.push({
        account_id: c.account_id, client_id: c.client_id,
        cliente: c.cliente, cliente_slug: c.cliente_slug,
        platform: c.platform, conta: c.conta,
        campanha: `${c.platform === 'meta' ? '[Trafego]' : '[Search]'} ${c.conta} — v${i}`,
        status: c.burn_configurado > 0 ? 'ACTIVE' : 'PAUSED',
        orcamento: orc || null,
        gasto_7d: Math.round(media * 7 * 100) / 100,
        gasto_30d: Math.round(media * 30 * 100) / 100,
        media_dia_7d: media,
        ultimo_dia_com_gasto: new Date().toISOString().slice(0, 10),
      });
    }
  }

  // Sinais de entrega: as contas com pouco saldo entregam mal, que é
  // exatamente a correlação que o sinal existe para capturar.
  const sinais = {};
  for (const c of contas) {
    const d = c.dias_restantes;
    const sinal = c.burn_configurado === 0 ? 'entregando'
      : d === null || d <= 1 ? 'provavel_sem_saldo'
      : d <= 5 ? 'saldo_apertado'
      : d <= 15 ? 'oscilando' : 'entregando';
    sinais[c.account_id] = {
      account_id: c.account_id, sinal,
      orcamento_dia: c.burn_configurado,
      dias_travados: sinal === 'provavel_sem_saldo' ? 5 : sinal === 'saldo_apertado' ? 3 : 1,
      entrega_media_pct: sinal === 'provavel_sem_saldo' ? 11
        : sinal === 'saldo_apertado' ? 48 : 96,
    };
  }

  // Histórico fictício: 4 meses, o primeiro e o último parciais.
  const historico = [], historicoCarteira = [];
  for (let k = 3; k >= 0; k--) {
    const d = new Date(); d.setMonth(d.getMonth() - k, 1);
    const mes = d.toISOString().slice(0, 10);
    const fator = k === 0 ? 0.45 : k === 3 ? 0.4 : 0.9 + Math.random() * 0.25;
    let invMes = 0, impMes = 0, cliMes = 0, cvMes = 0;
    for (const c of contas) {
      const inv = Math.round(c.burn_projecao * 30 * fator);
      const imp = Math.round(inv * 47), cli = Math.round(imp * 0.027);
      const cv = c.platform === 'google' ? Math.round(cli * 0.035) : null;
      invMes += inv; impMes += imp; cliMes += cli; cvMes += cv || 0;
      historico.push({
        client_id: c.client_id, cliente: c.cliente, cliente_slug: c.cliente_slug,
        platform: c.platform, mes, investimento: inv, impressoes: imp, cliques: cli,
        conversoes: cv, valor_conversao: cv ? cv * 320 : null,
        cpm: imp > 0 ? Math.round((inv / imp) * 1000 * 100) / 100 : null,
        cpc: cli > 0 ? Math.round((inv / cli) * 100) / 100 : null,
        ctr: imp > 0 ? Math.round((cli / imp) * 10000) / 100 : null,
        cpa: cv ? Math.round((inv / cv) * 100) / 100 : null,
        roas: cv ? 3.2 : null,
      });
    }
    historicoCarteira.push({
      mes, investimento: invMes, impressoes: impMes, cliques: cliMes,
      conversoes: cvMes, clientes: 8, contas: contas.length,
      parcial: k === 0 || k === 3,
    });
  }

  // Status operacional: agrupa o detalhe de campanha já gerado acima. A
  // conta "Tricotá" tem orçamento configurado zero, então nasce com 1
  // campanha pausada e vira o exemplo de "parada" no demo.
  const statusCampanhas = {};
  for (const c of contas) {
    const doAcc = campanhas.filter((cp) => cp.account_id === c.account_id);
    statusCampanhas[c.account_id] = {
      account_id: c.account_id,
      ultimo_dado: new Date().toISOString().slice(0, 10),
      dias_sem_dado_novo: 0,
      campanhas_total: doAcc.length,
      campanhas_ativas_hoje: doAcc.filter((cp) => cp.status === 'ACTIVE').length,
    };
  }

  // Último aporte: fictício, plausível a partir do total já aportado.
  const ultimoAporte = {};
  for (const c of contas) {
    const diasAtras = 1 + Math.floor(Math.random() * 18);
    const dt = new Date(); dt.setDate(dt.getDate() - diasAtras);
    ultimoAporte[c.account_id] = {
      account_id: c.account_id,
      ultima_data: dt.toISOString().slice(0, 10),
      ultimo_valor: Math.round(c.total_aportado * 0.4),
      qtd_aportes: 2,
    };
  }

  return { contas, clientes, serie, campanhas, sinais, statusCampanhas, ultimoAporte,
           historico, historicoCarteira, ultimoSync: new Date().toISOString() };
}

iniciar();
