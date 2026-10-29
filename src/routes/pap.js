// src/routes/pap.js — PAP (Plano Agregado de Produção)
//
// Montagem manual a partir dos forecasts APROVADOS do mês; o sistema sugere
// produção = forecast − estoque atual do acabado; o PCP ajusta e aprova.
// Ao aprovar, o PMP (4 semanas) é gerado automaticamente.
// Leitura: qualquer função logada. Escrita: PAP, ADMIN.
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { autenticar, autorizarFuncao } = require('../middlewares/auth');
const { gerarPmp } = require('../pmp');
const {
  HttpErro, responderErro, transacao, normalizarPeriodo, round2, numero,
  notificarFuncoes, rotuloPeriodo,
} = require('../fluxo');

const podeEscrever = [autenticar, autorizarFuncao('PAP', 'ADMIN')];

const SELECT_PAP = `
  SELECT p.id, p.forecast_id, p.produto_id, pr.nome AS produto, pr.unidade_padrao,
         TO_CHAR(p.periodo_inicio, 'YYYY-MM-DD') AS periodo_inicio,
         p.quantidade_forecast::float8  AS quantidade_forecast,
         p.estoque_atual::float8        AS estoque_atual,
         p.quantidade_planejada::float8 AS quantidade_planejada,
         p.status, p.observacoes, p.atualizado_em,
         COALESCE((SELECT d.quantidade::float8 FROM demanda d
                    WHERE d.produto_id = p.produto_id AND d.periodo_inicio = p.periodo_inicio), 0) AS demanda_confirmada,
         COALESCE((SELECT e.quantidade_atual::float8 FROM estoque e WHERE e.produto_id = p.produto_id), 0) AS estoque_agora,
         (SELECT COUNT(*) FROM pmp WHERE pmp.pap_id = p.id AND pmp.status = 'APROVADO')::int AS pmp_aprovado
    FROM pap p
    JOIN produtos pr ON pr.id = p.produto_id`;

// ── GET /api/pap?periodo=YYYY-MM ──
router.get('/', autenticar, async (req, res) => {
  try {
    const params = [];
    let where = '';
    if (req.query.periodo) {
      const periodo = normalizarPeriodo(req.query.periodo);
      if (!periodo) throw new HttpErro(400, 'Período inválido.');
      params.push(periodo);
      where = 'WHERE p.periodo_inicio = $1';
    }
    const r = await db.query(`${SELECT_PAP} ${where} ORDER BY p.periodo_inicio DESC, pr.nome`, params);

    // Forecasts aprovados ainda sem PAP no mês (o que "Montar PAP" vai incluir)
    let disponiveis = 0;
    if (params.length) {
      const d = await db.query(
        `SELECT COUNT(*)::int AS n FROM forecast f
          WHERE f.periodo_inicio = $1 AND f.status = 'APROVADO'
            AND NOT EXISTS (SELECT 1 FROM pap WHERE pap.produto_id = f.produto_id AND pap.periodo_inicio = f.periodo_inicio)`,
        params);
      disponiveis = d.rows[0].n;
    }
    return res.json({ pap: r.rows, forecasts_disponiveis: disponiveis });
  } catch (e) { return responderErro(res, e, 'listar PAP'); }
});

