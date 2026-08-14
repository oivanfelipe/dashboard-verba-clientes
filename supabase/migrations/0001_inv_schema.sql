-- =============================================================
-- 0001 — Acompanhamento de verba / investimento por cliente
-- Aplicada no projeto Supabase dashboard-v4 (mzwynanvhojzyoirvxkc).
-- Tudo prefixado inv_ para conviver com as tabelas já existentes.
-- =============================================================

create table if not exists public.inv_clients (
  id          uuid primary key default gen_random_uuid(),
  nome        text not null,
  slug        text not null unique,
  gestor      text,
  ativo       boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.inv_ad_accounts (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references public.inv_clients(id) on delete cascade,
  platform       text not null check (platform in ('meta','google')),
  external_id    text not null,
  nome           text not null,
  currency       text not null default 'BRL',
  -- prepago: cliente deposita e o saldo queima.
  -- pos_pago: cartão, não há saldo; o que importa é o pacing contra a verba mensal.
  billing_model  text not null default 'prepago'
                 check (billing_model in ('prepago','pos_pago')),
  -- ledger: saldo = aportes - gasto. api: saldo vem do sync, se a fonte expuser.
  balance_source text not null default 'ledger'
                 check (balance_source in ('ledger','api')),
  -- Gasto anterior a esta data NÃO desconta do saldo. Evita que o histórico
  -- importado zere a conta no dia em que o ledger começa.
  ledger_inicio  date not null default current_date,
  verba_mensal   numeric(14,2),
  ativo          boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (platform, external_id)
);

create index if not exists inv_ad_accounts_client_idx
  on public.inv_ad_accounts (client_id);

-- Valor positivo = aporte. Negativo = estorno/ajuste.
create table if not exists public.inv_deposits (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references public.inv_ad_accounts(id) on delete cascade,
  data           date not null,
  valor          numeric(14,2) not null check (valor <> 0),
  observacao     text,
  registrado_por text,
  created_at     timestamptz not null default now()
);

create index if not exists inv_deposits_account_idx
  on public.inv_deposits (account_id, data desc);

create table if not exists public.inv_daily_spend (
  account_id  uuid not null references public.inv_ad_accounts(id) on delete cascade,
  data        date not null,
  spend       numeric(14,2) not null default 0,
  synced_at   timestamptz not null default now(),
  primary key (account_id, data)
);

create index if not exists inv_daily_spend_data_idx
  on public.inv_daily_spend (data desc);

-- daily_budget_ativo = soma do orçamento diário das campanhas ligadas.
-- É o "de acordo com as configurações das campanhas" da projeção.
create table if not exists public.inv_budget_snapshots (
  account_id         uuid not null references public.inv_ad_accounts(id) on delete cascade,
  data               date not null,
  daily_budget_ativo numeric(14,2) not null default 0,
  campanhas_ativas   integer not null default 0,
  saldo_api          numeric(14,2),
  synced_at          timestamptz not null default now(),
  primary key (account_id, data)
);

create table if not exists public.inv_sync_log (
  id             bigserial primary key,
  iniciado_em    timestamptz not null default now(),
  finalizado_em  timestamptz,
  status         text not null default 'rodando'
                 check (status in ('rodando','ok','erro','parcial')),
  contas_ok      integer not null default 0,
  contas_erro    integer not null default 0,
  detalhe        text
);

-- =============================================================
-- Visões de leitura
-- =============================================================

create or replace view public.inv_account_status as
with snap as (
  select distinct on (account_id)
         account_id, data as snapshot_data,
         daily_budget_ativo, campanhas_ativas, saldo_api
  from public.inv_budget_snapshots
  order by account_id, data desc
),
aportes as (
  select account_id, sum(valor) as total from public.inv_deposits group by account_id
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
    sn.snapshot_data,
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
    -- Ritmo da projeção: o maior entre o orçamento configurado e a média real
    -- de 7 dias. Configurado sozinho superestima (campanha raramente gasta
    -- 100% do orçamento); real sozinho subestima logo após um aumento de verba,
    -- que é justamente quando o saldo acaba mais rápido. O maior alerta antes.
    round(greatest(burn_configurado, burn_real_7d), 2) as burn_projecao
  from base
)
select calc.*,
  case when burn_projecao > 0 and saldo > 0
       then floor(saldo / burn_projecao)::int else null end as dias_restantes,
  case
    when not ativo                                then 'inativo'
    when balance_source = 'api' and saldo is null then 'sem_dado'
    when saldo <= 0                               then 'sem_verba'
    when burn_projecao = 0                        then 'sem_veiculacao'
    when saldo / burn_projecao < 3                then 'critico'
    when saldo / burn_projecao < 7                then 'atencao'
    else 'ok'
  end as situacao,
  case when verba_mensal is not null and verba_mensal > 0
       then round(100 * gasto_mes_atual / verba_mensal, 1) else null end as pct_verba_mensal
from calc;

create or replace view public.inv_client_overview as
select
  client_id, cliente, cliente_slug, gestor,
  count(*) filter (where ativo)                       as contas_ativas,
  round(sum(saldo) filter (where ativo), 2)           as saldo_total,
  round(sum(burn_projecao) filter (where ativo), 2)   as burn_diario_total,
  round(sum(gasto_mes_atual) filter (where ativo), 2) as gasto_mes_total,
  min(dias_restantes) filter (where ativo)            as dias_restantes_menor,
  case
    when bool_or(situacao = 'sem_verba'      and ativo) then 'sem_verba'
    when bool_or(situacao = 'critico'        and ativo) then 'critico'
    when bool_or(situacao = 'atencao'        and ativo) then 'atencao'
    when bool_or(situacao = 'sem_veiculacao' and ativo) then 'sem_veiculacao'
    when bool_or(situacao = 'ok'             and ativo) then 'ok'
    else 'inativo'
  end as situacao_pior
from public.inv_account_status
group by client_id, cliente, cliente_slug, gestor;

create or replace view public.inv_spend_series as
select s.account_id, a.client_id, a.platform, s.data, s.spend
from public.inv_daily_spend s
join public.inv_ad_accounts a on a.id = s.account_id
where s.data >= current_date - 90;

-- =============================================================
-- Acesso
-- O dash é um link público: o anon lê as VIEWS agregadas e nada mais.
-- As tabelas base ficam com RLS ligado e sem policy — só a service_role
-- (usada pelo job de sync) escreve e lê linha a linha.
-- =============================================================

alter table public.inv_clients          enable row level security;
alter table public.inv_ad_accounts      enable row level security;
alter table public.inv_deposits         enable row level security;
alter table public.inv_daily_spend      enable row level security;
alter table public.inv_budget_snapshots enable row level security;
alter table public.inv_sync_log         enable row level security;

revoke all on public.inv_clients,
              public.inv_ad_accounts,
              public.inv_deposits,
              public.inv_daily_spend,
              public.inv_budget_snapshots,
              public.inv_sync_log
  from anon, authenticated;

grant select on public.inv_account_status,
                public.inv_client_overview,
                public.inv_spend_series
  to anon, authenticated;
