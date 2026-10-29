// src/routes/forecast.js — Forecast (previsão de demanda por produto/mês)
//
// Fluxo: PCP dispara o cálculo → sistema sugere a quantidade (média móvel de
// 3 meses sobre a demanda) → PCP ajusta se quiser → aprova (ou pede revisão).
// Leitura: qualquer função logada. Escrita: FORECAST, ADMIN.
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { autenticar, autorizarFuncao } = require('../middlewares/auth');
const { calcularSugestao } = require('../forecast');
const {
  HttpErro, responderErro, transacao, normalizarPeriodo, numero,
  notificarFuncoes, rotuloPeriodo,
} = require('../fluxo');

const podeEscrever = [autenticar, autorizarFuncao('FORECAST', 'ADMIN')];

const SELECT_FORECAST = `
  SELECT f.id, f.produto_id, pr.nome AS produto, pr.unidade_padrao,
         TO_CHAR(f.periodo_inicio, 'YYYY-MM-DD') AS periodo_inicio,
         f.quantidade_sugerida::float8 AS quantidade_sugerida,
         f.quantidade_prevista::float8 AS quantidade_prevista,
         f.status, f.observacoes, f.atualizado_em,
         COALESCE((SELECT d.quantidade::float8 FROM demanda d
                    WHERE d.produto_id = f.produto_id AND d.periodo_inicio = f.periodo_inicio), 0) AS demanda_confirmada,
         EXISTS (SELECT 1 FROM pap WHERE pap.forecast_id = f.id) AS tem_pap
    FROM forecast f
    JOIN produtos pr ON pr.id = f.produto_id`;

// ── GET /api/forecast?periodo=YYYY-MM ──
router.get('/', autenticar, async (req, res) => {
  try {
    const params = [];
    let where = '';
    if (req.query.periodo) {
      const periodo = normalizarPeriodo(req.query.periodo);
      if (!periodo) throw new HttpErro(400, 'Período inválido.');
      params.push(periodo);
      where = 'WHERE f.periodo_inicio = $1';
    }
    const r = await db.query(`${SELECT_FORECAST} ${where} ORDER BY f.periodo_inicio DESC, pr.nome`, params);
    return res.json({ forecast: r.rows });
  } catch (e) { return responderErro(res, e, 'listar forecast'); }
});

// ── POST /api/forecast/calcular — calcula a sugestão (todos os acabados ativos ou um produto) ──
// Não sobrescreve forecast já APROVADO. Produto sem histórico de demanda é ignorado
// (para incluir um produto novo, use o lançamento manual: POST /api/forecast).
router.post('/calcular', ...podeEscrever, async (req, res) => {
  try {
    const periodo = normalizarPeriodo(req.body.periodo);
    if (!periodo) throw new HttpErro(400, 'Informe o período (YYYY-MM).');

    const resumo = await transacao(async (client) => {
      const params = [];
      let filtro = '';
      if (req.body.produto_id) { params.push(parseInt(req.body.produto_id)); filtro = 'AND id = $1'; }
      const prods = await client.query(
        `SELECT id FROM produtos WHERE tipo = 'ACABADO' AND ativo = TRUE ${filtro} ORDER BY nome`, params);

      let criados = 0, atualizados = 0, aprovados = 0, semHistorico = 0;
      for (const p of prods.rows) {
        const { sugestao, meses } = await calcularSugestao(client, p.id, periodo);
        if (meses === 0) { semHistorico++; continue; }

        const existente = await client.query(
          `SELECT id, status FROM forecast WHERE produto_id = $1 AND periodo_inicio = $2 FOR UPDATE`,
          [p.id, periodo]);
        if (!existente.rows.length) {
          await client.query(
            `INSERT INTO forecast (produto_id, periodo_inicio, quantidade_sugerida, quantidade_prevista, criado_por)
             VALUES ($1, $2, $3, $3, $4)`,
            [p.id, periodo, sugestao, req.usuario.id]);
          criados++;
        } else if (existente.rows[0].status === 'APROVADO') {
          aprovados++;
        } else {
          await client.query(
            `UPDATE forecast SET quantidade_sugerida = $2, quantidade_prevista = $2,
                    status = 'PENDENTE', atualizado_em = NOW() WHERE id = $1`,
            [existente.rows[0].id, sugestao]);
          atualizados++;
        }
      }
      return { criados, atualizados, aprovados_mantidos: aprovados, sem_historico: semHistorico };
    });
    return res.json({ mensagem: 'Cálculo concluído.', ...resumo });
  } catch (e) { return responderErro(res, e, 'calcular forecast'); }
});

