-- =============================================================
-- 0003 — Detalhe por campanha, valor a faturar e estado "sem ledger"
--
-- Consolida o que foi aplicado depois da 0002. As definições de
-- inv_account_status e inv_client_overview aqui SUBSTITUEM as da 0001.
-- =============================================================

-- ---------- Valor a faturar (Meta) ----------
-- O Meta expõe account_balance, descrito como "Bill amount due for this Ad
-- Account": é a dívida do ciclo, NÃO o saldo disponível. Vem em centavos.
alter table public.inv_budget_snapshots
  add column if not exists valor_a_faturar numeric(14,2);

comment on column public.inv_budget_snapshots.valor_a_faturar is
  'Meta account_balance: valor a faturar do ciclo, não saldo disponível.';

-- ---------- Detalhe por campanha ----------
create table if not exists public.inv_campaign_daily (
  account_id   uuid not null references public.inv_ad_accounts(id) on delete cascade,
  data         date not null,
  campanha     text not null,
  status       text,
  -- Orçamento diário em reais. Nulo quando o Meta guarda o orçamento no ad set
  -- (campanha ABO) — o total da conta segue correto em inv_budget_snapshots,
  -- só não há como atribuir por campanha aqui.
  orcamento    numeric(14,2),
  spend        numeric(14,2) not null default 0,
  synced_at    timestamptz not null default now(),
  primary key (account_id, data, campanha)
);

create index if not exists inv_campaign_daily_data_idx
  on public.inv_campaign_daily (data desc);

alter table public.inv_campaign_daily enable row level security;
revoke all on public.inv_campaign_daily from anon, authenticated;

create or replace view public.inv_campanhas as
select cd.account_id, a.client_id, c.nome as cliente, c.slug as cliente_slug,
       a.platform, a.nome as conta, cd.data, cd.campanha, cd.status,
       cd.orcamento, cd.spend
from public.inv_campaign_daily cd
join public.inv_ad_accounts a on a.id = cd.account_id
join public.inv_clients     c on c.id = a.client_id
where cd.data >= current_date - 90;

create or replace view public.inv_campanhas_resumo as
select account_id, client_id, cliente, cliente_slug, platform, conta, campanha,
  max(status)          as status,
  max(orcamento)       as orcamento,
  round(sum(spend), 2) as gasto_30d,
  round(sum(spend) filter (where data >= current_date - 7), 2) as gasto_7d,
  round(avg(spend) filter (where data >= current_date - 7), 2) as media_dia_7d,
  max(data) filter (where spend > 0) as ultimo_dia_com_gasto
from public.inv_campanhas
where data >= current_date - 30
group by account_id, client_id, cliente, cliente_slug, platform, conta, campanha;

-- ---------- Situação, com o estado "ledger não iniciado" ----------
-- Conta sem nenhum aporte lançado não está "sem verba" — está com o ledger
-- não iniciado. Sem essa distinção o painel abre com todas as contas em
-- alarme vermelho e o alerta real vira ruído.
drop view if exists public.inv_client_overview;
drop view if exists public.inv_account_status;

