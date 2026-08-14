/* =========================================================
   Regras de negócio puras.
   Espelha o que a view inv_account_status calcula no Postgres.
   O banco é a fonte da verdade; isto existe para o modo demo e para
   qualquer recálculo local não divergir do SQL.
   ========================================================= */

export const SITUACOES = {
  sem_verba:      { rotulo: 'Sem verba',          peso: 0 },
  critico:        { rotulo: 'Crítico',            peso: 1 },
  atencao:        { rotulo: 'Atenção',            peso: 2 },
  sem_veiculacao: { rotulo: 'Sem veiculação',     peso: 3 },
  ok:             { rotulo: 'Ok',                 peso: 4 },
  // Ledger ainda não iniciado: sem aporte lançado não dá para falar de saldo.
  // Não é alarme — é cadastro pendente, e por isso fica no fim da ordenação.
  sem_ledger:     { rotulo: 'Aporte não lançado', peso: 5 },
  sem_dado:       { rotulo: 'Sem dado',           peso: 6 },
  inativo:        { rotulo: 'Inativa',            peso: 7 },
};

/**
 * Sinal de saldo inferido pela entrega.
 *
 * Nenhuma API de anúncio devolve saldo disponível. Mas conta que para de
 * entregar com campanha ativa e orçamento configurado quase sempre parou
 * por falta de verba. É INFERÊNCIA, não fato — a interface precisa dizer
 * isso, porque a causa também pode ser reprovação de anúncio, audiência
 * esgotada ou pausa manual.
 */
export const SINAIS = {
  provavel_sem_saldo: { rotulo: 'Provável sem saldo', peso: 0, chip: 'critico' },
  saldo_apertado:     { rotulo: 'Saldo apertado',     peso: 1, chip: 'atencao' },
  oscilando:          { rotulo: 'Oscilando',          peso: 2, chip: 'sem_veiculacao' },
  entregando:         { rotulo: 'Entregando',         peso: 3, chip: 'ok' },
};

export const PLATAFORMAS = {
  meta:   { rotulo: 'Meta Ads',   cor: '#1f5fa8' },
  google: { rotulo: 'Google Ads', cor: '#c4620a' },
};

/**
 * Status operacional — UMA leitura por conta, não três colunas para cruzar.
 *
 * Substitui a combinação anterior de "situação" (baseada em ledger, quase
 * sempre vazio), "sinal de entrega" (inferência) e "campanhas ativas" como
 * sinais separados. A pergunta que importa é uma só: essa conta está
 * investindo agora, e se não está, por quê. A resposta vem de duas fontes,
 * checadas nesta ordem — pausa/parada é fato observável na plataforma, só
 * depois disso entra a inferência de saldo:
 *
 *   1. campanhas_total / campanhas_ativas_hoje  (fato: rodou ou não rodou)
 *   2. dias_sem_dado_novo                        (fato: o Windsor parou de trazer dado)
 *   3. sinal de entrega                          (inferência: por que não rodou)
 */
export const STATUS_OPERACIONAL = {
  parada:        { rotulo: 'Parada — nenhuma campanha ativa', peso: 0, chip: 'critico' },
  sem_sync:      { rotulo: 'Sem dado recente',                peso: 1, chip: 'critico' },
  sem_saldo:     { rotulo: 'Provável sem saldo',              peso: 2, chip: 'critico' },
  saldo_apertado:{ rotulo: 'Saldo apertado',                  peso: 3, chip: 'atencao' },
  parcial:       { rotulo: 'Parte das campanhas pausada',     peso: 4, chip: 'atencao' },
  investindo:    { rotulo: 'Investindo normal',               peso: 5, chip: 'ok' },
  sem_campanha:  { rotulo: 'Sem campanha configurada',        peso: 6, chip: 'sem_veiculacao' },
  inativa:       { rotulo: 'Inativa',                         peso: 7, chip: 'inativo' },
};

/**
 * @param {object} p
 * @param {boolean} p.ativo
 * @param {number|null} p.campanhasTotal      quantas campanhas apareceram no último dia com dado
 * @param {number|null} p.campanhasAtivasHoje quantas dessas estavam ativas
 * @param {number|null} p.diasSemDadoNovo     current_date - último dia com dado no Windsor
 * @param {string|undefined} p.sinal          chave de SINAIS (entrega inferida)
 */
export function statusOperacionalDe({ ativo = true, campanhasTotal, campanhasAtivasHoje, diasSemDadoNovo, sinal }) {
  if (!ativo) return 'inativa';
  if (campanhasTotal === null || campanhasTotal === undefined || campanhasTotal === 0) return 'sem_campanha';
  // Dado parado há 3+ dias: o que campanhasAtivasHoje diz pode já estar
  // desatualizado, então isso vem antes de checar "parada".
  if (diasSemDadoNovo !== null && diasSemDadoNovo !== undefined && diasSemDadoNovo >= 3) return 'sem_sync';
  if (campanhasAtivasHoje === 0) return 'parada';
  if (sinal === 'provavel_sem_saldo') return 'sem_saldo';
  if (sinal === 'saldo_apertado') return 'saldo_apertado';
  if (campanhasAtivasHoje < campanhasTotal) return 'parcial';
  return 'investindo';
}

