-- =============================================================
-- 0005 — Sync do Windsor rodando dentro do Postgres
--
-- Substitui a Edge Function que existia em supabase/functions/sync-windsor.
-- pg_cron e pg_net já estavam instalados no projeto e a extensão http dá
-- chamada síncrona, então não há motivo para depender de deploy por CLI:
-- uma migration, um segredo no Vault e um agendamento resolvem.
--
-- A chave vive no Vault como 'windsor_api_key' e nunca aparece em log — a
-- função monta a URL localmente e não a devolve no retorno.
--
-- Pré-requisito (rodar uma vez, com a chave real):
--   select vault.create_secret('SUA_CHAVE', 'windsor_api_key',
--                              'Windsor.ai API key');
--
-- Agendamento:
--   select cron.schedule('inv-sync-windsor', '0 9 * * *',
--                        $$select public.inv_sync_windsor(7)$$);
-- =============================================================

create extension if not exists http with schema extensions;

create or replace function public.inv_sync_windsor(p_dias integer default 7)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_key    text;
  v_log_id bigint;
  v_url    text;
  v_resp   extensions.http_response;
  v_data   jsonb;
  v_ok     integer := 0;
  v_erro   integer := 0;
  v_notas  text[] := '{}';
  v_ref    date;
  v_status text;
