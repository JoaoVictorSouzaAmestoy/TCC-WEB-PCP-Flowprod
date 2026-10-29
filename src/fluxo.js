// src/fluxo.js — Utilitários compartilhados pelos módulos de PCP
// (Forecast → PAP → PMP → MRP → Compra/Produção)
const db = require('./db');
const { notificar } = require('./notificar');

// Erro com status HTTP — as rotas devolvem { erro } com esse status
class HttpErro extends Error {
  constructor(status, mensagem) { super(mensagem); this.status = status; }
}

// Responde um erro de rota: HttpErro mantém o status; o resto vira 500
function responderErro(res, erro, contexto) {
  if (erro instanceof HttpErro) return res.status(erro.status).json({ erro: erro.message });
  console.error(`Erro em ${contexto}:`, erro.message);
  return res.status(500).json({ erro: 'Erro interno.' });
}

// Executa fn(client) dentro de uma transação
async function transacao(fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

// Aceita 'YYYY-MM' ou 'YYYY-MM-DD' e devolve 'YYYY-MM-01' (ou null se inválido)
function normalizarPeriodo(valor) {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(String(valor || '').trim());
  if (!m) return null;
  const mes = parseInt(m[2], 10);
  if (mes < 1 || mes > 12) return null;
  return `${m[1]}-${m[2]}-01`;
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Valida um número não negativo (ou positivo, se estrito) vindo do body
function numero(valor, { estrito = false } = {}) {
  if (valor === '' || valor === null || valor === undefined) return null;
  const n = Number(valor);
  if (!Number.isFinite(n)) return null;
  if (estrito ? n <= 0 : n < 0) return null;
  return round2(n);
}

// Notifica todos os usuários ativos que tenham ao menos uma das funções (exceto quem agiu)
async function notificarFuncoes(funcoes, tipo, titulo, mensagem, excluirUsuarioId = null) {
  try {
    const r = await db.query(
      `SELECT id FROM usuarios WHERE funcoes && $1::text[] AND ativo = TRUE`,
      [funcoes]
    );
    for (const u of r.rows) {
      if (excluirUsuarioId && u.id === excluirUsuarioId) continue;
      await notificar(u.id, tipo, titulo, mensagem);
    }
  } catch (e) { console.error('[notificarFuncoes]', e.message); }
}

// Rótulo "mês/ano" para mensagens
function rotuloPeriodo(periodo) {
  const [a, m] = String(periodo).slice(0, 7).split('-');
  return `${m}/${a}`;
}

module.exports = {
  HttpErro, responderErro, transacao, normalizarPeriodo, round2, numero,
  notificarFuncoes, rotuloPeriodo,
};
