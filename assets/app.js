/* =========================================================
   Dashboard de verba — camada de dados e renderização.
   Sem framework e sem build: lê a REST do Supabase direto.
   ========================================================= */

import {
  SITUACOES, PLATAFORMAS, brl, dias, dataCurta, dataHora,
  larguraDias, ordenarPorUrgencia, situacaoDe, burnProjecao, diasRestantes,
} from './calc.js';

import { CONFIG } from './config.js';

const params = new URLSearchParams(location.search);
const MODO_DEMO = params.get('demo') === '1';

const estado = {
  contas: [],
  clientes: [],
  serie: [],
  aba: 'global',
  clienteSel: null,
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
  const [contas, clientes, serie, sync] = await Promise.all([
    buscar('inv_account_status'),
    buscar('inv_client_overview'),
    buscar('inv_spend_series', '&order=data.asc'),
    buscar('inv_sync_status').catch(() => []),
  ]);
  estado.contas = contas;
  estado.clientes = clientes;
  estado.serie = serie;
  estado.ultimoSync = sync?.[0]?.ultimo_sync_ok ?? null;
}

/* =========================================================
   Helpers de marcação
   ========================================================= */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const chip = (sit) =>
  `<span class="chip chip-${esc(sit)}">${esc(SITUACOES[sit]?.rotulo ?? sit)}</span>`;

const corSituacao = (sit) => ({
  ok: 'var(--ok)', atencao: 'var(--atencao)', critico: 'var(--critico)',
  sem_verba: 'var(--marca)',
}[sit] ?? 'var(--linha-forte)');

const barraDias = (d, sit) => `
  <div class="dias">
    <span class="dias-num">${d ?? '—'}</span>
    <span class="dias-barra" role="img" aria-label="${esc(dias(d))} restantes">
      <span class="dias-fill" style="width:${larguraDias(d)}%;background:${corSituacao(sit)}"></span>
    </span>
  </div>`;

const plat = (p) =>
  `<span class="plat plat-${esc(p)}">${esc(PLATAFORMAS[p]?.rotulo ?? p)}</span>`;

/* =========================================================
   Visão global
   ========================================================= */

