// src/estoque.js — Movimentação de saldo (usada pela rota de estoque e pela
// conclusão de ordens de Compra/Produção). Sempre dentro de uma transação.
const { HttpErro, round2 } = require('./fluxo');

/**
 * Aplica uma movimentação e registra o histórico.
 *  ENTRADA / SAIDA → quantidade (> 0) é o tamanho da movimentação
 *  AJUSTE          → quantidade (>= 0) é o NOVO saldo
 * @param {import('pg').PoolClient} client
 */
async function aplicarMovimentacao(client, { produto_id, tipo, quantidade, motivo = null, origem = 'MANUAL', usuario_id = null }) {
  await client.query(
    `INSERT INTO estoque (produto_id) VALUES ($1) ON CONFLICT (produto_id) DO NOTHING`,
    [produto_id]
  );
  const r = await client.query(
    `SELECT quantidade_atual::float8 AS saldo FROM estoque WHERE produto_id = $1 FOR UPDATE`,
    [produto_id]
  );
  const anterior = r.rows[0].saldo;

  let delta;
  if (tipo === 'ENTRADA')      delta = quantidade;
  else if (tipo === 'SAIDA')   delta = -quantidade;
  else if (tipo === 'AJUSTE')  delta = round2(quantidade - anterior);
  else throw new HttpErro(400, 'Tipo de movimentação inválido.');

  delta = round2(delta);
  if (delta === 0) throw new HttpErro(400, 'A movimentação não altera o saldo.');

  const novo = round2(anterior + delta);
  if (novo < 0) throw new HttpErro(409, `Saldo insuficiente: disponível ${anterior}.`);

  await client.query(
    `UPDATE estoque SET quantidade_atual = $2, atualizado_em = NOW() WHERE produto_id = $1`,
    [produto_id, novo]
  );
  await client.query(
    `INSERT INTO estoque_movimentacoes (produto_id, tipo, delta, saldo_apos, motivo, origem, usuario_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [produto_id, tipo, delta, novo, motivo, origem, usuario_id]
  );
  return { saldo_anterior: anterior, saldo_atual: novo, delta };
}

module.exports = { aplicarMovimentacao };