create view public.inv_account_status as
with snap as (
  select distinct on (account_id)
         account_id, data as snapshot_data,
         daily_budget_ativo, campanhas_ativas, saldo_api, valor_a_faturar
  from public.inv_budget_snapshots
  order by account_id, data desc
),
aportes as (
  select account_id, sum(valor) as total, count(*) as qtd
  from public.inv_deposits group by account_id
),
gasto_ledger as (
  select s.account_id, sum(s.spend) as total
  from public.inv_daily_spend s
  join public.inv_ad_accounts a on a.id = s.account_id
  where s.data >= a.ledger_inicio
  group by s.account_id
),
gasto_7d as (
  select account_id, sum(spend) / 7.0 as media
  from public.inv_daily_spend
  where data >= current_date - 7 and data < current_date
  group by account_id
),
gasto_mes as (
  select account_id, sum(spend) as total
  from public.inv_daily_spend
  where data >= date_trunc('month', current_date)::date
  group by account_id
),
base as (
  select
    a.id as account_id, a.client_id,
    c.nome as cliente, c.slug as cliente_slug, c.gestor,
    a.platform, a.nome as conta, a.external_id, a.currency,
    a.billing_model, a.balance_source, a.ledger_inicio, a.verba_mensal, a.ativo,
    sn.snapshot_data, sn.valor_a_faturar,
    coalesce(ap.qtd, 0) > 0                      as tem_aporte,
    coalesce(sn.campanhas_ativas, 0)             as campanhas_ativas,
    round(coalesce(sn.daily_budget_ativo, 0), 2) as burn_configurado,
    round(coalesce(g7.media, 0), 2)              as burn_real_7d,
    round(coalesce(ap.total, 0), 2)              as total_aportado,
    round(coalesce(gl.total, 0), 2)              as total_gasto_ledger,
    round(coalesce(gm.total, 0), 2)              as gasto_mes_atual,
    case when a.balance_source = 'api' then sn.saldo_api
         else coalesce(ap.total, 0) - coalesce(gl.total, 0) end as saldo_raw
  from public.inv_ad_accounts a
  join public.inv_clients c on c.id = a.client_id
  left join snap         sn on sn.account_id = a.id
  left join aportes      ap on ap.account_id = a.id
  left join gasto_ledger gl on gl.account_id = a.id
  left join gasto_7d     g7 on g7.account_id = a.id
  left join gasto_mes    gm on gm.account_id = a.id
),
calc as (
  select base.*,
    round(saldo_raw, 2) as saldo,
    round(greatest(burn_configurado, burn_real_7d), 2) as burn_projecao
  from base
)
select calc.*,
  case when burn_projecao > 0 and saldo > 0
       then floor(saldo / burn_projecao)::int else null end as dias_restantes,
  case
    when not ativo                                    then 'inativo'
    when balance_source = 'ledger' and not tem_aporte then 'sem_ledger'
    when balance_source = 'api' and saldo is null     then 'sem_dado'
    when saldo <= 0                                   then 'sem_verba'
    when burn_projecao = 0                            then 'sem_veiculacao'
    when saldo / burn_projecao < 3                    then 'critico'
    when saldo / burn_projecao < 7                    then 'atencao'
    else 'ok'
  end as situacao,
  case when verba_mensal is not null and verba_mensal > 0
       then round(100 * gasto_mes_atual / verba_mensal, 1) else null end as pct_verba_mensal
from calc;

create view public.inv_client_overview as
select
  client_id, cliente, cliente_slug, gestor,
  count(*) filter (where ativo)                            as contas_ativas,
  round(sum(saldo) filter (where ativo and tem_aporte), 2) as saldo_total,
  round(sum(burn_projecao) filter (where ativo), 2)        as burn_diario_total,
  round(sum(gasto_mes_atual) filter (where ativo), 2)      as gasto_mes_total,
  min(dias_restantes) filter (where ativo)                 as dias_restantes_menor,
  case
    when bool_or(situacao = 'sem_verba'      and ativo) then 'sem_verba'
    when bool_or(situacao = 'critico'        and ativo) then 'critico'
    when bool_or(situacao = 'atencao'        and ativo) then 'atencao'
    when bool_or(situacao = 'sem_veiculacao' and ativo) then 'sem_veiculacao'
    when bool_or(situacao = 'ok'             and ativo) then 'ok'
    when bool_or(situacao = 'sem_ledger'     and ativo) then 'sem_ledger'
    else 'inativo'
  end as situacao_pior
from public.inv_account_status
group by client_id, cliente, cliente_slug, gestor;

revoke all on public.inv_account_status, public.inv_client_overview,
              public.inv_campanhas, public.inv_campanhas_resumo
  from anon, authenticated;

grant select on public.inv_account_status, public.inv_client_overview,
                public.inv_campanhas, public.inv_campanhas_resumo
  to anon, authenticated;
