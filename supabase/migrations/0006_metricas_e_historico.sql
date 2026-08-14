-- =============================================================
-- 0006 — Métricas de performance e histórico de investimento
--
-- Guardamos apenas contadores brutos (impressões, cliques, conversões,
-- valor). CPM, CPC, CTR, CPA e ROAS são SEMPRE derivados na leitura:
-- média de médias mente — a soma dos gastos dividida pela soma dos
-- cliques é o CPC real do período; a média dos CPCs diários não é.
--
-- Assimetria conhecida: o conector do Meta não expõe conversões sob nome
-- direto (só via breakdown de actions), então conversoes e valor_conversao
-- ficam nulos para meta. A interface mostra "—", nunca zero.
--
-- Esta migration redefine inv_sync_windsor da 0005 para trazer os novos
-- campos, e tira o teto de 90 dias de inv_spend_series: é histórico de
-- investimento, não janela de monitoramento.
-- =============================================================

alter table public.inv_campaign_daily
  add column if not exists impressoes      bigint,
  add column if not exists cliques         bigint,
  add column if not exists conversoes      numeric(14,2),
  add column if not exists valor_conversao numeric(14,2);

comment on column public.inv_campaign_daily.conversoes is
  'Só Google. O conector do Meta não expõe conversões por nome direto.';

-- ---------- Histórico mensal por cliente e plataforma ----------
create or replace view public.inv_historico_mensal as
select
  a.client_id, c.nome as cliente, c.slug as cliente_slug, a.platform,
  date_trunc('month', cd.data)::date as mes,
  round(sum(cd.spend), 2)           as investimento,
  sum(cd.impressoes)                as impressoes,
  sum(cd.cliques)                   as cliques,
  sum(cd.conversoes)                as conversoes,
  round(sum(cd.valor_conversao), 2) as valor_conversao,
  count(distinct cd.data)           as dias_com_dado,
  count(distinct cd.campanha)       as campanhas,
  -- Derivadas, sempre a partir das somas.
  case when sum(cd.impressoes) > 0
       then round(sum(cd.spend) * 1000 / sum(cd.impressoes), 2) end     as cpm,
  case when sum(cd.cliques) > 0
       then round(sum(cd.spend) / sum(cd.cliques), 2) end               as cpc,
  case when sum(cd.impressoes) > 0
       then round(100.0 * sum(cd.cliques) / sum(cd.impressoes), 2) end  as ctr,
  case when sum(cd.conversoes) > 0
       then round(sum(cd.spend) / sum(cd.conversoes), 2) end            as cpa,
  case when sum(cd.spend) > 0 and sum(cd.valor_conversao) > 0
       then round(sum(cd.valor_conversao) / sum(cd.spend), 2) end       as roas
from public.inv_campaign_daily cd
join public.inv_ad_accounts a on a.id = cd.account_id
join public.inv_clients     c on c.id = a.client_id
group by a.client_id, c.nome, c.slug, a.platform, date_trunc('month', cd.data);

-- ---------- Total da carteira por mês ----------
-- Mês parcial precisa ser marcado, senão a barra dele aparece do mesmo
-- tamanho visual que a de um mês fechado e a leitura fica errada. São dois
-- casos: o primeiro mês da série (o backfill começou no meio) e o corrente.
create or replace view public.inv_historico_carteira as
select
  date_trunc('month', cd.data)::date as mes,
  round(sum(cd.spend), 2)       as investimento,
  sum(cd.impressoes)            as impressoes,
  sum(cd.cliques)               as cliques,
  sum(cd.conversoes)            as conversoes,
  count(distinct a.client_id)   as clientes,
  count(distinct cd.account_id) as contas,
  min(cd.data)                  as primeiro_dia,
  max(cd.data)                  as ultimo_dia,
  (min(cd.data) > date_trunc('month', cd.data)::date
   or max(cd.data) < (date_trunc('month', cd.data) + interval '1 month - 1 day')::date)
                                as parcial
from public.inv_campaign_daily cd
join public.inv_ad_accounts a on a.id = cd.account_id
group by date_trunc('month', cd.data);

-- Sem teto de janela: é histórico, não monitoramento.
create or replace view public.inv_spend_series as
select s.account_id, a.client_id, a.platform, s.data, s.spend
from public.inv_daily_spend s
join public.inv_ad_accounts a on a.id = s.account_id;

revoke all on public.inv_historico_mensal, public.inv_historico_carteira,
              public.inv_spend_series
  from anon, authenticated;
grant select on public.inv_historico_mensal, public.inv_historico_carteira,
                public.inv_spend_series
  to anon, authenticated;