// ── POST /api/pap/montar — cria os PAPs (RASCUNHO) dos forecasts aprovados que ainda não têm ──
router.post('/montar', ...podeEscrever, async (req, res) => {
  try {
    const periodo = normalizarPeriodo(req.body.periodo);
    if (!periodo) throw new HttpErro(400, 'Informe o período (YYYY-MM).');

    const criados = await transacao(async (client) => {
      const fs = await client.query(
        `SELECT f.id, f.produto_id, f.quantidade_prevista::float8 AS prevista,
                COALESCE((SELECT e.quantidade_atual::float8 FROM estoque e WHERE e.produto_id = f.produto_id), 0) AS estoque
           FROM forecast f
          WHERE f.periodo_inicio = $1 AND f.status = 'APROVADO'
            AND NOT EXISTS (SELECT 1 FROM pap WHERE pap.produto_id = f.produto_id AND pap.periodo_inicio = f.periodo_inicio)
          ORDER BY f.id`, [periodo]);
      for (const f of fs.rows) {
        await client.query(
          `INSERT INTO pap (forecast_id, produto_id, periodo_inicio, quantidade_forecast, estoque_atual, quantidade_planejada, criado_por)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [f.id, f.produto_id, periodo, f.prevista, f.estoque, round2(Math.max(0, f.prevista - f.estoque)), req.usuario.id]);
      }
      return fs.rows.length;
    });
    return res.json({ mensagem: criados ? `${criados} item(ns) incluído(s) no PAP.` : 'Nenhum forecast aprovado novo para este mês.', criados });
  } catch (e) { return responderErro(res, e, 'montar PAP'); }
});

// ── PATCH /api/pap/:id — ajusta quantidade planejada/observações (só RASCUNHO) ──
router.patch('/:id', ...podeEscrever, async (req, res) => {
  try {
    const atual = await db.query(`SELECT status FROM pap WHERE id = $1`, [req.params.id]);
    if (!atual.rows.length) throw new HttpErro(404, 'Item do PAP não encontrado.');
    if (atual.rows[0].status !== 'RASCUNHO') throw new HttpErro(409, 'PAP aprovado não pode ser editado. Reabra-o primeiro.');

    let planejada = null;
    if (req.body.quantidade_planejada !== undefined) {
      planejada = numero(req.body.quantidade_planejada);
      if (planejada === null) throw new HttpErro(400, 'Quantidade planejada inválida.');
    }
    await db.query(
      `UPDATE pap SET quantidade_planejada = COALESCE($2, quantidade_planejada),
              observacoes = COALESCE($3, observacoes), atualizado_em = NOW() WHERE id = $1`,
      [req.params.id, planejada, req.body.observacoes ?? null]);
    return res.json({ mensagem: 'PAP atualizado.' });
  } catch (e) { return responderErro(res, e, 'editar PAP'); }
});

// ── POST /api/pap/:id/aprovar — aprova e gera o PMP automaticamente ──
router.post('/:id/aprovar', ...podeEscrever, async (req, res) => {
  try {
    const pap = await transacao(async (client) => {
      const r = await client.query(
        `SELECT p.id, p.produto_id, p.status, p.quantidade_planejada::float8 AS quantidade_planejada,
                TO_CHAR(p.periodo_inicio, 'YYYY-MM-DD') AS periodo_inicio, pr.nome AS produto
           FROM pap p JOIN produtos pr ON pr.id = p.produto_id
          WHERE p.id = $1 FOR UPDATE OF p`, [req.params.id]);
      if (!r.rows.length) throw new HttpErro(404, 'Item do PAP não encontrado.');
      const p = r.rows[0];
      if (p.status === 'APROVADO') throw new HttpErro(409, 'Este item já está aprovado.');
      await client.query(`UPDATE pap SET status = 'APROVADO', atualizado_em = NOW() WHERE id = $1`, [p.id]);
      await gerarPmp(client, p);
      return p;
    });
    await notificarFuncoes(['PMP'], 'pap_aprovado',
      `📐 PAP aprovado — ${pap.produto}`,
      `Produção de ${pap.quantidade_planejada} un. em ${rotuloPeriodo(pap.periodo_inicio)}. O PMP semanal foi gerado e aguarda ajuste/aprovação.`,
      req.usuario.id);
    return res.json({ mensagem: 'PAP aprovado. PMP gerado.' });
  } catch (e) { return responderErro(res, e, 'aprovar PAP'); }
});

// ── POST /api/pap/:id/reabrir — volta para RASCUNHO (só se o PMP ainda não foi aprovado) ──
router.post('/:id/reabrir', ...podeEscrever, async (req, res) => {
  try {
    await transacao(async (client) => {
      const r = await client.query(`SELECT status FROM pap WHERE id = $1 FOR UPDATE`, [req.params.id]);
      if (!r.rows.length) throw new HttpErro(404, 'Item do PAP não encontrado.');
      if (r.rows[0].status !== 'APROVADO') throw new HttpErro(409, 'Este item não está aprovado.');
      const pmp = await client.query(`SELECT 1 FROM pmp WHERE pap_id = $1 AND status = 'APROVADO' LIMIT 1`, [req.params.id]);
      if (pmp.rows.length) throw new HttpErro(409, 'O PMP deste item já foi aprovado. Reabra o PMP antes.');
      await client.query(`DELETE FROM pmp WHERE pap_id = $1`, [req.params.id]);
      await client.query(`UPDATE pap SET status = 'RASCUNHO', atualizado_em = NOW() WHERE id = $1`, [req.params.id]);
    });
    return res.json({ mensagem: 'PAP reaberto.' });
  } catch (e) { return responderErro(res, e, 'reabrir PAP'); }
});

// ── DELETE /api/pap/:id — remove (só RASCUNHO) ──
router.delete('/:id', ...podeEscrever, async (req, res) => {
  try {
    const r = await db.query(`DELETE FROM pap WHERE id = $1 AND status = 'RASCUNHO' RETURNING id`, [req.params.id]);
    if (!r.rows.length) throw new HttpErro(409, 'Item não encontrado ou já aprovado.');
    return res.json({ mensagem: 'Item removido do PAP.' });
  } catch (e) { return responderErro(res, e, 'remover PAP'); }
});

module.exports = router;
