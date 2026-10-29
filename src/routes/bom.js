// src/routes/bom.js — Estrutura de produto (BOM): acabado (pai) → matéria-prima (componente)
// Leitura: qualquer função logada. Escrita: ESTOQUE, ADMIN.
// Qualquer mudança recalcula o MRP automaticamente.
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { autenticar, autorizarFuncao } = require('../middlewares/auth');
const { reconstruirMrpTodos } = require('../mrp');
const { HttpErro, responderErro, transacao, numero } = require('../fluxo');

const podeEscrever = [autenticar, autorizarFuncao('ESTOQUE', 'ADMIN')];

// ── GET /api/bom — todas as linhas (o front agrupa por produto pai) ──
router.get('/', autenticar, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT b.id, b.produto_pai_id, pai.nome AS produto_pai,
              b.componente_id, comp.nome AS componente, comp.unidade_padrao AS unidade_componente,
              b.quantidade_por_unidade::float8 AS quantidade_por_unidade
         FROM bom b
         JOIN produtos pai  ON pai.id  = b.produto_pai_id
         JOIN produtos comp ON comp.id = b.componente_id
        ORDER BY pai.nome, comp.nome`);
    return res.json({ bom: r.rows });
  } catch (e) { return responderErro(res, e, 'listar BOM'); }
});

// ── POST /api/bom — adiciona componente a um acabado ──
router.post('/', ...podeEscrever, async (req, res) => {
  try {
    const paiId  = parseInt(req.body.produto_pai_id);
    const compId = parseInt(req.body.componente_id);
    const qtd    = numero(req.body.quantidade_por_unidade, { estrito: true });
    if (!paiId || !compId) throw new HttpErro(400, 'Informe o produto e o componente.');
    if (qtd === null) throw new HttpErro(400, 'Quantidade por unidade deve ser maior que zero.');

    await transacao(async (client) => {
      const r = await client.query(`SELECT id, tipo, ativo FROM produtos WHERE id = ANY($1::int[])`, [[paiId, compId]]);
      const pai  = r.rows.find(p => p.id === paiId);
      const comp = r.rows.find(p => p.id === compId);
      if (!pai || pai.tipo !== 'ACABADO' || !pai.ativo) throw new HttpErro(400, 'O produto pai deve ser um acabado ativo.');
      if (!comp || comp.tipo !== 'MATERIA_PRIMA' || !comp.ativo) throw new HttpErro(400, 'O componente deve ser uma matéria-prima ativa.');
      const dup = await client.query(`SELECT 1 FROM bom WHERE produto_pai_id = $1 AND componente_id = $2`, [paiId, compId]);
      if (dup.rows.length) throw new HttpErro(409, 'Este componente já está no BOM deste produto.');
      await client.query(
        `INSERT INTO bom (produto_pai_id, componente_id, quantidade_por_unidade) VALUES ($1, $2, $3)`,
        [paiId, compId, qtd]);
      await reconstruirMrpTodos(client);
    });
    return res.status(201).json({ mensagem: 'Componente adicionado.' });
  } catch (e) { return responderErro(res, e, 'adicionar ao BOM'); }
});

// ── PATCH /api/bom/:id — altera a quantidade por unidade ──
router.patch('/:id', ...podeEscrever, async (req, res) => {
  try {
    const qtd = numero(req.body.quantidade_por_unidade, { estrito: true });
    if (qtd === null) throw new HttpErro(400, 'Quantidade por unidade deve ser maior que zero.');
    await transacao(async (client) => {
      const r = await client.query(`UPDATE bom SET quantidade_por_unidade = $2 WHERE id = $1 RETURNING id`, [req.params.id, qtd]);
      if (!r.rows.length) throw new HttpErro(404, 'Linha do BOM não encontrada.');
      await reconstruirMrpTodos(client);
    });
    return res.json({ mensagem: 'BOM atualizado.' });
  } catch (e) { return responderErro(res, e, 'editar BOM'); }
});

// ── DELETE /api/bom/:id ──
router.delete('/:id', ...podeEscrever, async (req, res) => {
  try {
    await transacao(async (client) => {
      const r = await client.query(`DELETE FROM bom WHERE id = $1 RETURNING id`, [req.params.id]);
      if (!r.rows.length) throw new HttpErro(404, 'Linha do BOM não encontrada.');
      await reconstruirMrpTodos(client);
    });
    return res.json({ mensagem: 'Componente removido.' });
  } catch (e) { return responderErro(res, e, 'remover do BOM'); }
});

module.exports = router;