-- ---------- Sync com as métricas novas ----------
-- Redefine a função da 0005. A estrutura é a mesma; mudam as listas de
-- campos pedidos ao Windsor e as colunas gravadas.
create or replace function public.inv_sync_windsor(p_dias integer default 7)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_key text; v_log_id bigint; v_url text;
  v_resp extensions.http_response; v_data jsonb;
  v_ok integer := 0; v_erro integer := 0; v_notas text[] := '{}';
  v_ref date; v_status text;
begin
  select decrypted_secret into v_key
    from vault.decrypted_secrets where name = 'windsor_api_key';
  if v_key is null or v_key = '' then
    raise exception 'Segredo "windsor_api_key" não encontrado no Vault.';
  end if;

  insert into public.inv_sync_log(status) values ('rodando') returning id into v_log_id;
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '180');

  -- ---------------- META ----------------
  -- Desce até o ad set: CBO guarda orçamento em campaign_daily_budget e ABO
  -- em adset_daily_budget, mutuamente exclusivos, ambos em centavos. Sem essa
  -- granularidade o ABO não soma e o CBO seria contado uma vez por ad set.
  -- O conector não expõe conversões por nome direto — ficam nulas aqui.
  begin
    v_url := 'https://connectors.windsor.ai/facebook?api_key=' || v_key
          || '&date_preset=last_' || p_dias || 'dT'
          || '&fields=account_id,campaign,campaign_status,adset_name,adset_status,'
          || 'campaign_daily_budget,adset_daily_budget,account_balance,date,spend,'
          || 'impressions,clicks';

    select * into v_resp from extensions.http_get(v_url);
    if v_resp.status <> 200 then
      raise exception 'Windsor facebook devolveu HTTP %', v_resp.status;
    end if;
    v_data := (v_resp.content::jsonb) -> 'data';

    drop table if exists _w_meta;
    create temp table _w_meta as
    select a.id as account_id,
           nullif(r->>'campaign','')                            as campanha,
           upper(coalesce(r->>'campaign_status',''))            as camp_status,
           coalesce(nullif(r->>'adset_name',''),'(sem adset)')  as adset,
           nullif(r->>'campaign_daily_budget','')::numeric      as cbo_cent,
           nullif(r->>'adset_daily_budget','')::numeric         as abo_cent,
           nullif(r->>'account_balance','')::numeric            as faturar_cent,
           nullif(r->>'date','')::date                          as data,
           coalesce(nullif(r->>'spend','')::numeric, 0)         as spend,
           coalesce(nullif(r->>'impressions','')::numeric, 0)::bigint as impressoes,
           coalesce(nullif(r->>'clicks','')::numeric, 0)::bigint      as cliques
    from jsonb_array_elements(v_data) r
    join public.inv_ad_accounts a
      on a.platform = 'meta' and a.ativo
     and a.external_id = regexp_replace(coalesce(r->>'account_id',''), '\D', '', 'g')
    where nullif(r->>'date','') is not null
      and nullif(r->>'campaign','') is not null;

    drop table if exists _w_meta_camp;
    create temp table _w_meta_camp as
    with por_adset as (
      select account_id, data, campanha, adset,
             max(camp_status) as camp_status,
             max(cbo_cent) as cbo_cent, max(abo_cent) as abo_cent,
             sum(spend) as spend, sum(impressoes) as impressoes, sum(cliques) as cliques
      from _w_meta group by account_id, data, campanha, adset
    )
    select account_id, data, campanha,
           max(camp_status) as status,
           -- CBO e ABO são exclusivos: somar os dois não duplica.
           (coalesce(max(cbo_cent),0) + coalesce(sum(abo_cent),0)) / 100 as orcamento,
           sum(spend) as spend, sum(impressoes) as impressoes, sum(cliques) as cliques
    from por_adset group by account_id, data, campanha;

    insert into public.inv_campaign_daily
      (account_id, data, campanha, status, orcamento, spend, impressoes, cliques)
    select account_id, data, campanha, status,
           nullif(round(orcamento,2),0), round(spend,2), impressoes, cliques
    from _w_meta_camp
    on conflict (account_id, data, campanha) do update
      set status = excluded.status, orcamento = excluded.orcamento,
          spend = excluded.spend, impressoes = excluded.impressoes,
          cliques = excluded.cliques, synced_at = now();

    insert into public.inv_daily_spend (account_id, data, spend)
    select account_id, data, round(sum(spend),2) from _w_meta_camp group by account_id, data
    on conflict (account_id, data) do update
      set spend = excluded.spend, synced_at = now();

    -- Usa o dia mais recente da janela, não current_date: de madrugada o dia
    -- corrente ainda não tem linha e o snapshot zeraria.
    select max(data) into v_ref from _w_meta_camp;

    insert into public.inv_budget_snapshots
      (account_id, data, daily_budget_ativo, campanhas_ativas, valor_a_faturar)
    select c.account_id, current_date, round(sum(c.orcamento),2), count(*),
           (select round(max(m.faturar_cent)/100,2) from _w_meta m
             where m.account_id = c.account_id)
    from _w_meta_camp c
    where c.data = v_ref and c.status in ('ACTIVE','ENABLED')
    group by c.account_id
    on conflict (account_id, data) do update
      set daily_budget_ativo = excluded.daily_budget_ativo,
          campanhas_ativas = excluded.campanhas_ativas,
          valor_a_faturar = excluded.valor_a_faturar, synced_at = now();

    v_ok := v_ok + 1;
  exception when others then
    v_erro := v_erro + 1; v_notas := v_notas || ('meta: ' || sqlerrm);
  end;

  -- ---------------- GOOGLE ----------------
  -- campaign_budget já vem em reais; account_id vem com hífen.
  begin
    v_url := 'https://connectors.windsor.ai/google_ads?api_key=' || v_key
          || '&date_preset=last_' || p_dias || 'dT'
          || '&fields=account_id,campaign,campaign_status,campaign_budget,date,spend,'
          || 'impressions,clicks,conversions,conversion_value';

    select * into v_resp from extensions.http_get(v_url);
    if v_resp.status <> 200 then
      raise exception 'Windsor google_ads devolveu HTTP %', v_resp.status;
    end if;
    v_data := (v_resp.content::jsonb) -> 'data';

    drop table if exists _w_goo;
    create temp table _w_goo as
    select a.id as account_id,
           nullif(r->>'campaign','')                    as campanha,
           upper(coalesce(r->>'campaign_status',''))    as status,
           nullif(r->>'campaign_budget','')::numeric    as orcamento,
           nullif(r->>'date','')::date                  as data,
           coalesce(nullif(r->>'spend','')::numeric, 0) as spend,
           coalesce(nullif(r->>'impressions','')::numeric, 0)::bigint as impressoes,
           coalesce(nullif(r->>'clicks','')::numeric, 0)::bigint      as cliques,
           coalesce(nullif(r->>'conversions','')::numeric, 0)         as conversoes,
           coalesce(nullif(r->>'conversion_value','')::numeric, 0)    as valor_conversao
    from jsonb_array_elements(v_data) r
    join public.inv_ad_accounts a
      on a.platform = 'google' and a.ativo
     and a.external_id = regexp_replace(coalesce(r->>'account_id',''), '\D', '', 'g')
    where nullif(r->>'date','') is not null
      and nullif(r->>'campaign','') is not null;

    insert into public.inv_campaign_daily
      (account_id, data, campanha, status, orcamento, spend,
       impressoes, cliques, conversoes, valor_conversao)
    select account_id, data, campanha, max(status),
           nullif(round(max(orcamento),2),0), round(sum(spend),2),
           sum(impressoes), sum(cliques), sum(conversoes), round(sum(valor_conversao),2)
    from _w_goo group by account_id, data, campanha
    on conflict (account_id, data, campanha) do update
      set status = excluded.status, orcamento = excluded.orcamento,
          spend = excluded.spend, impressoes = excluded.impressoes,
          cliques = excluded.cliques, conversoes = excluded.conversoes,
          valor_conversao = excluded.valor_conversao, synced_at = now();

    insert into public.inv_daily_spend (account_id, data, spend)
    select account_id, data, round(sum(spend),2) from _w_goo group by account_id, data
    on conflict (account_id, data) do update
      set spend = excluded.spend, synced_at = now();

    select max(data) into v_ref from _w_goo;

    insert into public.inv_budget_snapshots
      (account_id, data, daily_budget_ativo, campanhas_ativas)
    select account_id, current_date, round(sum(orcamento),2), count(distinct campanha)
    from (select account_id, campanha, max(orcamento) as orcamento
            from _w_goo where data = v_ref and status in ('ACTIVE','ENABLED')
           group by account_id, campanha) t
    group by account_id
    on conflict (account_id, data) do update
      set daily_budget_ativo = excluded.daily_budget_ativo,
          campanhas_ativas = excluded.campanhas_ativas, synced_at = now();

    v_ok := v_ok + 1;
  exception when others then
    v_erro := v_erro + 1; v_notas := v_notas || ('google: ' || sqlerrm);
  end;

  v_status := case when v_erro = 0 then 'ok' when v_ok > 0 then 'parcial' else 'erro' end;

  update public.inv_sync_log
     set finalizado_em = now(), status = v_status,
         contas_ok = v_ok, contas_erro = v_erro,
         detalhe = nullif(array_to_string(v_notas,' | '),'')
   where id = v_log_id;

  return jsonb_build_object('status', v_status, 'conectores_ok', v_ok,
                            'conectores_erro', v_erro,
                            'detalhe', array_to_string(v_notas,' | '));
end;
$$;

revoke all on function public.inv_sync_windsor(integer) from anon, authenticated;
