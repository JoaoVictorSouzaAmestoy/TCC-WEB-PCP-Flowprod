// src/demanda.js — Reconstrução da tabela demanda
//
// Estratégia: reconstrução, não incremento. Sempre que o status de um pedido
// muda (CONFIRMADO, CANCELADO ou volta pra PENDENTE), recalculamos do zero a
// demanda dos produtos daquele pedido — apagando as linhas antigas desses
// produtos e regerando a partir de TODOS os pedidos CONFIRMADO atuais.
// Isso evita erro acumulado de +/- incremental em cancelamentos/edições.
//
// Período: mês da data_desejada do pedido (ou, se não informada, mês em que
// o pedido foi criado). Sempre normalizado pro dia 1 do mês.

/**
 * Recalcula a demanda para uma lista de produto_id, usando uma conexão/
 * transação já aberta (para ser chamada dentro do mesmo client.query do
 * PATCH de status, garantindo atomicidade).
 * @param {import('pg').PoolClient} client
 * @param {number[]} produtoIds
 */
async function reconstruirDemanda(client, produtoIds) {
  const ids = [...new Set(produtoIds)].filter(Boolean);
  if (!ids.length) return;

  await client.query(
    `DELETE FROM demanda WHERE produto_id = ANY($1::int[])`,
    [ids]
  );

  await client.query(
    `INSERT INTO demanda (produto_id, periodo_inicio, quantidade, origem)
     SELECT
       pi.produto_id,
       DATE_TRUNC('month', COALESCE(p.data_desejada, p.criado_em))::date AS periodo_inicio,
       SUM(pi.quantidade) AS quantidade,
       'PEDIDOS'
     FROM pedido_itens pi
     JOIN pedidos p ON p.id = pi.pedido_id
     WHERE p.status = 'CONFIRMADO' AND pi.produto_id = ANY($1::int[])
     GROUP BY pi.produto_id, DATE_TRUNC('month', COALESCE(p.data_desejada, p.criado_em))`,
    [ids]
  );
}

module.exports = { reconstruirDemanda };
