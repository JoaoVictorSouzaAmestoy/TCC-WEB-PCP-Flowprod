// src/routes/demanda.js — Leitura da demanda consolidada
// Escrita não é manual: a tabela é reconstruída em src/demanda.js sempre
// que o status de um pedido muda (ver pedidos.js). Aqui só existe leitura.
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { autenticar } = require('../middlewares/auth');

// ── GET /api/demanda — lista consolidada por produto/mês ──
// Qualquer função autenticada pode ver (é insumo pro Forecast, PAP etc.)
router.get('/', autenticar, async (req, res) => {
  const { produto_id } = req.query;
  try {
    let query = `
      SELECT d.id, d.produto_id, pr.nome AS produto, pr.unidade_padrao,
             d.periodo_inicio, d.quantidade, d.origem, d.atualizado_em
      FROM demanda d
      JOIN produtos pr ON pr.id = d.produto_id`;
    const params = [];
    if (produto_id) {
      params.push(produto_id);
      query += ` WHERE d.produto_id = $${params.length}`;
    }
    query += ` ORDER BY d.periodo_inicio DESC, pr.nome`;

    const r = await db.query(query, params);
    return res.json({ demanda: r.rows });
  } catch (erro) {
    console.error('Erro ao listar demanda:', erro.message);
    return res.status(500).json({ erro: 'Erro interno.' });
  }
});

module.exports = router;