// ── POST /api/forecast — lançamento manual para um produto/mês ──
router.post('/', ...podeEscrever, async (req, res) => {
  try {
    const periodo = normalizarPeriodo(req.body.periodo);
    const produtoId = parseInt(req.body.produto_id);
    if (!periodo || !produtoId) throw new HttpErro(400, 'Informe produto e período.');

    const prod = await db.query(`SELECT tipo, ativo FROM produtos WHERE id = $1`, [produtoId]);
    if (!prod.rows.length || prod.rows[0].tipo !== 'ACABADO' || !prod.rows[0].ativo) {
      throw new HttpErro(400, 'Forecast só pode ser lançado para produto acabado ativo.');
    }
    const { sugestao } = await calcularSugestao(db, produtoId, periodo);
    const prevista = req.body.quantidade_prevista === undefined || req.body.quantidade_prevista === ''
      ? sugestao : numero(req.body.quantidade_prevista);
    if (prevista === null) throw new HttpErro(400, 'Quantidade prevista inválida.');

    const dup = await db.query(`SELECT 1 FROM forecast WHERE produto_id = $1 AND periodo_inicio = $2`, [produtoId, periodo]);
    if (dup.rows.length) throw new HttpErro(409, 'Já existe forecast para este produto neste mês.');

    const r = await db.query(
      `INSERT INTO forecast (produto_id, periodo_inicio, quantidade_sugerida, quantidade_prevista, observacoes, criado_por)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [produtoId, periodo, sugestao, prevista, req.body.observacoes || null, req.usuario.id]);
    return res.status(201).json({ mensagem: 'Forecast lançado.', id: r.rows[0].id });
  } catch (e) { return responderErro(res, e, 'lançar forecast'); }
});

// ── PATCH /api/forecast/:id — ajusta quantidade/observações (só se não aprovado) ──
router.patch('/:id', ...podeEscrever, async (req, res) => {
  try {
    const atual = await db.query(`SELECT status FROM forecast WHERE id = $1`, [req.params.id]);
    if (!atual.rows.length) throw new HttpErro(404, 'Forecast não encontrado.');
    if (atual.rows[0].status === 'APROVADO') throw new HttpErro(409, 'Forecast aprovado não pode ser editado. Volte-o para revisão primeiro.');

    let prevista = null;
    if (req.body.quantidade_prevista !== undefined) {
      prevista = numero(req.body.quantidade_prevista);
      if (prevista === null) throw new HttpErro(400, 'Quantidade prevista inválida.');
    }
    await db.query(
      `UPDATE forecast SET quantidade_prevista = COALESCE($2, quantidade_prevista),
              observacoes = COALESCE($3, observacoes), atualizado_em = NOW() WHERE id = $1`,
      [req.params.id, prevista, req.body.observacoes ?? null]);
    return res.json({ mensagem: 'Forecast atualizado.' });
  } catch (e) { return responderErro(res, e, 'editar forecast'); }
});

// ── PATCH /api/forecast/:id/status — aprova ou pede revisão ──
router.patch('/:id/status', ...podeEscrever, async (req, res) => {
  const { status } = req.body;
  try {
    if (!['APROVADO', 'REVISAO', 'PENDENTE'].includes(status)) throw new HttpErro(400, 'Status inválido.');
    const f = await transacao(async (client) => {
      const r = await client.query(
        `SELECT f.id, f.status, f.produto_id, f.quantidade_prevista::float8 AS prevista,
                TO_CHAR(f.periodo_inicio, 'YYYY-MM-DD') AS periodo, pr.nome AS produto
           FROM forecast f JOIN produtos pr ON pr.id = f.produto_id
          WHERE f.id = $1 FOR UPDATE OF f`, [req.params.id]);
      if (!r.rows.length) throw new HttpErro(404, 'Forecast não encontrado.');
      const atual = r.rows[0];
      if (atual.status === 'APROVADO' && status !== 'APROVADO') {
        const pap = await client.query(`SELECT 1 FROM pap WHERE forecast_id = $1`, [atual.id]);
        if (pap.rows.length) throw new HttpErro(409, 'Este forecast já foi usado em um PAP. Remova o PAP antes de alterá-lo.');
      }
      await client.query(`UPDATE forecast SET status = $2, atualizado_em = NOW() WHERE id = $1`, [atual.id, status]);
      return atual;
    });
    if (status === 'APROVADO' && f.status !== 'APROVADO') {
      await notificarFuncoes(['PAP'], 'forecast_aprovado',
        `📊 Forecast aprovado — ${f.produto}`,
        `Previsão de ${f.prevista} un. para ${rotuloPeriodo(f.periodo)} aprovada. Disponível para montar o PAP.`,
        req.usuario.id);
    }
    return res.json({ mensagem: 'Status atualizado.' });
  } catch (e) { return responderErro(res, e, 'status do forecast'); }
});

// ── DELETE /api/forecast/:id — remove (só se não aprovado) ──
router.delete('/:id', ...podeEscrever, async (req, res) => {
  try {
    const r = await db.query(
      `DELETE FROM forecast WHERE id = $1 AND status <> 'APROVADO' RETURNING id`, [req.params.id]);
    if (!r.rows.length) throw new HttpErro(409, 'Forecast não encontrado ou já aprovado.');
    return res.json({ mensagem: 'Forecast removido.' });
  } catch (e) { return responderErro(res, e, 'remover forecast'); }
});

module.exports = router;
