// src/routes/compra-producao.js — Ordens de compra (matéria-prima) e de produção (acabado)
//
// As ordens nascem SUGERIDAS (automático, pelo MRP). Aprovação e execução são
// manuais: SUGERIDA → APROVADA → EM_ANDAMENTO → CONCLUIDA (ou CANCELADA).
// Ao concluir, o saldo do produto recebe a entrada automaticamente.
// Leitura: qualquer função logada. Escrita: COMPRA_PRODUCAO, ADMIN.
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { autenticar, autorizarFuncao } = require('../middlewares/auth');
const { aplicarMovimentacao } = require('../estoque');
const { reconstruirMrp } = require('../mrp');
const {
  HttpErro, responderErro, transacao, normalizarPeriodo, numero,
  notificarFuncoes, rotuloPeriodo,
} = require('../fluxo');

// Transições permitidas
const TRANSICOES = {
  SUGERIDA:     ['APROVADA', 'CANCELADA'],
  APROVADA:     ['EM_ANDAMENTO', 'CANCELADA'],
  EM_ANDAMENTO: ['CONCLUIDA', 'CANCELADA'],
  CONCLUIDA:    [],
  CANCELADA:    [],
};

// ── GET /api/compra-producao?periodo=&tipo=&status= ──
router.get('/', autenticar, async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.periodo) {
      const periodo = normalizarPeriodo(req.query.periodo);
      if (!periodo) throw new HttpErro(400, 'Período inválido.');
      params.push(periodo); where.push(`c.periodo_inicio = $${params.length}`);
    }
    if (['COMPRA', 'PRODUCAO'].includes(req.query.tipo)) { params.push(req.query.tipo); where.push(`c.tipo = $${params.length}`); }
    if (req.query.status) { params.push(req.query.status); where.push(`c.status = $${params.length}`); }

    const r = await db.query(
      `SELECT c.id, c.produto_id, pr.nome AS produto, pr.unidade_padrao, c.tipo,
              TO_CHAR(c.periodo_inicio, 'YYYY-MM-DD') AS periodo_inicio,
              c.quantidade::float8 AS quantidade, c.status, c.observacoes,
              c.criado_em, c.atualizado_em
         FROM compra_producao c JOIN produtos pr ON pr.id = c.produto_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY c.periodo_inicio DESC,
                 CASE c.status WHEN 'SUGERIDA' THEN 0 WHEN 'APROVADA' THEN 1 WHEN 'EM_ANDAMENTO' THEN 2 ELSE 3 END,
                 c.tipo, pr.nome`, params);
    return res.json({ ordens: r.rows });
  } catch (e) { return responderErro(res, e, 'listar compra/produção'); }
});

// ── PATCH /api/compra-producao/:id/status ──
// Body: { status, quantidade? (só ao aprovar), observacoes? }
router.patch('/:id/status', autenticar, autorizarFuncao('COMPRA_PRODUCAO', 'ADMIN'), async (req, res) => {
  const { status, observacoes } = req.body;
  try {
    const out = await transacao(async (client) => {
      const r = await client.query(
        `SELECT c.id, c.produto_id, c.tipo, c.status, c.quantidade::float8 AS quantidade,
                TO_CHAR(c.periodo_inicio, 'YYYY-MM-DD') AS periodo, pr.nome AS produto
           FROM compra_producao c JOIN produtos pr ON pr.id = c.produto_id
          WHERE c.id = $1 FOR UPDATE OF c`, [req.params.id]);
      if (!r.rows.length) throw new HttpErro(404, 'Ordem não encontrada.');
      const o = r.rows[0];
      if (!(TRANSICOES[o.status] || []).includes(status)) {
        throw new HttpErro(409, `Não é possível ir de ${o.status} para ${status}.`);
      }

      let quantidade = o.quantidade;
      if (req.body.quantidade !== undefined && req.body.quantidade !== '') {
        if (!(o.status === 'SUGERIDA' && status === 'APROVADA')) {
          throw new HttpErro(400, 'A quantidade só pode ser ajustada ao aprovar a sugestão.');
        }
        quantidade = numero(req.body.quantidade, { estrito: true });
        if (quantidade === null) throw new HttpErro(400, 'Quantidade inválida.');
      }
      const descartada = o.status === 'SUGERIDA' && status === 'CANCELADA';

      await client.query(
        `UPDATE compra_producao SET status = $2, quantidade = $3, descartada = $4,
                observacoes = COALESCE($5, observacoes), atualizado_por = $6, atualizado_em = NOW()
          WHERE id = $1`,
        [o.id, status, quantidade, descartada, observacoes ?? null, req.usuario.id]);

      // Conclusão: entrada automática no estoque (compra → matéria-prima; produção → acabado)
      if (status === 'CONCLUIDA') {
        await aplicarMovimentacao(client, {
          produto_id: o.produto_id, tipo: 'ENTRADA', quantidade,
          motivo: `Ordem de ${o.tipo === 'COMPRA' ? 'compra' : 'produção'} #${o.id} concluída`,
          origem: 'COMPRA_PRODUCAO', usuario_id: req.usuario.id,
        });
      }
      // Status/quantidade/saldo mudaram: reavalia as sugestões do mês
      const mrp = await reconstruirMrp(client, o.periodo);
      return { o, mrp };
    });
    if (out.mrp.criadas) {
      await notificarFuncoes(['COMPRA_PRODUCAO'], 'mrp_sugestao',
        '🏭 Nova sugestão de compra/produção',
        `O saldo pendente de ${rotuloPeriodo(out.o.periodo)} gerou ${out.mrp.criadas} nova(s) sugestão(ões).`, req.usuario.id);
    }
    return res.json({ mensagem: 'Ordem atualizada.' });
  } catch (e) { return responderErro(res, e, 'atualizar ordem'); }
});

module.exports = router;