function renderGlobal() {
  const ativas = estado.contas.filter((c) => c.ativo);

  const semVerba = ativas.filter((c) => c.situacao === 'sem_verba');
  const criticas = ativas.filter((c) => ['critico', 'sem_verba'].includes(c.situacao));
  const saldoTotal = ativas.reduce((s, c) => s + Number(c.saldo || 0), 0);
  const burnTotal = ativas.reduce((s, c) => s + Number(c.burn_projecao || 0), 0);
  const clientesSemVerba = new Set(semVerba.map((c) => c.cliente)).size;

  const kpis = `
    <div class="kpis">
      <div class="kpi${semVerba.length ? ' destaque' : ''}">
        <div class="kpi-rotulo">Contas sem verba</div>
        <div class="kpi-valor${semVerba.length ? ' alerta' : ''}">${semVerba.length}</div>
        <div class="kpi-nota">${clientesSemVerba} cliente${clientesSemVerba === 1 ? '' : 's'} afetado${clientesSemVerba === 1 ? '' : 's'}</div>
      </div>
      <div class="kpi">
        <div class="kpi-rotulo">Saldo em conta</div>
        <div class="kpi-valor">${brl(saldoTotal)}</div>
        <div class="kpi-nota">${ativas.length} contas ativas</div>
      </div>
      <div class="kpi">
        <div class="kpi-rotulo">Queima por dia</div>
        <div class="kpi-valor">${brl(burnTotal)}</div>
        <div class="kpi-nota">${burnTotal > 0 ? `carteira dura ~${Math.floor(saldoTotal / burnTotal)} dias` : 'nenhuma campanha ativa'}</div>
      </div>
      <div class="kpi${criticas.length ? ' destaque' : ''}">
        <div class="kpi-rotulo">Precisa de aporte</div>
        <div class="kpi-valor${criticas.length ? ' alerta' : ''}">${criticas.length}</div>
        <div class="kpi-nota">sem verba ou menos de 3 dias</div>
      </div>
    </div>`;

  const linhas = ordenarPorUrgencia(estado.contas)
    .map((c) => `
      <tr class="clicavel" data-cliente="${esc(c.cliente_slug)}" tabindex="0">
        <td>
          <div class="cel-cliente">${esc(c.cliente)}</div>
          <div class="cel-sub">${esc(c.conta)}</div>
        </td>
        <td>${plat(c.platform)}</td>
        <td>${chip(c.situacao)}</td>
        <td class="num">${brl(c.saldo)}</td>
        <td class="num">${brl(c.burn_projecao)}</td>
        <td class="num">${barraDias(c.dias_restantes, c.situacao)}</td>
        <td class="num">${brl(c.gasto_mes_atual)}</td>
        <td class="cel-sub">${esc(c.gestor ?? '—')}</td>
      </tr>`).join('');

  const tabela = estado.contas.length ? `
    <div class="tabela-caixa">
      <table>
        <caption class="oculto">Contas de anúncio ordenadas por urgência</caption>
        <thead>
          <tr>
            <th scope="col">Cliente / conta</th>
            <th scope="col">Plataforma</th>
            <th scope="col">Situação</th>
            <th scope="col" class="num">Saldo</th>
            <th scope="col" class="num">Queima/dia</th>
            <th scope="col" class="num">Dias restantes</th>
            <th scope="col" class="num">Gasto no mês</th>
            <th scope="col">Gestor</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
    </div>` : vazio();

  return `
    ${kpis}
    <section class="bloco">
      <div class="bloco-cabeca">
        <h2>Todas as contas</h2>
        <span class="bloco-nota">ordenadas por urgência · clique para abrir o cliente</span>
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

  if (!estado.clienteSel || !slugs.includes(estado.clienteSel)) {
    const urgente = ordenarPorUrgencia(estado.contas)[0];
    estado.clienteSel = urgente?.cliente_slug ?? slugs[0];
  }

  const opcoes = ordenarPorUrgencia(estado.clientes, 'situacao_pior', 'dias_restantes_menor')
    .map((c) => `<option value="${esc(c.cliente_slug)}"${c.cliente_slug === estado.clienteSel ? ' selected' : ''}>
        ${esc(c.cliente)}${c.situacao_pior !== 'ok' ? ` — ${SITUACOES[c.situacao_pior]?.rotulo ?? ''}` : ''}
      </option>`).join('');

  const contas = estado.contas.filter((c) => c.cliente_slug === estado.clienteSel);
  const resumo = estado.clientes.find((c) => c.cliente_slug === estado.clienteSel);
  const serie = estado.serie.filter((s) => contas.some((c) => c.account_id === s.account_id));

  const kpis = `
    <div class="kpis">
      <div class="kpi">
        <div class="kpi-rotulo">Saldo do cliente</div>
        <div class="kpi-valor${Number(resumo?.saldo_total) <= 0 ? ' alerta' : ''}">${brl(resumo?.saldo_total)}</div>
        <div class="kpi-nota">${resumo?.contas_ativas ?? 0} conta(s) ativa(s)</div>
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

  const cartoes = ordenarPorUrgencia(contas).map((c) => `
    <article class="conta${['critico', 'sem_verba'].includes(c.situacao) ? ' urgente' : ''}">
      <div class="conta-topo">
        <div>
          <div class="conta-nome">${esc(c.conta)}</div>
          <div style="margin-top:4px">${plat(c.platform)}</div>
        </div>
        ${chip(c.situacao)}
      </div>
      <div class="conta-saldo${Number(c.saldo) <= 0 ? ' zerado' : ''}">${brl(c.saldo, { centavos: true })}</div>
      <div class="cel-sub" style="margin-bottom:10px">
        ${c.balance_source === 'api' ? 'saldo lido da plataforma' : 'saldo = aportes − gasto'}
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
      </dl>
    </article>`).join('');

  return `
    <div class="seletor">
      <label for="sel-cliente" class="bloco-nota">Cliente</label>
      <select id="sel-cliente">${opcoes}</select>
    </div>
    ${kpis}
    <section class="bloco">
      <div class="bloco-cabeca"><h2>Contas</h2></div>
      <div class="contas">${cartoes}</div>
    </section>
    ${serie.length ? blocoGrafico(serie, 'Investimento diário') : ''}`;
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
  alvo.innerHTML = estado.aba === 'global' ? renderGlobal() : renderCliente();

  document.getElementById('sync-info').textContent = MODO_DEMO
    ? 'dados fictícios'
    : estado.ultimoSync ? `atualizado ${dataHora(estado.ultimoSync)}` : 'nunca sincronizado';

  alvo.querySelectorAll('svg[data-grafico]').forEach(ligarGrafico);

  const sel = document.getElementById('sel-cliente');
  if (sel) sel.addEventListener('change', (e) => { estado.clienteSel = e.target.value; render(); });

  alvo.querySelectorAll('tr.clicavel').forEach((tr) => {
    const abrir = () => {
      estado.clienteSel = tr.dataset.cliente;
      trocarAba('cliente');
    };
    tr.addEventListener('click', abrir);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') abrir(); });
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
        balance_source: 'ledger', ativo: true,
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

  return { contas, clientes, serie, ultimoSync: new Date().toISOString() };
}

iniciar();
