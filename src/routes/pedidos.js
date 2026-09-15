// src/routes/pedidos.js — Pedidos de clientes (cabeçalho + itens)
const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const db      = require('../db');
const { autenticar, autorizarFuncao } = require('../middlewares/auth');
const { evPedidoCriado } = require('../notificar');
const { reconstruirDemanda } = require('../demanda');

// ── Middleware: exige cliente autenticado (cookie token_cliente) ──
function autenticarCliente(req, res, next) {
  const token = req.cookies?.token_cliente;
  if (!token) return res.status(401).json({ erro: 'Não autenticado. Faça login.' });
  try {
    const p = jwt.verify(token, process.env.JWT_SECRET);
    if (p.tipo !== 'CLIENTE') return res.status(403).json({ erro: 'Acesso negado.' });
    req.cliente = p;
    next();
  } catch {
    return res.status(401).json({ erro: 'Token inválido ou expirado.' });
  }
}

// ── POST /api/pedidos — cliente logado cria um pedido (1+ itens) ──
// Itens vêm como { produto_id, quantidade, unidade }. Só aceita produto
// ACABADO e ativo — matéria-prima nunca pode ser pedida por um cliente.
router.post('/', autenticarCliente, async (req, res) => {
  const { data_desejada, observacoes, itens } = req.body;

  if (!Array.isArray(itens) || itens.length === 0) {
    return res.status(400).json({ erro: 'Inclua ao menos um item no pedido.' });
  }
  for (const it of itens) {
    if (!it.produto_id) {
      return res.status(400).json({ erro: 'Todo item precisa de um produto.' });
    }
    if (!it.quantidade || parseInt(it.quantidade) < 1) {
      return res.status(400).json({ erro: 'Quantidade inválida em um dos itens.' });
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Valida que todo produto_id existe, é ACABADO e está ativo
    const produtoIds = itens.map(it => it.produto_id);
    const produtosCheck = await client.query(
      `SELECT id, nome, tipo, ativo FROM produtos WHERE id = ANY($1::int[])`,
      [produtoIds]
    );
    const produtosMap = new Map(produtosCheck.rows.map(p => [p.id, p]));
    for (const it of itens) {
      const p = produtosMap.get(parseInt(it.produto_id));
      if (!p) {
        await client.query('ROLLBACK');
        return res.status(400).json({ erro: 'Produto inválido em um dos itens.' });
      }
      if (p.tipo !== 'ACABADO' || !p.ativo) {
        await client.query('ROLLBACK');
        return res.status(400).json({ erro: `"${p.nome}" não está disponível para pedido.` });
      }
    }

    const pedido = await client.query(
      `INSERT INTO pedidos (cliente_id, data_desejada, observacoes)
       VALUES ($1, $2, $3) RETURNING id, numero, criado_em`,
      [req.cliente.id, data_desejada || null, observacoes || null]
    );
    const { id: pedidoId, numero } = pedido.rows[0];

    for (const it of itens) {
      await client.query(
        `INSERT INTO pedido_itens (pedido_id, produto_id, quantidade, unidade)
         VALUES ($1, $2, $3, $4)`,
        [pedidoId, it.produto_id, parseInt(it.quantidade), it.unidade || null]
      );
    }

    await client.query('COMMIT');

    const resumo = itens
      .map(it => `${it.quantidade}x ${produtosMap.get(parseInt(it.produto_id)).nome}`)
      .join(', ');
    await evPedidoCriado(req.cliente.nome, numero, resumo);

    return res.json({ mensagem: 'Pedido enviado com sucesso!', numero, id: pedidoId });
  } catch (erro) {
    await client.query('ROLLBACK');
    console.error('Erro ao salvar pedido:', erro.message);
    return res.status(500).json({ erro: 'Erro interno ao salvar pedido.' });
  } finally {
    client.release();
  }
});

// ── GET /api/pedidos/meus — histórico do cliente logado ──
router.get('/meus', autenticarCliente, async (req, res) => {
  try {
    const pedidos = await db.query(
      `SELECT id, numero, data_desejada, observacoes, status, criado_em
       FROM pedidos WHERE cliente_id = $1 ORDER BY criado_em DESC`,
      [req.cliente.id]
    );
    const ids = pedidos.rows.map(p => p.id);
    let itensPorPedido = {};
    if (ids.length) {
      const itens = await db.query(
        `SELECT pi.id, pi.pedido_id, pi.produto_id, pr.nome AS produto,
                pi.quantidade, pi.unidade
         FROM pedido_itens pi
         JOIN produtos pr ON pr.id = pi.produto_id
         WHERE pi.pedido_id = ANY($1::int[]) ORDER BY pi.id`,
        [ids]
      );
      itensPorPedido = itens.rows.reduce((acc, it) => {
        (acc[it.pedido_id] ||= []).push(it);
        return acc;
      }, {});
    }
    const resultado = pedidos.rows.map(p => ({ ...p, itens: itensPorPedido[p.id] || [] }));
    return res.json({ pedidos: resultado });
  } catch (erro) {
    console.error('Erro ao listar histórico:', erro.message);
    return res.status(500).json({ erro: 'Erro interno.' });
  }
});

// ── GET /api/pedidos — visão interna (Forecast/Comercial/Admin) ──
router.get('/', autenticar, autorizarFuncao('FORECAST', 'COMERCIAL', 'ADMIN'), async (req, res) => {
  const { status } = req.query;
  try {
    let query = `
      SELECT p.id, p.numero, p.data_desejada, p.observacoes, p.status, p.criado_em,
             c.nome AS cliente_nome, c.empresa AS cliente_empresa
      FROM pedidos p
      JOIN clientes c ON c.id = p.cliente_id`;
    const params = [];
    if (status) { query += ` WHERE p.status = $1`; params.push(status); }
    query += ` ORDER BY p.criado_em DESC`;

    const pedidos = await db.query(query, params);
    const ids = pedidos.rows.map(p => p.id);
    let itensPorPedido = {};
    if (ids.length) {
      const itens = await db.query(
        `SELECT pi.id, pi.pedido_id, pi.produto_id, pr.nome AS produto,
                pi.quantidade, pi.unidade
         FROM pedido_itens pi
         JOIN produtos pr ON pr.id = pi.produto_id
         WHERE pi.pedido_id = ANY($1::int[]) ORDER BY pi.id`,
        [ids]
      );
      itensPorPedido = itens.rows.reduce((acc, it) => {
        (acc[it.pedido_id] ||= []).push(it);
        return acc;
      }, {});
    }
    const resultado = pedidos.rows.map(p => ({ ...p, itens: itensPorPedido[p.id] || [] }));
    return res.json({ pedidos: resultado });
  } catch (erro) {
    console.error('Erro ao listar pedidos:', erro.message);
    return res.status(500).json({ erro: 'Erro interno.' });
  }
});

// ── PATCH /api/pedidos/:id/status — Comercial/PCP/Admin avança o status ──
// PENDENTE → CONFIRMADO → CANCELADO. A cada mudança, reconstrói a demanda
// dos produtos desse pedido (ver src/demanda.js).
router.patch('/:id/status', autenticar, autorizarFuncao('COMERCIAL', 'ADMIN'), async (req, res) => {
  const { status } = req.body;
  const validos = ['PENDENTE', 'CONFIRMADO', 'CANCELADO'];
  if (!validos.includes(status)) {
    return res.status(400).json({ erro: 'Status inválido.' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const r = await client.query(
      `UPDATE pedidos SET status = $1, atualizado_em = NOW()
       WHERE id = $2 RETURNING id, numero, cliente_id, status`,
      [status, req.params.id]
    );
    if (!r.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'Pedido não encontrado.' });
    }

    const itens = await client.query(
      `SELECT produto_id FROM pedido_itens WHERE pedido_id = $1`,
      [req.params.id]
    );
    await reconstruirDemanda(client, itens.rows.map(it => it.produto_id));

    await client.query('COMMIT');
    return res.json({ mensagem: 'Status atualizado.', pedido: r.rows[0] });
  } catch (erro) {
    await client.query('ROLLBACK');
    console.error('Erro ao atualizar status:', erro.message);
    return res.status(500).json({ erro: 'Erro interno.' });
  } finally {
    client.release();
  }
});

module.exports = router;