begin
  select decrypted_secret into v_key
    from vault.decrypted_secrets where name = 'windsor_api_key';

  if v_key is null or v_key = '' then
    raise exception 'Segredo "windsor_api_key" não encontrado no Vault.';
  end if;

  insert into public.inv_sync_log(status) values ('rodando') returning id into v_log_id;
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT', '180');

  -- ---------------------------------------------------------
  -- META
  -- Desce até o ad set de propósito: campanha CBO guarda o orçamento em
  -- campaign_daily_budget e ABO em adset_daily_budget, mutuamente
  -- exclusivos. Sem a granularidade de ad set o ABO não soma e o CBO seria
  -- contado uma vez por ad set. Ambos vêm em centavos.
  -- ---------------------------------------------------------
  begin
    v_url := 'https://connectors.windsor.ai/facebook?api_key=' || v_key
          || '&date_preset=last_' || p_dias || 'dT'
          || '&fields=account_id,campaign,campaign_status,adset_name,adset_status,'
          || 'campaign_daily_budget,adset_daily_budget,account_balance,date,spend';

    select * into v_resp from extensions.http_get(v_url);
    if v_resp.status <> 200 then
      raise exception 'Windsor facebook devolveu HTTP %', v_resp.status;
    end if;
    v_data := (v_resp.content::jsonb) -> 'data';

    drop table if exists _w_meta;
    create temp table _w_meta as
    select a.id as account_id,
           nullif(r->>'campaign','')                             as campanha,
           upper(coalesce(r->>'campaign_status',''))             as camp_status,
           coalesce(nullif(r->>'adset_name',''), '(sem adset)')  as adset,
           nullif(r->>'campaign_daily_budget','')::numeric       as cbo_cent,
           nullif(r->>'adset_daily_budget','')::numeric          as abo_cent,
           nullif(r->>'account_balance','')::numeric             as faturar_cent,
           nullif(r->>'date','')::date                           as data,
           coalesce(nullif(r->>'spend','')::numeric, 0)          as spend
    from jsonb_array_elements(v_data) r
    join public.inv_ad_accounts a
      on a.platform = 'meta'
     and a.ativo
     and a.external_id = regexp_replace(coalesce(r->>'account_id',''), '\D', '', 'g')
    where nullif(r->>'date','') is not null
      and nullif(r->>'campaign','') is not null;

    drop table if exists _w_meta_camp;
    create temp table _w_meta_camp as
    with por_adset as (
      select account_id, data, campanha, adset,
             max(camp_status) as camp_status,
             max(cbo_cent)    as cbo_cent,
             max(abo_cent)    as abo_cent,
             sum(spend)       as spend
      from _w_meta
      group by account_id, data, campanha, adset
    )
    select account_id, data, campanha,
           max(camp_status) as status,
           -- CBO e ABO são exclusivos: um dos dois é sempre nulo, então
           -- somar os dois dá o orçamento da campanha sem dupla contagem.
           (coalesce(max(cbo_cent), 0) + coalesce(sum(abo_cent), 0)) / 100 as orcamento,
           sum(spend) as spend
    from por_adset
    group by account_id, data, campanha;

    insert into public.inv_campaign_daily (account_id, data, campanha, status, orcamento, spend)
    select account_id, data, campanha, status,
           nullif(round(orcamento, 2), 0), round(spend, 2)
    from _w_meta_camp
    on conflict (account_id, data, campanha) do update
      set status = excluded.status, orcamento = excluded.orcamento,
          spend = excluded.spend, synced_at = now();

    insert into public.inv_daily_spend (account_id, data, spend)
    select account_id, data, round(sum(spend), 2)
    from _w_meta_camp group by account_id, data
    on conflict (account_id, data) do update
      set spend = excluded.spend, synced_at = now();

    -- Snapshot da configuração: usa o dia mais recente da janela, não
    -- current_date — de madrugada o dia corrente ainda não tem linha.
    select max(data) into v_ref from _w_meta_camp;

    insert into public.inv_budget_snapshots
      (account_id, data, daily_budget_ativo, campanhas_ativas, valor_a_faturar)
    select c.account_id, current_date,
           round(sum(c.orcamento), 2), count(*),
           (select round(max(m.faturar_cent) / 100, 2)
              from _w_meta m where m.account_id = c.account_id)
    from _w_meta_camp c
    where c.data = v_ref and c.status in ('ACTIVE', 'ENABLED')
    group by c.account_id
    on conflict (account_id, data) do update
      set daily_budget_ativo = excluded.daily_budget_ativo,
          campanhas_ativas   = excluded.campanhas_ativas,
          valor_a_faturar    = excluded.valor_a_faturar,
          synced_at = now();

    v_ok := v_ok + 1;
  exception when others then
    v_erro := v_erro + 1;
    v_notas := v_notas || ('meta: ' || sqlerrm);
  end;

  -- ---------------------------------------------------------
  -- GOOGLE
  -- campaign_budget já vem em reais. account_id vem com hífen.
  -- ---------------------------------------------------------
  begin
    v_url := 'https://connectors.windsor.ai/google_ads?api_key=' || v_key
          || '&date_preset=last_' || p_dias || 'dT'
          || '&fields=account_id,campaign,campaign_status,campaign_budget,date,spend';

    select * into v_resp from extensions.http_get(v_url);
    if v_resp.status <> 200 then
      raise exception 'Windsor google_ads devolveu HTTP %', v_resp.status;
    end if;
    v_data := (v_resp.content::jsonb) -> 'data';

    drop table if exists _w_goo;
    create temp table _w_goo as
    select a.id as account_id,
           nullif(r->>'campaign','')                     as campanha,
           upper(coalesce(r->>'campaign_status',''))     as status,
           nullif(r->>'campaign_budget','')::numeric     as orcamento,
           nullif(r->>'date','')::date                   as data,
           coalesce(nullif(r->>'spend','')::numeric, 0)  as spend
    from jsonb_array_elements(v_data) r
    join public.inv_ad_accounts a
      on a.platform = 'google'
     and a.ativo
     and a.external_id = regexp_replace(coalesce(r->>'account_id',''), '\D', '', 'g')
    where nullif(r->>'date','') is not null
      and nullif(r->>'campaign','') is not null;

    insert into public.inv_campaign_daily (account_id, data, campanha, status, orcamento, spend)
    select account_id, data, campanha, max(status),
           nullif(round(max(orcamento), 2), 0), round(sum(spend), 2)
    from _w_goo group by account_id, data, campanha
    on conflict (account_id, data, campanha) do update
      set status = excluded.status, orcamento = excluded.orcamento,
          spend = excluded.spend, synced_at = now();

    insert into public.inv_daily_spend (account_id, data, spend)
    select account_id, data, round(sum(spend), 2)
    from _w_goo group by account_id, data
    on conflict (account_id, data) do update
      set spend = excluded.spend, synced_at = now();

    select max(data) into v_ref from _w_goo;

    insert into public.inv_budget_snapshots
      (account_id, data, daily_budget_ativo, campanhas_ativas)
    select account_id, current_date,
           round(sum(orcamento), 2), count(distinct campanha)
    from (select account_id, campanha, max(orcamento) as orcamento
            from _w_goo
           where data = v_ref and status in ('ACTIVE', 'ENABLED')
           group by account_id, campanha) t
    group by account_id
    on conflict (account_id, data) do update
      set daily_budget_ativo = excluded.daily_budget_ativo,
          campanhas_ativas   = excluded.campanhas_ativas,
          synced_at = now();

    v_ok := v_ok + 1;
  exception when others then
    v_erro := v_erro + 1;
    v_notas := v_notas || ('google: ' || sqlerrm);
  end;

  v_status := case when v_erro = 0 then 'ok'
                   when v_ok  > 0 then 'parcial'
                   else 'erro' end;

  update public.inv_sync_log
     set finalizado_em = now(), status = v_status,
         contas_ok = v_ok, contas_erro = v_erro,
         detalhe = nullif(array_to_string(v_notas, ' | '), '')
   where id = v_log_id;

  return jsonb_build_object('status', v_status, 'conectores_ok', v_ok,
                            'conectores_erro', v_erro,
                            'detalhe', array_to_string(v_notas, ' | '));
end;
$$;

comment on function public.inv_sync_windsor(integer) is
  'Puxa Meta e Google do Windsor.ai e atualiza inv_campaign_daily, inv_daily_spend e inv_budget_snapshots. Chave lida do Vault (windsor_api_key).';

revoke all on function public.inv_sync_windsor(integer) from anon, authenticated;
