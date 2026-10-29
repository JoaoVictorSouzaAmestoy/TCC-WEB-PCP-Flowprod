// src/routes/mrp.js — MRP (necessidades por produto/mês)
// O cálculo é automático (PMP aprovado → BOM → estoque; ver src/mrp.js).
// Aqui: leitura para todos e recálculo manual (MRP, ADMIN) como atalho de conferência.
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { autenticar, autorizarFuncao } = require('../middlewares/auth');
const { reconstruirMrp } = require('../mrp');
const {
  HttpErro, responderErro, transacao, normalizarPeriodo, notificarFuncoes, rotuloPeriodo,
} = require('../fluxo');

// ── GET /api/mrp?periodo=YYYY-MM ──
router.get('/', autenticar, async (req, res) => {
  try {
    const periodo = normalizarPeriodo(req.query.periodo);
    if (!periodo) throw new HttpErro(400, 'Informe o período (YYYY-MM).');

    const r = await db.query(
      `SELECT m.id, m.produto_id, pr.nome AS produto, pr.unidade_padrao, m.tipo,
              m.necessidade_bruta::float8   AS necessidade_bruta,
              m.estoque_considerado::float8 AS estoque_considerado,
              m.necessidade_liquida::float8 AS necessidade_liquida,
              m.atualizado_em,
              COALESCE((SELECT SUM(c.quantidade)::float8 FROM compra_producao c
                         WHERE c.produto_id = m.produto_id AND c.periodo_inicio = m.periodo_inicio
                           AND c.tipo = m.tipo AND c.status IN ('APROVADA','EM_ANDAMENTO','CONCLUIDA')), 0) AS em_ordens
         FROM mrp m JOIN produtos pr ON pr.id = m.produto_id
        WHERE m.periodo_inicio = $1 AND (m.necessidade_bruta > 0 OR m.necessidade_liquida > 0)
        ORDER BY m.tipo DESC, pr.nome`, [periodo]);

    // De onde vem a necessidade de cada matéria-prima (acabado × BOM)
    const origens = await db.query(
      `SELECT b.componente_id, pai.nome AS produto_pai, t.total::float8 AS qtd_pmp,
              b.quantidade_por_unidade::float8 AS por_unidade,
              (t.total * b.quantidade_por_unidade)::float8 AS contribuicao
         FROM (SELECT produto_id, SUM(quantidade) AS total FROM pmp
                WHERE periodo_inicio = $1 AND status = 'APROVADO' GROUP BY produto_id) t
         JOIN bom b ON b.produto_pai_id = t.produto_id
         JOIN produtos pai ON pai.id = t.produto_id
        ORDER BY pai.nome`, [periodo]);
    const porComp = new Map();
    for (const o of origens.rows) {
      if (!porComp.has(o.componente_id)) porComp.set(o.componente_id, []);
      porComp.get(o.componente_id).push(o);
    }
    const mrp = r.rows.map(row => ({ ...row, origens: porComp.get(row.produto_id) || [] }));
    return res.json({ mrp });
  } catch (e) { return responderErro(res, e, 'listar MRP'); }
});

// ── POST /api/mrp/recalcular — força o recálculo de um mês ──
router.post('/recalcular', autenticar, autorizarFuncao('MRP', 'ADMIN'), async (req, res) => {
  try {
    const periodo = normalizarPeriodo(req.body.periodo);
    if (!periodo) throw new HttpErro(400, 'Informe o período (YYYY-MM).');
    const resultado = await transacao((client) => reconstruirMrp(client, periodo));
    if (resultado.criadas || resultado.atualizadas) {
      await notificarFuncoes(['COMPRA_PRODUCAO'], 'mrp_sugestao',
        '🏭 Sugestões de compra/produção atualizadas',
        `${resultado.criadas} nova(s) e ${resultado.atualizadas} atualizada(s) para ${rotuloPeriodo(periodo)}.`, req.usuario.id);
    }
    return res.json({ mensagem: 'MRP recalculado.', ...resultado });
  } catch (e) { return responderErro(res, e, 'recalcular MRP'); }
});

module.exports = router;
