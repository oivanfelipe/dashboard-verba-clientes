/* =========================================================
   Regras de negócio puras.
   Espelha o que a view inv_account_status calcula no Postgres.
   O banco é a fonte da verdade; isto existe para o modo demo e para
   qualquer recálculo local não divergir do SQL.
   ========================================================= */

export const SITUACOES = {
  sem_verba:      { rotulo: 'Sem verba',      peso: 0 },
  critico:        { rotulo: 'Crítico',        peso: 1 },
  atencao:        { rotulo: 'Atenção',        peso: 2 },
  sem_veiculacao: { rotulo: 'Sem veiculação', peso: 3 },
  ok:             { rotulo: 'Ok',             peso: 4 },
  sem_dado:       { rotulo: 'Sem dado',       peso: 5 },
  inativo:        { rotulo: 'Inativa',        peso: 6 },
};

export const PLATAFORMAS = {
  meta:   { rotulo: 'Meta Ads',   cor: '#1f5fa8' },
  google: { rotulo: 'Google Ads', cor: '#c4620a' },
};

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
