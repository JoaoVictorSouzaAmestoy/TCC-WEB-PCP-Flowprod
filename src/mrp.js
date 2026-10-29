// src/mrp.js — Explosão de necessidades (MRP) e sincronização das ordens sugeridas
//
// Regras:
//  • Entrada: PMP APROVADO do mês (quantidade a produzir de cada acabado).
//  • Acabado: necessidade bruta = PMP aprovado. O PAP já abateu o estoque do
//    acabado, então a líquida é igual à bruta (não abate de novo).
//  • Matéria-prima: bruta = Σ (PMP do acabado × quantidade_por_unidade do BOM);
//    líquida = max(0, bruta − saldo em estoque).
//  • Sem lead time e sem lote mínimo.
//  • Cada linha do MRP gera/atualiza UMA ordem SUGERIDA em compra_producao
//    (PRODUCAO para acabado, COMPRA para matéria-prima), descontando o que já
//    está comprometido em ordens aprovadas/em andamento. Matéria-prima
//    concluída já está no saldo; produção concluída é descontada explicitamente.
const { round2 } = require('./fluxo');

const ST_COMPROMETIDO = {
  PRODUCAO: ['APROVADA', 'EM_ANDAMENTO', 'CONCLUIDA'],
  COMPRA:   ['APROVADA', 'EM_ANDAMENTO'],
};

/**
 * Recalcula o MRP de um mês e sincroniza as ordens sugeridas.
 * Deve rodar dentro de uma transação (usa advisory lock transacional).
 * @returns {Promise<{criadas:number, atualizadas:number}>}
 */