/** Ordena pelo peso do status operacional, depois por dias restantes. */
export function ordenarPorStatusOperacional(linhas) {
  return [...linhas].sort((a, b) => {
    const pa = STATUS_OPERACIONAL[a.statusOp]?.peso ?? 99;
    const pb = STATUS_OPERACIONAL[b.statusOp]?.peso ?? 99;
    if (pa !== pb) return pa - pb;
    const da = a.dias_restantes ?? Infinity;
    const db = b.dias_restantes ?? Infinity;
    if (da !== db) return da - db;
    return String(a.cliente || '').localeCompare(String(b.cliente || ''), 'pt-BR');
  });
}

/**
 * Janela de datas para o filtro de período. Datas em 'YYYY-MM-DD', locais
 * (sem componente de hora), para comparar direto com a coluna `data`.
 */
export const PERIODOS = {
  '7d':          { rotulo: 'últimos 7 dias' },
  '30d':         { rotulo: 'últimos 30 dias' },
  mes_atual:     { rotulo: 'mês atual' },
  mes_anterior:  { rotulo: 'mês anterior' },
};

const isoData = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export function faixaPeriodo(chave) {
  const hoje = new Date();
  if (chave === '7d') {
    const ini = new Date(hoje); ini.setDate(ini.getDate() - 6);
    return { inicio: isoData(ini), fim: isoData(hoje) };
  }
  if (chave === 'mes_atual') {
    const ini = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
    return { inicio: isoData(ini), fim: isoData(hoje) };
  }
  if (chave === 'mes_anterior') {
    const ini = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
    const fim = new Date(hoje.getFullYear(), hoje.getMonth(), 0);
    return { inicio: isoData(ini), fim: isoData(fim) };
  }
  // '30d' e default
  const ini = new Date(hoje); ini.setDate(ini.getDate() - 29);
  return { inicio: isoData(ini), fim: isoData(hoje) };
}

/**
 * Ritmo de queima usado na projeção: o maior entre o orçamento diário
 * configurado nas campanhas ativas e a média real dos últimos 7 dias.
 *
 * Só o configurado superestima — campanha raramente entrega 100% do orçamento.
 * Só o real subestima logo depois de um aumento de verba, que é justamente
 * quando o saldo acaba mais rápido. Pegar o maior faz o alerta chegar antes.
 */
export function burnProjecao(burnConfigurado, burnReal7d) {
  return Math.max(Number(burnConfigurado) || 0, Number(burnReal7d) || 0);
}

export function diasRestantes(saldo, burn) {
  if (!(burn > 0) || !(saldo > 0)) return null;
  return Math.floor(saldo / burn);
}

export function situacaoDe({ ativo = true, balanceSource = 'ledger', saldo, burn }) {
  if (!ativo) return 'inativo';
  if (balanceSource === 'api' && (saldo === null || saldo === undefined)) return 'sem_dado';
  if (!(saldo > 0)) return 'sem_verba';
  if (!(burn > 0)) return 'sem_veiculacao';
  const d = saldo / burn;
  if (d < 3) return 'critico';
  if (d < 7) return 'atencao';
  return 'ok';
}

/** Pior situação entre as contas de um cliente. */
export function piorSituacao(situacoes) {
  let pior = 'inativo';
  for (const s of situacoes) {
    if ((SITUACOES[s]?.peso ?? 99) < (SITUACOES[pior]?.peso ?? 99)) pior = s;
  }
  return pior;
}

/** Ordena por urgência: pior situação primeiro, depois menos dias restantes. */
export function ordenarPorUrgencia(linhas, chaveSituacao = 'situacao', chaveDias = 'dias_restantes') {
  return [...linhas].sort((a, b) => {
    const pa = SITUACOES[a[chaveSituacao]]?.peso ?? 99;
    const pb = SITUACOES[b[chaveSituacao]]?.peso ?? 99;
    if (pa !== pb) return pa - pb;
    const da = a[chaveDias] ?? Infinity;
    const db = b[chaveDias] ?? Infinity;
    if (da !== db) return da - db;
    return String(a.cliente || '').localeCompare(String(b.cliente || ''), 'pt-BR');
  });
}

/* ---------- Formatação ---------- */

const _brl = new Intl.NumberFormat('pt-BR', {
  style: 'currency', currency: 'BRL', maximumFractionDigits: 0,
});
const _brlCent = new Intl.NumberFormat('pt-BR', {
  style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2,
});

export function brl(v, { centavos = false } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return centavos ? _brlCent.format(n) : _brl.format(n);
}

export function dias(d) {
  if (d === null || d === undefined) return '—';
  return d === 1 ? '1 dia' : `${d} dias`;
}

export function dataCurta(iso) {
  if (!iso) return '—';
  const [a, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}`;
}

export function dataHora(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Largura da barrinha de dias restantes.
 * Satura em 30 dias — acima disso a diferença não muda decisão nenhuma.
 */
export function larguraDias(d) {
  if (d === null || d === undefined) return 0;
  return Math.max(4, Math.min(100, (d / 30) * 100));
}
