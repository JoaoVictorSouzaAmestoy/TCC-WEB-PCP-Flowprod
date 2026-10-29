// src/routes/estoque.js — Saldo de estoque e movimentações
// (o cadastro de produtos continua em /api/produtos)
// Leitura: qualquer função logada. Escrita: ESTOQUE, ADMIN.
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { autenticar, autorizarFuncao } = require('../middlewares/auth');
const { aplicarMovimentacao } = require('../estoque');
const { reconstruirMrpTodos } = require('../mrp');
const { HttpErro, responderErro, transacao, numero, notificarFuncoes } = require('../fluxo');

// ── GET /api/estoque — saldo de todos os produtos ativos (sem movimentação = 0) ──
router.get('/', autenticar, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT pr.id AS produto_id, pr.nome AS produto, pr.tipo, pr.unidade_padrao,
              COALESCE(e.quantidade_atual, 0)::float8 AS saldo, e.atualizado_em
         FROM produtos pr
         LEFT JOIN estoque e ON e.produto_id = pr.id
        WHERE pr.ativo = TRUE
        ORDER BY pr.tipo, pr.nome`);
    return res.json({ estoque: r.rows });
  } catch (e) { return responderErro(res, e, 'listar estoque'); }
});

// ── GET /api/estoque/movimentacoes?produto_id=&limite= ──
router.get('/movimentacoes', autenticar, async (req, res) => {
  try {
    const params = [];
    let where = '';
    if (req.query.produto_id) { params.push(parseInt(req.query.produto_id)); where = 'WHERE m.produto_id = $1'; }
    params.push(Math.min(parseInt(req.query.limite) || 50, 200));
    const r = await db.query(
      `SELECT m.id, m.produto_id, pr.nome AS produto, pr.unidade_padrao, m.tipo,
              m.delta::float8 AS delta, m.saldo_apos::float8 AS saldo_apos,
              m.motivo, m.origem, u.nome AS usuario, m.criado_em
         FROM estoque_movimentacoes m
         JOIN produtos pr ON pr.id = m.produto_id
         LEFT JOIN usuarios u ON u.id = m.usuario_id
         ${where}
        ORDER BY m.id DESC LIMIT $${params.length}`, params);
    return res.json({ movimentacoes: r.rows });
  } catch (e) { return responderErro(res, e, 'listar movimentações'); }
});

// ── POST /api/estoque/movimentar — entrada, saída ou ajuste de saldo ──
router.post('/movimentar', autenticar, autorizarFuncao('ESTOQUE', 'ADMIN'), async (req, res) => {
  try {
    const { produto_id, tipo, motivo } = req.body;
    if (!['ENTRADA', 'SAIDA', 'AJUSTE'].includes(tipo)) throw new HttpErro(400, 'Tipo inválido.');
    const quantidade = numero(req.body.quantidade, { estrito: tipo !== 'AJUSTE' });
    if (quantidade === null) throw new HttpErro(400, tipo === 'AJUSTE' ? 'Informe o novo saldo (>= 0).' : 'Informe uma quantidade maior que zero.');

    const resultado = await transacao(async (client) => {
      const p = await client.query(`SELECT ativo FROM produtos WHERE id = $1`, [parseInt(produto_id)]);
      if (!p.rows.length || !p.rows[0].ativo) throw new HttpErro(400, 'Produto inválido ou inativo.');
      const mov = await aplicarMovimentacao(client, {
        produto_id: parseInt(produto_id), tipo, quantidade, motivo: motivo || null,
        origem: 'MANUAL', usuario_id: req.usuario.id,
      });
      // O saldo mudou: a necessidade líquida do MRP pode mudar
      const mrp = await reconstruirMrpTodos(client);
      return { mov, mrp };
    });
    if (resultado.mrp.criadas || resultado.mrp.atualizadas) {
      await notificarFuncoes(['COMPRA_PRODUCAO'], 'mrp_sugestao',
        '🏭 Sugestões de compra/produção atualizadas',
        'O saldo de estoque mudou e o MRP foi recalculado.', req.usuario.id);
    }
    return res.json({ mensagem: 'Movimentação registrada.', ...resultado.mov });
  } catch (e) { return responderErro(res, e, 'movimentar estoque'); }
});

module.exports = router;