async function reconstruirMrp(client, periodo) {
  await client.query('SELECT pg_advisory_xact_lock(7001)');

  // 1) Acabados com PMP aprovado no mês
  const pmp = await client.query(
    `SELECT produto_id, SUM(quantidade)::float8 AS total
       FROM pmp
      WHERE periodo_inicio = $1 AND status = 'APROVADO'
      GROUP BY produto_id
     HAVING SUM(quantidade) > 0`,
    [periodo]
  );
  const calc = new Map();
  for (const row of pmp.rows) {
    calc.set(row.produto_id, {
      tipo: 'PRODUCAO', bruta: round2(row.total), estoque: 0, liquida: round2(row.total),
    });
  }

  // 2) Matérias-primas via BOM
  if (pmp.rows.length) {
    const comp = await client.query(
      `SELECT b.componente_id AS produto_id,
              SUM(t.total * b.quantidade_por_unidade)::float8 AS bruta
         FROM (SELECT produto_id, SUM(quantidade) AS total
                 FROM pmp WHERE periodo_inicio = $1 AND status = 'APROVADO'
                GROUP BY produto_id) t
         JOIN bom b ON b.produto_pai_id = t.produto_id
        GROUP BY b.componente_id`,
      [periodo]
    );
    const ids = comp.rows.map(c => c.produto_id);
    const saldos = ids.length
      ? await client.query(
          `SELECT produto_id, quantidade_atual::float8 AS saldo FROM estoque WHERE produto_id = ANY($1::int[])`,
          [ids])
      : { rows: [] };
    const mapaSaldo = new Map(saldos.rows.map(s => [s.produto_id, s.saldo]));
    for (const c of comp.rows) {
      const bruta = round2(c.bruta);
      const saldo = mapaSaldo.get(c.produto_id) || 0;
      calc.set(c.produto_id, {
        tipo: 'COMPRA', bruta, estoque: saldo, liquida: round2(Math.max(0, bruta - saldo)),
      });
    }
  }

  // 3) Grava (upsert) as linhas calculadas
  for (const [produtoId, v] of calc) {
    await client.query(
      `INSERT INTO mrp (periodo_inicio, produto_id, tipo, necessidade_bruta, estoque_considerado, necessidade_liquida)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (periodo_inicio, produto_id) DO UPDATE SET
         tipo = EXCLUDED.tipo,
         necessidade_bruta = EXCLUDED.necessidade_bruta,
         estoque_considerado = EXCLUDED.estoque_considerado,
         necessidade_liquida = EXCLUDED.necessidade_liquida,
         atualizado_em = NOW()`,
      [periodo, produtoId, v.tipo, v.bruta, v.estoque, v.liquida]
    );
  }

  // 4) Linhas que deixaram de ser necessárias: apaga, ou zera se já têm ordens
  const ids = [...calc.keys()];
  const obsoletas = await client.query(
    `SELECT id, produto_id, tipo FROM mrp WHERE periodo_inicio = $1 AND produto_id <> ALL($2::int[])`,
    [periodo, ids]
  );
  for (const o of obsoletas.rows) {
    const tem = await client.query(
      `SELECT 1 FROM compra_producao WHERE produto_id = $1 AND periodo_inicio = $2 AND tipo = $3 LIMIT 1`,
      [o.produto_id, periodo, o.tipo]
    );
    if (tem.rows.length) {
      await client.query(
        `UPDATE mrp SET necessidade_bruta = 0, necessidade_liquida = 0, atualizado_em = NOW() WHERE id = $1`,
        [o.id]
      );
    } else {
      await client.query(`DELETE FROM mrp WHERE id = $1`, [o.id]);
    }
  }

  // 5) Sincroniza as ordens sugeridas
  let criadas = 0, atualizadas = 0;
  const linhas = await client.query(
    `SELECT id, produto_id, tipo, necessidade_liquida::float8 AS liquida
       FROM mrp WHERE periodo_inicio = $1`,
    [periodo]
  );
  for (const l of linhas.rows) {
    const comprom = await client.query(
      `SELECT COALESCE(SUM(quantidade), 0)::float8 AS q FROM compra_producao
        WHERE produto_id = $1 AND periodo_inicio = $2 AND tipo = $3 AND status = ANY($4::text[])`,
      [l.produto_id, periodo, l.tipo, ST_COMPROMETIDO[l.tipo]]
    );
    const pendente = round2(Math.max(0, l.liquida - comprom.rows[0].q));

    const sug = await client.query(
      `SELECT id, quantidade::float8 AS quantidade FROM compra_producao
        WHERE produto_id = $1 AND periodo_inicio = $2 AND tipo = $3 AND status = 'SUGERIDA'
        ORDER BY id`,
      [l.produto_id, periodo, l.tipo]
    );
    // Garante no máximo uma sugestão aberta por produto/mês
    for (const extra of sug.rows.slice(1)) {
      await client.query(`DELETE FROM compra_producao WHERE id = $1`, [extra.id]);
    }
    const atual = sug.rows[0];

    if (pendente > 0) {
      if (atual) {
        if (atual.quantidade !== pendente) {
          await client.query(
            `UPDATE compra_producao SET quantidade = $2, origem_mrp_id = $3, atualizado_em = NOW() WHERE id = $1`,
            [atual.id, pendente, l.id]
          );
          atualizadas++;
        }
      } else {
        // Se o responsável já recusou exatamente esta quantidade, não sugere de novo
        const recusada = await client.query(
          `SELECT 1 FROM compra_producao
            WHERE produto_id = $1 AND periodo_inicio = $2 AND tipo = $3
              AND status = 'CANCELADA' AND descartada = TRUE AND quantidade = $4 LIMIT 1`,
          [l.produto_id, periodo, l.tipo, pendente]
        );
        if (!recusada.rows.length) {
          await client.query(
            `INSERT INTO compra_producao (origem_mrp_id, produto_id, periodo_inicio, tipo, quantidade)
             VALUES ($1, $2, $3, $4, $5)`,
            [l.id, l.produto_id, periodo, l.tipo, pendente]
          );
          criadas++;
        }
      }
    } else if (atual) {
      await client.query(`DELETE FROM compra_producao WHERE id = $1`, [atual.id]);
    }
  }
  return { criadas, atualizadas };
}

/** Recalcula todos os meses que têm PMP aprovado ou linhas de MRP (ex.: após mudar estoque ou BOM). */
async function reconstruirMrpTodos(client) {
  const r = await client.query(
    `SELECT TO_CHAR(periodo_inicio, 'YYYY-MM-DD') AS periodo FROM pmp WHERE status = 'APROVADO'
     UNION
     SELECT TO_CHAR(periodo_inicio, 'YYYY-MM-DD') FROM mrp
     ORDER BY 1`
  );
  let criadas = 0, atualizadas = 0;
  for (const row of r.rows) {
    const res = await reconstruirMrp(client, row.periodo);
    criadas += res.criadas; atualizadas += res.atualizadas;
  }
  return { criadas, atualizadas };
}

module.exports = { reconstruirMrp, reconstruirMrpTodos };
