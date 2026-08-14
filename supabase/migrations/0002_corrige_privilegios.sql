-- =============================================================
-- 0002 — Corrige privilégios do anon e expõe status do sync
--
-- O schema public do Supabase concede ALL a anon/authenticated por default
-- privilege. O `grant select` da 0001 somou em cima disso em vez de
-- substituir, deixando INSERT/UPDATE/DELETE abertos nas views.
-- =============================================================

revoke all on public.inv_account_status  from anon, authenticated;
revoke all on public.inv_client_overview from anon, authenticated;
revoke all on public.inv_spend_series    from anon, authenticated;

revoke all on sequence public.inv_sync_log_id_seq from anon, authenticated;

-- Situação da última sincronização, sem expor o log inteiro.
create or replace view public.inv_sync_status as
select
  max(finalizado_em) filter (where status in ('ok','parcial')) as ultimo_sync_ok,
  (select status from public.inv_sync_log order by iniciado_em desc limit 1) as ultimo_status
from public.inv_sync_log;

revoke all on public.inv_sync_status from anon, authenticated;

grant select on public.inv_account_status,
                public.inv_client_overview,
                public.inv_spend_series,
                public.inv_sync_status
  to anon, authenticated;

-- Impede que novos objetos no schema nasçam abertos ao anon.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
