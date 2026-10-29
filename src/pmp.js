// src/pmp.js — Desagregação do PAP em semanas (PMP)
//
// Semana 1 = dias 1–7, 2 = 8–14, 3 = 15–21, 4 = 22–fim do mês.
// A quantidade planejada é dividida em 4 partes iguais (em centésimos; o resto
// da divisão vai uma unidade por vez para as primeiras semanas).

function distribuirEmSemanas(total) {
  const centavos = Math.round(Number(total) * 100);
  const base = Math.floor(centavos / 4);
  const resto = centavos - base * 4;
  return [0, 1, 2, 3].map(i => (base + (i < resto ? 1 : 0)) / 100);
}

/** Faixa de datas de cada semana do mês ('YYYY-MM-01'). */
function faixasDasSemanas(periodo) {
  const [a, m] = periodo.slice(0, 7).split('-').map(Number);
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
  const f = (d) => `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return [
    { semana: 1, inicio: f(1),  fim: f(7) },
    { semana: 2, inicio: f(8),  fim: f(14) },
    { semana: 3, inicio: f(15), fim: f(21) },
    { semana: 4, inicio: f(22), fim: f(ultimo) },
  ];
}

/** (Re)gera as 4 linhas de PMP em RASCUNHO para um PAP. Roda dentro de transação. */
async function gerarPmp(client, pap) {
  await client.query(`DELETE FROM pmp WHERE pap_id = $1`, [pap.id]);
  const partes = distribuirEmSemanas(pap.quantidade_planejada);
  for (let i = 0; i < 4; i++) {
    await client.query(
      `INSERT INTO pmp (pap_id, produto_id, periodo_inicio, semana, quantidade)
       VALUES ($1, $2, $3, $4, $5)`,
      [pap.id, pap.produto_id, pap.periodo_inicio, i + 1, partes[i]]
    );
  }
}

module.exports = { distribuirEmSemanas, faixasDasSemanas, gerarPmp };
