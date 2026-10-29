// src/forecast.js — Cálculo da sugestão de forecast
//
// Método: média móvel dos 3 meses imediatamente anteriores ao período, sobre a
// tabela demanda (pedidos CONFIRMADO). A média divide pelo número de meses que
// têm demanda registrada na janela — assim produto novo, com 1 ou 2 meses de
// histórico, não é subestimado. Resultado arredondado para unidade inteira.

/**
 * @param {import('pg').Pool|import('pg').PoolClient} client
 * @param {number} produtoId
 * @param {string} periodo  'YYYY-MM-01'
 * @returns {Promise<{sugestao:number, meses:number}>}
 */
async function calcularSugestao(client, produtoId, periodo) {
  const r = await client.query(
    `SELECT quantidade::float8 AS quantidade
       FROM demanda
      WHERE produto_id = $1
        AND periodo_inicio >= ($2::date - INTERVAL '3 months')
        AND periodo_inicio <  $2::date`,
    [produtoId, periodo]
  );
  if (!r.rows.length) return { sugestao: 0, meses: 0 };
  const soma = r.rows.reduce((acc, row) => acc + row.quantidade, 0);
  return { sugestao: Math.round(soma / r.rows.length), meses: r.rows.length };
}

module.exports = { calcularSugestao };
