// src/routes/pmp.js — PMP (Plano Mestre de Produção, 4 semanas por produto/mês)
//
// O PMP nasce automaticamente quando o PAP é aprovado (ver pap.js). Aqui o PCP
// redistribui a quantidade entre as semanas (o total tem que bater com o PAP)
// e aprova. Aprovar dispara o MRP automaticamente.
// Leitura: qualquer função logada. Escrita: PMP, ADMIN.
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { autenticar, autorizarFuncao } = require('../middlewares/auth');
const { faixasDasSemanas } = require('../pmp');
const { reconstruirMrp } = require('../mrp');
const {
  HttpErro, responderErro, transacao, normalizarPeriodo, round2, numero,
  notificarFuncoes, rotuloPeriodo,
} = require('../fluxo');

const podeEscrever = [autenticar, autorizarFuncao('PMP', 'ADMIN')];

// ── GET /api/pmp?periodo=YYYY-MM — um item por PAP, com as 4 semanas ──
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
    const r = await db.query(
      `SELECT p.id AS pap_id, p.produto_id, pr.nome AS produto, pr.unidade_padrao,
              TO_CHAR(p.periodo_inicio, 'YYYY-MM-DD') AS periodo_inicio,
              p.quantidade_planejada::float8 AS quantidade_planejada,
              m.semana, m.quantidade::float8 AS quantidade, m.status
         FROM pap p
         JOIN produtos pr ON pr.id = p.produto_id
         JOIN pmp m ON m.pap_id = p.id
         ${where}
        ORDER BY p.periodo_inicio DESC, pr.nome, m.semana`, params);

    const mapa = new Map();
    for (const row of r.rows) {
      if (!mapa.has(row.pap_id)) {
        const faixas = faixasDasSemanas(row.periodo_inicio);
        mapa.set(row.pap_id, {
          pap_id: row.pap_id, produto_id: row.produto_id, produto: row.produto,
          unidade_padrao: row.unidade_padrao, periodo_inicio: row.periodo_inicio,
          quantidade_planejada: row.quantidade_planejada, status: row.status,
          semanas: faixas.map(f => ({ ...f, quantidade: 0 })),
        });
      }
      const item = mapa.get(row.pap_id);
      item.semanas[row.semana - 1].quantidade = row.quantidade;
      if (row.status === 'RASCUNHO') item.status = 'RASCUNHO';
    }
    return res.json({ pmp: [...mapa.values()] });
  } catch (e) { return responderErro(res, e, 'listar PMP'); }
});

// ── PUT /api/pmp/pap/:papId — redistribui as 4 semanas (só RASCUNHO; soma = PAP) ──
router.put('/pap/:papId', ...podeEscrever, async (req, res) => {
  try {
    const semanas = req.body.semanas;
    if (!Array.isArray(semanas) || semanas.length !== 4) throw new HttpErro(400, 'Informe as 4 semanas.');
    const qtds = semanas.map(s => numero(s));
    if (qtds.some(q => q === null)) throw new HttpErro(400, 'Quantidade inválida em alguma semana.');

    await transacao(async (client) => {
      const r = await client.query(
        `SELECT p.quantidade_planejada::float8 AS planejada,
                (SELECT COUNT(*) FROM pmp WHERE pap_id = p.id AND status = 'APROVADO')::int AS aprovadas
           FROM pap p WHERE p.id = $1 FOR UPDATE`, [req.params.papId]);
      if (!r.rows.length) throw new HttpErro(404, 'PMP não encontrado.');
      if (r.rows[0].aprovadas > 0) throw new HttpErro(409, 'PMP aprovado não pode ser editado. Reabra-o primeiro.');
      const soma = round2(qtds.reduce((a, b) => a + b, 0));
      if (Math.abs(soma - r.rows[0].planejada) > 0.005) {
        throw new HttpErro(400, `A soma das semanas (${soma}) deve ser igual à quantidade do PAP (${r.rows[0].planejada}).`);
      }
      for (let i = 0; i < 4; i++) {
        await client.query(
          `UPDATE pmp SET quantidade = $3, atualizado_em = NOW() WHERE pap_id = $1 AND semana = $2`,
          [req.params.papId, i + 1, qtds[i]]);
      }
    });
    return res.json({ mensagem: 'PMP atualizado.' });
  } catch (e) { return responderErro(res, e, 'editar PMP'); }
});

