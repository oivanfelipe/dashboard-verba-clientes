# Verba por cliente — Meta Ads + Google Ads

Acompanhamento de investimento por cliente: **quem tem verba na conta, quem não tem,
quanto tem e por quantos dias ainda dura** no ritmo atual das campanhas.

Duas visões: a carteira inteira e o cliente individual.

---

## Como o dado chega aqui

```
Windsor.ai  ──►  Edge Function sync-windsor  ──►  Supabase (dashboard-v4)  ──►  index.html na Vercel
 (gasto +                (1x/dia)                  (+ ledger de aportes)         (leitura pública
  orçamento)                                                                      das views)
```

### Por que existe o Supabase e o dado não vem direto do Windsor

Três motivos, em ordem de peso:

1. **Saldo não existe em nenhuma API de anúncio.** Meta e Google expõem *quanto foi
   gasto* e *como a campanha está configurada* — não *quanto sobrou na conta*. Saldo é
   dado de billing e fica fora da Insights API que o Windsor lê. Confirmado: os campos
   `balance`, `spend_cap`, `funding_source` e `account_status` não existem na camada de
   relatório. Então o saldo precisa morar em algum lugar, e esse lugar é o banco.
2. **A chave do Windsor não pode ir para o navegador.** O dash é um link público; uma
   chamada direta do front exporia a chave e daria a qualquer visitante acesso a todos
   os dados da conta Windsor.
3. **Dias restantes exige histórico.** Média de gasto dos últimos 7 dias e evolução
   diária precisam de série armazenada. O Windsor é consulta, não memória.

### De onde sai o saldo

`saldo = soma dos aportes − gasto desde ledger_inicio`

O time lança cada aporte em `inv_deposits`; o gasto real vem do Windsor todo dia.
`ledger_inicio` existe para que gasto anterior à adoção do sistema não zere a conta.

Cada conta tem `balance_source`. Hoje todas usam `ledger`. Se alguma fonte passar a
expor saldo de verdade, é só virar aquela conta para `api` — o resto do sistema não muda.

### Como "dias restantes" é calculado

```
queima_projetada = maior( orçamento diário das campanhas ativas , média real dos últimos 7 dias )
dias_restantes   = piso( saldo / queima_projetada )
```

Usar só o orçamento configurado superestima — campanha raramente entrega 100% do
orçamento. Usar só o gasto real subestima logo depois de um aumento de verba, que é
exatamente quando o saldo acaba mais rápido. O maior dos dois faz o alerta chegar antes,
que é o comportamento útil para quem precisa pedir o aporte a tempo.

### Semáforo

| Situação | Regra |
|---|---|
| **Sem verba** | saldo ≤ 0 |
| **Crítico** | menos de 3 dias |
| **Atenção** | menos de 7 dias |
| **Sem veiculação** | tem saldo, nenhuma campanha ativa consumindo |
| **Ok** | 7 dias ou mais |

---

## Estrutura

```
index.html                              página de produção (é o arquivo publicado)
assets/
  config.js                             URL e chave pública do Supabase
  calc.js                               regras de negócio puras (espelha o SQL)
  app.js                                acesso a dados e renderização
  styles.css                            identidade V4, paleta validada em contraste
supabase/
  migrations/0001_inv_schema.sql        schema completo (já aplicado)
  functions/sync-windsor/index.ts       job diário Windsor → Postgres
vercel.json                             headers e cache
```

Sem framework, sem build, sem dependência de runtime. A Vercel serve o diretório
como estático e o front fala com a REST do Supabase por `fetch`.

---

## Rodando

### Ver a interface com dados fictícios

Abra a URL com `?demo=1`. Nenhuma chamada ao banco é feita e uma faixa avisa que os
números são fictícios. Serve para avaliar o layout antes de os dados reais entrarem.

### Local

```bash
python3 -m http.server 8000
# http://localhost:8000/?demo=1
```

---

## O que falta ligar

1. **Chave do Windsor.** Conferir se os campos em `CONECTORES`
   (`supabase/functions/sync-windsor/index.ts`) batem com o que `get_fields` devolve no
   plano contratado — é o único ponto a ajustar. Hoje a conta Windsor está no plano
   Free e só tem GA4 conectado; Meta Ads e Google Ads ainda precisam ser conectados.
2. **Deploy da function** com `WINDSOR_API_KEY` no ambiente, e agendamento diário.
3. **Cadastro.** Popular `inv_clients` e `inv_ad_accounts` com o `external_id` de cada
   conta. Conta que aparece no Windsor sem cadastro é reportada no `inv_sync_log`, nunca
   criada automaticamente — o vínculo conta ↔ cliente é decisão humana.
4. **Lançamento dos aportes** em `inv_deposits`, com `ledger_inicio` na data de virada.

---

## Acesso

O dashboard é um **link público**: qualquer pessoa com a URL vê saldo e investimento de
todos os clientes. Foi uma decisão explícita.

O que protege o resto: as tabelas base estão com RLS ligado e sem policy, então o
`anon` não lê linha nenhuma delas — só as três views agregadas. A chave no
`config.js` é a *publishable*, feita para ficar no navegador. A `service_role` só existe
dentro da Edge Function.

Para fechar o acesso depois, sem mexer em código: **Vercel → Settings → Deployment
Protection → Password Protection**.
