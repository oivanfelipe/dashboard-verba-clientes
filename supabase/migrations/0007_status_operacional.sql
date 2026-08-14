-- =============================================================
-- 0007 — Status operacional por conta e último aporte
--
-- Motivação: o dashboard tinha três sinais concorrentes por conta —
-- "situação" (ledger, quase sempre vazio), "sinal de entrega"
-- (inferência) e "campanhas ativas" — em colunas separadas que exigiam
-- cruzar mentalmente para responder "essa conta vai parar?". Esta
-- migration não muda o que já existe; adiciona a base para o front unificar
-- os três num status único por conta (ver assets/calc.js:statusOperacionalDe).
--
-- Limitação a documentar: campanhas_total conta só o que apareceu no
-- relatório do Windsor no período consultado. Campanha pausada há muito
-- tempo, sem gasto recente, pode nunca aparecer — então campanhas_total
-- tende a subestimar o total real da conta, nunca a superestimar. É
-- suficiente para decidir "está rodando ou não", que é a pergunta que
-- interessa aqui.
-- =============================================================

create or replace view public.inv_status_campanhas as
with ultimo_dia as (
  select account_id, max(data) as data from public.inv_campaign_daily group by account_id
)
select
  cd.account_id,
  u.data as ultimo_dado,
  (current_date - u.data) as dias_sem_dado_novo,
  count(*) as campanhas_total,
  count(*) filter (where upper(cd.status) in ('ACTIVE','ENABLED')) as campanhas_ativas_hoje
from public.inv_campaign_daily cd
join ultimo_dia u on u.account_id = cd.account_id and u.data = cd.data
group by cd.account_id, u.data;

revoke all on public.inv_status_campanhas from anon, authenticated;
grant select on public.inv_status_campanhas to anon, authenticated;

-- ---------- Último aporte por conta ----------
-- Hoje inv_deposits está vazia; a view fica pronta para quando existirem
-- lançamentos. Não expõe observação/registrado_por — só data, valor e total.
create or replace view public.inv_ultimo_aporte as
select
  account_id,
  max(data) as ultima_data,
  (array_agg(valor order by data desc, created_at desc))[1] as ultimo_valor,
  count(*) as qtd_aportes
from public.inv_deposits
group by account_id;

revoke all on public.inv_ultimo_aporte from anon, authenticated;
grant select on public.inv_ultimo_aporte to anon, authenticated;
