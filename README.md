# Verba por cliente — Meta Ads + Google Ads

Acompanhamento de investimento por cliente: **quem tem verba na conta, quem não tem,
quanto tem e por quantos dias ainda dura** no ritmo atual das campanhas.

Três visões:

| Aba | Responde | Vem de |
|---|---|---|
| **Carteira** | quem precisa de aporte agora | cadastro + ledger de aportes cruzado com gasto real |
| **Por cliente** | como está esse cliente específico | idem, recortado por cliente |
| **Investimentos** | onde o dinheiro está sendo aplicado, campanha a campanha | direto da plataforma de anúncio, via Windsor |

A aba Investimentos abre pela navegação (carteira inteira) ou pelo botão
**Ver investimento completo** dentro de cada cliente, que a abre já filtrada nele.

---

## Como o dado chega aqui

```
Windsor.ai  ──►  inv_sync_windsor()  ──►  Supabase (dashboard-v4)  ──►  index.html na Vercel
 (gasto +        pg_cron, 1x/dia às        (+ ledger de aportes)        (leitura pública
  orçamento)     09:00 UTC / 06:00 BRT                                   das views)
```

O sync roda **dentro do Postgres**, não numa Edge Function: `pg_cron` e a
extensão `http` já resolvem, sem CLI e sem deploy. A chave do Windsor fica no
Vault como `windsor_api_key` e nunca aparece em log.

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
  migrations/                           schema, views e o job de sync
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

## Ligando o sync

A chave do Windsor precisa estar no Vault. Rodar uma vez, com a chave real:

```sql
select vault.create_secret('SUA_CHAVE', 'windsor_api_key', 'Windsor.ai API key');
```

Testar na hora:

```sql
select public.inv_sync_windsor(7);
```

O agendamento (`inv-sync-windsor`, diário às 09:00 UTC) já está criado. O histórico
de execuções fica em `inv_sync_log` — `status`, `contas_ok`, `contas_erro` e o
`detalhe` com o erro de cada conector.

## O que falta

**Lançamento dos aportes** em `inv_deposits`, com `ledger_inicio` na data de virada.
Enquanto não houver aporte, as contas aparecem como *Aporte não lançado* e o saldo
fica em branco — é o estado correto, não um erro. O sinal de entrega já responde
"tem saldo ou não" sem depender disso.

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
