/* =========================================================
   sync-windsor — puxa Meta Ads e Google Ads do Windsor.ai
   e grava em inv_daily_spend + inv_budget_snapshots.

   Variáveis de ambiente:
     WINDSOR_API_KEY
     SUPABASE_URL                (injetada pelo runtime)
     SUPABASE_SERVICE_ROLE_KEY   (idem)

   O mapeamento de campos abaixo foi verificado contra dados reais das
   contas da carteira. Os detalhes que importam:

   META
     · Orçamento vive em dois lugares mutuamente exclusivos:
       campanha CBO  -> campaign_daily_budget (adset vem null)
       campanha ABO  -> adset_daily_budget    (campanha vem null)
       Os dois em CENTAVOS. Por isso a consulta desce até adset_name:
       sem essa granularidade não dá para somar ABO corretamente, e o
       CBO seria contado uma vez por adset.
     · account_balance é "Bill amount due" — valor a faturar do ciclo,
       NÃO saldo disponível. Vai para valor_a_faturar, nunca para saldo.

   GOOGLE
     · campaign_budget é o orçamento diário em REAIS (sem conversão).
     · account_id vem formatado com hífen (295-315-8507); o banco guarda
       só os dígitos.
   ========================================================= */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const WINDSOR_API = 'https://connectors.windsor.ai';
const JANELA_DIAS = 7;

const CAMPOS_META = [
  'account_id', 'campaign', 'campaign_status', 'adset_name', 'adset_status',
  'campaign_daily_budget', 'adset_daily_budget', 'account_balance', 'date', 'spend',
];

const CAMPOS_GOOGLE = [
  'account_id', 'campaign', 'campaign_status', 'campaign_budget', 'date', 'spend',
];

type Linha = Record<string, unknown>;

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Google devolve 295-315-8507; o banco guarda 2953158507. */
const soDigitos = (v: unknown) => String(v ?? '').replace(/\D/g, '');

const ativo = (s: unknown) => ['ACTIVE', 'ENABLED'].includes(String(s ?? '').toUpperCase());

const hoje = () => new Date().toISOString().slice(0, 10);

