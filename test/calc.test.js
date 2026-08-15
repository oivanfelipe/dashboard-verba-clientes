import test from 'node:test';
import assert from 'node:assert/strict';

import { classificacaoSaldoDe } from '../assets/calc.js';

test('prioriza abastecer agora quando saldo confirmado dá até dois dias de autonomia', () => {
  assert.equal(classificacaoSaldoDe({
    balanceSource: 'ledger', temAporte: true, saldo: 200, burn: 100, diasRestantes: 2,
  }), 'abastecer_agora');
});

test('prioriza abastecer agora para saldo confirmado zerado com queima ativa', () => {
  assert.equal(classificacaoSaldoDe({
    balanceSource: 'api', saldo: 0, burn: 100, diasRestantes: null,
  }), 'abastecer_agora');
});

test('indica programar aporte entre três e sete dias de autonomia confirmada', () => {
  assert.equal(classificacaoSaldoDe({
    balanceSource: 'ledger', temAporte: true, saldo: 700, burn: 100, diasRestantes: 7,
  }), 'programar_aporte');
});

test('indica saldo controlado quando o saldo confirmado não está em faixa de aporte', () => {
  assert.equal(classificacaoSaldoDe({
    balanceSource: 'api', saldo: 1000, burn: 100, diasRestantes: 10,
  }), 'saldo_controlado');
});

test('não infere saldo a partir de gasto ou de sinal operacional', () => {
  assert.equal(classificacaoSaldoDe({
    balanceSource: 'ledger', temAporte: false, saldo: 0, burn: 100, diasRestantes: null,
  }), 'saldo_nao_informado');
});
