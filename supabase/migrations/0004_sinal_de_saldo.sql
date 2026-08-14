-- =============================================================
-- 0004 — Sinal de saldo por entrega
--
-- Nenhuma API de anúncio devolve saldo disponível. Mas conta que para de
-- entregar com campanha ativa e orçamento configurado quase sempre parou
-- por falta de verba. Isto é INFERÊNCIA, não fato — a interface precisa
-- dizer isso, porque a causa também pode ser anúncio reprovado, público
-- esgotado ou pausa manual.
--
-- O dia corrente é excluído: está sempre parcial e apareceria como queda
-- em todas as contas ao mesmo tempo.
--
-- Limitação conhecida: inv_budget_snapshots só tem a foto do dia até o
-- sync diário acumular histórico. Até lá o orçamento mais recente serve de
-- referência para os dias anteriores, o que distorce a leitura de qualquer
-- conta que mudou de orçamento no período.
-- =============================================================

create or replace view public.inv_sinal_saldo as
with orc as (
  select distinct on (account_id) account_id, daily_budget_ativo
  from public.inv_budget_snapshots
  where daily_budget_ativo > 0
  order by account_id, data desc
),
dias as (
  select o.account_id, o.daily_budget_ativo, d.data,
         coalesce(ds.spend, 0) as spend,
         coalesce(ds.spend, 0) / o.daily_budget_ativo as entrega
  from orc o
  cross join lateral (
    select generate_series(current_date - 7, current_date - 1, '1 day')::date as data
  ) d
  left join public.inv_daily_spend ds
    on ds.account_id = o.account_id and ds.data = d.data
),
janela as (
  select account_id, daily_budget_ativo,
    count(*) filter (where entrega < 0.25)                              as dias_travados,
    count(*) filter (where entrega < 0.25 and data >= current_date - 3) as travados_recentes,
    round(avg(entrega) * 100)                                           as entrega_media_pct,
    max(data) filter (where entrega < 0.25)                             as ultimo_dia_travado
  from dias
  group by account_id, daily_budget_ativo
)
select
  j.account_id, a.client_id, c.nome as cliente, a.platform, a.nome as conta,
  round(j.daily_budget_ativo, 2) as orcamento_dia,
  j.dias_travados, j.travados_recentes, j.entrega_media_pct, j.ultimo_dia_travado,
  case
    -- Parada recente e persistente: secou e ainda não foi recarregada.
    when j.travados_recentes >= 2 then 'provavel_sem_saldo'
    -- Quedas intermitentes: entrega até acabar, recarrega, repete.
    when j.dias_travados     >= 3 then 'saldo_apertado'
    when j.dias_travados     >= 1 then 'oscilando'
    else 'entregando'
  end as sinal
from janela j
join public.inv_ad_accounts a on a.id = j.account_id
join public.inv_clients     c on c.id = a.client_id;

revoke all on public.inv_sinal_saldo from anon, authenticated;
grant select on public.inv_sinal_saldo to anon, authenticated;