async function puxar(slug: string, campos: string[], apiKey: string): Promise<Linha[]> {
  const url = new URL(`${WINDSOR_API}/${slug}`);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('date_preset', `last_${JANELA_DIAS}dT`);
  url.searchParams.set('fields', campos.join(','));

  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Windsor ${slug}: HTTP ${r.status} — ${await r.text()}`);
  const json = await r.json();
  return Array.isArray(json?.data) ? json.data : [];
}

/** Soma o orçamento diário configurado de uma conta, em reais. */
function orcamentoMeta(linhas: Linha[]) {
  // Chaves distintas para não contar o mesmo CBO uma vez por adset.
  const cbo = new Map<string, number>();
  const abo = new Map<string, number>();

  for (const l of linhas) {
    if (!ativo(l.campaign_status)) continue;
    const camp = String(l.campaign ?? '');

    if (l.campaign_daily_budget != null) {
      cbo.set(camp, num(l.campaign_daily_budget));
    } else if (l.adset_daily_budget != null && ativo(l.adset_status)) {
      abo.set(`${camp}||${String(l.adset_name ?? '')}`, num(l.adset_daily_budget));
    }
  }

  const centavos = [...cbo.values(), ...abo.values()].reduce((a, b) => a + b, 0);
  return { total: centavos / 100, campanhas: new Set([...cbo.keys(), ...[...abo.keys()].map((k) => k.split('||')[0])]).size };
}

function orcamentoGoogle(linhas: Linha[]) {
  const porCampanha = new Map<string, number>();
  for (const l of linhas) {
    if (!ativo(l.campaign_status)) continue;
    if (l.campaign_budget != null) porCampanha.set(String(l.campaign ?? ''), num(l.campaign_budget));
  }
  return {
    total: [...porCampanha.values()].reduce((a, b) => a + b, 0),
    campanhas: porCampanha.size,
  };
}

Deno.serve(async () => {
  const supa = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: log } = await supa
    .from('inv_sync_log').insert({ status: 'rodando' }).select('id').single();
  const logId = log?.id;

  const fim = async (status: string, ok: number, err: number, detalhe?: string) => {
    if (logId) {
      await supa.from('inv_sync_log').update({
        finalizado_em: new Date().toISOString(), status,
        contas_ok: ok, contas_erro: err, detalhe,
      }).eq('id', logId);
    }
    return new Response(JSON.stringify({ status, contas_ok: ok, contas_erro: err, detalhe }), {
      status: status === 'erro' ? 500 : 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const apiKey = Deno.env.get('WINDSOR_API_KEY');
  if (!apiKey) return fim('erro', 0, 0, 'WINDSOR_API_KEY não configurada');

  // Conta que aparece no Windsor sem cadastro é reportada, nunca criada:
  // o vínculo conta ↔ cliente é decisão humana.
  const { data: contas, error: errC } = await supa
    .from('inv_ad_accounts').select('id, platform, external_id').eq('ativo', true);
  if (errC) return fim('erro', 0, 0, errC.message);

  const mapa = new Map((contas ?? []).map((c) => [`${c.platform}:${soDigitos(c.external_id)}`, c.id]));

  let ok = 0, falhas = 0;
  const desconhecidas = new Set<string>();
  const problemas: string[] = [];

  const conectores = [
    { slug: 'facebook',   platform: 'meta',   campos: CAMPOS_META,   orcamento: orcamentoMeta },
    { slug: 'google_ads', platform: 'google', campos: CAMPOS_GOOGLE, orcamento: orcamentoGoogle },
  ];

  for (const con of conectores) {
    let linhas: Linha[];
    try {
      linhas = await puxar(con.slug, con.campos, apiKey);
    } catch (e) {
      falhas++; problemas.push(String(e instanceof Error ? e.message : e));
      continue;
    }

    // Agrupa por conta cadastrada.
    const porConta = new Map<string, Linha[]>();
    for (const l of linhas) {
      const ext = soDigitos(l.account_id);
      if (!ext) continue;
      const id = mapa.get(`${con.platform}:${ext}`);
      if (!id) { desconhecidas.add(`${con.platform}:${ext}`); continue; }
      if (!porConta.has(id)) porConta.set(id, []);
      porConta.get(id)!.push(l);
    }

    const spend: Record<string, unknown>[] = [];
    const snaps: Record<string, unknown>[] = [];
    const agora = new Date().toISOString();

    for (const [contaId, ls] of porConta) {
      // Gasto por dia.
      const porDia = new Map<string, number>();
      for (const l of ls) {
        const d = String(l.date ?? '').slice(0, 10);
        if (d) porDia.set(d, (porDia.get(d) ?? 0) + num(l.spend));
      }
      for (const [data, v] of porDia) {
        spend.push({ account_id: contaId, data, spend: Number(v.toFixed(2)), synced_at: agora });
      }

      // Snapshot de hoje: foto da configuração corrente.
      const { total, campanhas } = con.orcamento(ls);
      const saldoApi = ls.find((l) => l.account_balance != null)?.account_balance;

      snaps.push({
        account_id: contaId,
        data: hoje(),
        daily_budget_ativo: Number(total.toFixed(2)),
        campanhas_ativas: campanhas,
        valor_a_faturar: saldoApi != null ? num(saldoApi) : null,
        synced_at: agora,
      });
    }

    if (spend.length) {
      const { error } = await supa.from('inv_daily_spend')
        .upsert(spend, { onConflict: 'account_id,data' });
      if (error) { falhas++; problemas.push(`spend ${con.slug}: ${error.message}`); continue; }
    }
    if (snaps.length) {
      const { error } = await supa.from('inv_budget_snapshots')
        .upsert(snaps, { onConflict: 'account_id,data' });
      if (error) { falhas++; problemas.push(`budget ${con.slug}: ${error.message}`); }
    }

    ok++;
  }

  const detalhe = [
    problemas.length ? `problemas: ${problemas.join(' | ')}` : null,
    desconhecidas.size ? `sem cadastro: ${[...desconhecidas].join(', ')}` : null,
  ].filter(Boolean).join(' || ') || undefined;

  return fim(falhas === 0 ? 'ok' : ok > 0 ? 'parcial' : 'erro', ok, falhas, detalhe);
});