// ── POST /api/pmp/pap/:papId/aprovar — aprova e dispara o MRP ──
router.post('/pap/:papId/aprovar', ...podeEscrever, async (req, res) => {
  try {
    const { info, mrp } = await transacao(async (client) => {
      const r = await client.query(
        `SELECT p.id, p.produto_id, pr.nome AS produto, TO_CHAR(p.periodo_inicio, 'YYYY-MM-DD') AS periodo,
                (SELECT COUNT(*) FROM pmp WHERE pap_id = p.id AND status = 'APROVADO')::int AS aprovadas,
                (SELECT COALESCE(SUM(quantidade),0)::float8 FROM pmp WHERE pap_id = p.id) AS soma,
                p.quantidade_planejada::float8 AS planejada
           FROM pap p JOIN produtos pr ON pr.id = p.produto_id
          WHERE p.id = $1 FOR UPDATE OF p`, [req.params.papId]);
      if (!r.rows.length) throw new HttpErro(404, 'PMP não encontrado.');
      const info = r.rows[0];
      if (info.aprovadas > 0) throw new HttpErro(409, 'Este PMP já está aprovado.');
      if (Math.abs(info.soma - info.planejada) > 0.005) throw new HttpErro(409, 'A soma das semanas não bate com o PAP.');
      await client.query(`UPDATE pmp SET status = 'APROVADO', atualizado_em = NOW() WHERE pap_id = $1`, [info.id]);
      const mrp = await reconstruirMrp(client, info.periodo);
      return { info, mrp };
    });
    await notificarFuncoes(['MRP'], 'pmp_aprovado',
      `📋 PMP aprovado — ${info.produto}`,
      `O MRP de ${rotuloPeriodo(info.periodo)} foi recalculado automaticamente.`, req.usuario.id);
    if (mrp.criadas || mrp.atualizadas) {
      await notificarFuncoes(['COMPRA_PRODUCAO'], 'mrp_sugestao',
        `🏭 Novas sugestões de compra/produção`,
        `${mrp.criadas} nova(s) e ${mrp.atualizadas} atualizada(s) para ${rotuloPeriodo(info.periodo)}. Revise e aprove.`, req.usuario.id);
    }
    return res.json({ mensagem: 'PMP aprovado. MRP recalculado.', mrp });
  } catch (e) { return responderErro(res, e, 'aprovar PMP'); }
});

// ── POST /api/pmp/pap/:papId/reabrir — volta para RASCUNHO e recalcula o MRP ──
router.post('/pap/:papId/reabrir', ...podeEscrever, async (req, res) => {
  try {
    await transacao(async (client) => {
      const r = await client.query(
        `SELECT p.id, p.produto_id, TO_CHAR(p.periodo_inicio, 'YYYY-MM-DD') AS periodo,
                (SELECT COUNT(*) FROM pmp WHERE pap_id = p.id AND status = 'APROVADO')::int AS aprovadas
           FROM pap p WHERE p.id = $1 FOR UPDATE`, [req.params.papId]);
      if (!r.rows.length) throw new HttpErro(404, 'PMP não encontrado.');
      const info = r.rows[0];
      if (!info.aprovadas) throw new HttpErro(409, 'Este PMP não está aprovado.');
      const ordens = await client.query(
        `SELECT 1 FROM compra_producao WHERE produto_id = $1 AND periodo_inicio = $2
            AND tipo = 'PRODUCAO' AND status IN ('APROVADA','EM_ANDAMENTO','CONCLUIDA') LIMIT 1`,
        [info.produto_id, info.periodo]);
      if (ordens.rows.length) throw new HttpErro(409, 'Já existem ordens de produção aprovadas/em andamento deste produto neste mês.');
      await client.query(`UPDATE pmp SET status = 'RASCUNHO', atualizado_em = NOW() WHERE pap_id = $1`, [info.id]);
      await reconstruirMrp(client, info.periodo);
    });
    return res.json({ mensagem: 'PMP reaberto. MRP recalculado.' });
  } catch (e) { return responderErro(res, e, 'reabrir PMP'); }
});

module.exports = router;
