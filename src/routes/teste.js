// src/routes/teste.js — Endpoint de teste das notificações SSE
// (mantido do antigo dados.js; usado em TESTE_PRATICO_SSE.md)
const express = require('express');
const router  = express.Router();
const { autenticar } = require('../middlewares/auth');
const { notificar } = require('../notificar');

// POST /api/test/notificacao — envia uma notificação de teste para o próprio usuário
router.post('/notificacao', autenticar, async (req, res) => {
  const { titulo, mensagem, tipo } = req.body;
  if (!titulo) return res.status(400).json({ erro: 'Informe o título.' });

  await notificar(req.usuario.id, tipo || 'teste', titulo, mensagem || 'Esta é uma notificação de teste');

  res.json({
    mensagem: 'Notificação de teste enviada!',
    enviada_para: req.usuario.nome,
    usuario_id: req.usuario.id,
  });
});

module.exports = router;
