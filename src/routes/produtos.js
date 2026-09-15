// src/routes/produtos.js — Cadastro mestre de produtos
//
// Permissões (definidas no TCC):
//   ESTOQUE, ADMIN  → cria e edita
//   demais 5 módulos → só leitura (GET /)
//   cliente          → só o catálogo de vendáveis (GET /catalogo),
//                       nunca vê matéria-prima
const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const db      = require('../db');
const { autenticar, autorizarFuncao } = require('../middlewares/auth');

// ── Middleware: exige cliente autenticado (mesmo padrão de pedidos.js) ──
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

// ── GET /api/produtos — lista completa (uso interno, qualquer função logada) ──
router.get('/', autenticar, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, nome, tipo, unidade_padrao, ativo, criado_em, atualizado_em
       FROM produtos ORDER BY nome`
    );
    return res.json({ produtos: r.rows });
  } catch (erro) {
    console.error('Erro ao listar produtos:', erro.message);
    return res.status(500).json({ erro: 'Erro interno.' });
  }
});

// ── GET /api/produtos/catalogo — só o que o cliente pode pedir ──
// Nunca inclui MATERIA_PRIMA, nem produto inativo.
router.get('/catalogo', autenticarCliente, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, nome, unidade_padrao
       FROM produtos
       WHERE tipo = 'ACABADO' AND ativo = true
       ORDER BY nome`
    );
    return res.json({ produtos: r.rows });
  } catch (erro) {
    console.error('Erro ao listar catálogo:', erro.message);
    return res.status(500).json({ erro: 'Erro interno.' });
  }
});

// ── POST /api/produtos — cria produto (Estoque/Admin) ──
router.post('/', autenticar, autorizarFuncao('ESTOQUE', 'ADMIN'), async (req, res) => {
  const { nome, tipo, unidade_padrao } = req.body;
  if (!nome || !String(nome).trim()) {
    return res.status(400).json({ erro: 'Nome do produto é obrigatório.' });
  }
  if (!['ACABADO', 'MATERIA_PRIMA'].includes(tipo)) {
    return res.status(400).json({ erro: 'Tipo deve ser ACABADO ou MATERIA_PRIMA.' });
  }
  if (!unidade_padrao || !String(unidade_padrao).trim()) {
    return res.status(400).json({ erro: 'Unidade padrão é obrigatória.' });
  }
  try {
    const r = await db.query(
      `INSERT INTO produtos (nome, tipo, unidade_padrao)
       VALUES ($1, $2, $3) RETURNING id, nome, tipo, unidade_padrao, ativo, criado_em`,
      [nome.trim(), tipo, unidade_padrao.trim()]
    );
    return res.json({ mensagem: 'Produto cadastrado.', produto: r.rows[0] });
  } catch (erro) {
    if (erro.code === '23505') {
      return res.status(409).json({ erro: 'Já existe um produto com esse nome.' });
    }
    console.error('Erro ao criar produto:', erro.message);
    return res.status(500).json({ erro: 'Erro interno.' });
  }
});

// ── PATCH /api/produtos/:id — edita produto, incluindo ativar/desativar (Estoque/Admin) ──
router.patch('/:id', autenticar, autorizarFuncao('ESTOQUE', 'ADMIN'), async (req, res) => {
  const { nome, tipo, unidade_padrao, ativo } = req.body;
  if (tipo !== undefined && !['ACABADO', 'MATERIA_PRIMA'].includes(tipo)) {
    return res.status(400).json({ erro: 'Tipo deve ser ACABADO ou MATERIA_PRIMA.' });
  }
  try {
    const r = await db.query(
      `UPDATE produtos SET
         nome           = COALESCE($1, nome),
         tipo           = COALESCE($2, tipo),
         unidade_padrao = COALESCE($3, unidade_padrao),
         ativo          = COALESCE($4, ativo),
         atualizado_em  = NOW()
       WHERE id = $5
       RETURNING id, nome, tipo, unidade_padrao, ativo, atualizado_em`,
      [nome ?? null, tipo ?? null, unidade_padrao ?? null, ativo ?? null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ erro: 'Produto não encontrado.' });
    return res.json({ mensagem: 'Produto atualizado.', produto: r.rows[0] });
  } catch (erro) {
    if (erro.code === '23505') {
      return res.status(409).json({ erro: 'Já existe um produto com esse nome.' });
    }
    console.error('Erro ao atualizar produto:', erro.message);
    return res.status(500).json({ erro: 'Erro interno.' });
  }
});

module.exports = router;
