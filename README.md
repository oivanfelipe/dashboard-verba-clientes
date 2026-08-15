# Verba por cliente — Meta Ads + Google Ads

Acompanhamento de investimento por cliente. A primeira pergunta da Carteira é:
**qual conta tem saldo confirmado e quando ela precisa de aporte?**

Quatro visões:

| Aba | Responde | Vem de |
|---|---|---|
| **Carteira** | qual conta tem saldo confirmado e quando precisa de aporte | saldo, queima projetada e dias restantes; risco operacional aparece separadamente |
| **Por cliente** | como está esse cliente específico, saldo e última recarga | idem, recortado por cliente |
| **Investimentos** | onde o dinheiro está sendo aplicado, campanha a campanha | direto da plataforma de anúncio, via Windsor |
| **Histórico** | quanto foi investido mês a mês, e o que rendeu | o acumulado que o banco guarda desde o primeiro sync |

A aba Investimentos abre pela navegação (carteira inteira) ou pelo botão
**Ver investimento completo** dentro de cada cliente, que a abre já filtrada nele.

### Status operacional — um status por conta, não três colunas para cruzar

A primeira versão deste dashboard tinha "situação" (baseada em ledger, quase sempre
vazio), "sinal de entrega" (inferência) e "campanhas ativas" como colunas separadas.
Para responder "essa conta vai parar?" era preciso cruzar as três mentalmente. Isso
foi revisado: hoje existe **um status por conta** (`assets/calc.js:statusOperacionalDe`),
calculado nesta ordem — fato antes de inferência:

| Status | Como é decidido | É fato ou inferência? |
|---|---|---|
| **Inativa** | conta marcada `ativo = false` no cadastro | cadastro |
| **Sem campanha configurada** | nenhuma campanha apareceu no relatório ainda | fato |
| **Sem dado recente** | o Windsor não traz linha nova há 3+ dias | fato |
| **Parada** | tem campanha cadastrada, nenhuma ativa no último dia com dado | fato |
| **Provável sem saldo** | entrega travou (< 25% do orçamento) 2+ dos últimos 3 dias | inferência |
| **Saldo apertado** | entrega travou 3+ dos últimos 7 dias, sem ser recente | inferência |
| **Parte das campanhas pausada** | só algumas campanhas da conta estão ativas | fato |
| **Investindo normal** | nenhuma das anteriores | — |

A Carteira classifica cada conta ativa por saldo confirmado, nesta ordem:
**Abastecer agora** (até 2 dias de autonomia), **Programar aporte** (3 a 7 dias),
**Saldo controlado** (saldo conhecido fora dessas faixas) e **Saldo não informado**
(não há fonte confiável). O cálculo usa `saldo`, `burn_projecao` e
`dias_restantes`; gasto acumulado não é tratado como saldo.

“Provável sem saldo” e “Saldo apertado” continuam na Carteira como **riscos
operacionais inferidos pela entrega**, separados da classificação de saldo. Eles não
confirmam saldo zerado: também podem indicar anúncio reprovado, público esgotado ou
pausa manual.

### Filtro de período

A coluna "Investido" na Carteira e o KPI correspondente respondem a um seletor —
7 dias, 30 dias, mês atual, mês anterior. Calculado no front a partir da série diária
já carregada (`inv_spend_series`), sem ida extra ao banco.

### Financeiro por cliente

Cada cartão de conta na aba Por cliente mostra saldo (quando há ledger), total
aportado e a **última recarga** (data + valor), vinda de `inv_ultimo_aporte`. Fica
pronto para quando os aportes forem lançados — hoje aparece "nenhuma ainda".

### Histórico e métricas

O banco nunca apaga o que entrou: cada sync faz upsert sobre a janela recente e
o acumulado cresce. `inv_historico_mensal` e `inv_historico_carteira` leem esse
acumulado sem teto de janela.

Guardamos só contadores brutos — impressões, cliques, conversões, valor. CPM,
CPC, CTR, CPA e ROAS saem calculados na leitura, a partir das somas. Média de
médias mente: a soma dos gastos dividida pela soma dos cliques é o CPC real do
período; a média dos CPCs diários não é.

Mês parcial vem marcado (`parcial`) e aparece em cinza no gráfico — tanto o mês
corrente quanto o primeiro da série, que começou no meio do mês.

**Conversões só existem no Google.** O conector do Meta não as expõe por nome
direto, apenas via breakdown de `actions`. A interface mostra "—", nunca zero.

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

A view `inv_account_status` ainda calcula um campo `situacao` ledger-only
(`sem_verba` quando saldo ≤ 0, `crítico` abaixo de 3 dias, `atenção` abaixo de 7,
etc.) — mas ele não aparece mais na interface como status principal. Virou
detalhe interno (ex.: decidir se uma conta com ledger zerado mostra "0 dias" em
vez de esconder atrás da média do cliente). O que o usuário vê é sempre o status
operacional descrito acima.

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
`anon` não lê linha nenhuma delas — só as views agregadas listadas nas migrations. A
chave no `config.js` é a *publishable*, feita para ficar no navegador. Não existe
`service_role` correndo em lugar nenhum: `inv_sync_windsor` roda como função
`security definer` dentro do próprio Postgres, chamada pelo `pg_cron` — não há
Edge Function nem processo externo com credencial elevada.

Para fechar o acesso depois, sem mexer em código: **Vercel → Settings → Deployment
Protection → Password Protection**.
