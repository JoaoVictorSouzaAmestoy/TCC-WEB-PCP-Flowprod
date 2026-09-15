require('dotenv').config();
const express      = require('express');
const cookieParser = require('cookie-parser');
const cors         = require('cors');
const path         = require('path');

const authRoutes             = require('./src/routes/auth');
const dadosRoutes            = require('./src/routes/dados');
const usuariosRoutes         = require('./src/routes/usuarios');
const senhaRoutes            = require('./src/routes/senha');
const pedidosRoutes          = require('./src/routes/pedidos');
const produtosRoutes         = require('./src/routes/produtos');
const demandaRoutes          = require('./src/routes/demanda');
const clientesRoutes         = require('./src/routes/clientes');
const notifRoutes            = require('./src/routes/notificacoes');
const alertasRoutes          = require('./src/routes/alertas');
const colaboradorRoutes      = require('./src/routes/colaborador');
const solicitacoesExecRoutes = require('./src/routes/solicitacoes-executor');
const convitesRoutes         = require('./src/routes/convites');
const logsRoutes             = require('./src/routes/logs');
const { autenticar, autorizarFuncao } = require('./src/middlewares/auth');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS ─────────────────────────────────────────────────────
const origens = [
  'http://localhost:3000',
  process.env.APP_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Permite sem origin (ex: Postman, curl) ou origens conhecidas
    if (!origin || origens.some(o => origin.startsWith(o))) return cb(null, true);
    cb(null, true); // liberado para todas — ajuste se quiser restringir
  },
  credentials: true,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── MODO MANUTENÇÃO ───────────────────────────────────────────
// Lido em memória — muda sem reiniciar o servidor
let modoManutencao = false;

// Rotas que nunca bloqueiam (painel de manutenção e healthcheck)
const ROTAS_LIVRES = ['/manutencao', '/api/manutencao', '/api/health'];

app.use((req, res, next) => {
  if (!modoManutencao) return next();
  if (ROTAS_LIVRES.some(r => req.path.startsWith(r))) return next();
  // API → retorna JSON
  if (req.path.startsWith('/api')) {
    return res.status(503).json({
      erro: 'Sistema em manutenção. Tente novamente em breve.',
      manutencao: true,
    });
  }
  // Páginas HTML → redireciona para tela de manutenção
  res.redirect('/manutencao');
});

// ── HEALTHCHECK (Render usa isso pra saber se o app está vivo) ──
app.get('/api/health', (req, res) => {
  res.json({ ok: true, manutencao: modoManutencao, ts: new Date().toISOString() });
});

// ── PAINEL DE MANUTENÇÃO ──────────────────────────────────────
app.get('/manutencao', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'manutencao.html'));
});

// Endpoint para ligar/desligar manutenção (protegido por senha de manutenção)
app.post('/api/manutencao/toggle', (req, res) => {
  const { senha } = req.body;
  const senhaCorreta = process.env.MANUTENCAO_SENHA || 'flowprod@manut';
  if (senha !== senhaCorreta) {
    return res.status(401).json({ erro: 'Senha incorreta.' });
  }
  modoManutencao = !modoManutencao;
  console.log(`🔧 Modo manutenção: ${modoManutencao ? 'ATIVADO' : 'DESATIVADO'}`);
  res.json({ manutencao: modoManutencao, mensagem: modoManutencao ? 'Sistema em manutenção.' : 'Sistema online.' });
});

// Status atual da manutenção (sem autenticação — usado pelo painel)
app.get('/api/manutencao/status', (req, res) => {
  res.json({ manutencao: modoManutencao });
});

// ── API ────────────────────────────────────────────────────────
app.use('/api',                       authRoutes);
app.use('/api/usuarios',              usuariosRoutes);
app.use('/api/senha',                 senhaRoutes);
app.use('/api/pedidos',               pedidosRoutes);
app.use('/api/produtos',              produtosRoutes);
app.use('/api/demanda',               demandaRoutes);
app.use('/api/clientes',              clientesRoutes);
app.use('/api/notificacoes',          notifRoutes);
app.use('/api/alertas',               alertasRoutes);
app.use('/api/colaborador',           colaboradorRoutes);
app.use('/api/solicitacoes-executor', solicitacoesExecRoutes);
app.use('/api/convites',              convitesRoutes);
app.use('/api/logs',                  logsRoutes);
app.use('/api',                       dadosRoutes);

// ── HTML ───────────────────────────────────────────────────────
const pub = (file) => (req, res) =>
  res.sendFile(path.join(__dirname, 'public', file));

app.get('/',                        pub('index.html'));
app.get('/login.html',              pub('login.html'));
app.get('/primeiro-acesso.html',    pub('primeiro-acesso.html'));
app.get('/cliente.html',            pub('cliente.html'));
app.get('/colaborador.html',        pub('colaborador.html'));
app.get('/solicitar-acesso.html',   pub('solicitar-acesso.html'));
app.get('/painel-alertas.html',     pub('painel-alertas.html'));

app.get('/admin.html', autenticar, autorizarFuncao('ADMIN'), pub('admin.html'));

app.get('/comercial.html',       autenticar, autorizarFuncao('COMERCIAL', 'ADMIN'),       pub('comercial.html'));
app.get('/forecast.html',        autenticar, autorizarFuncao('FORECAST', 'ADMIN'),        pub('forecast.html'));
app.get('/pap.html',             autenticar, autorizarFuncao('PAP', 'ADMIN'),             pub('pap.html'));
app.get('/pmp.html',             autenticar, autorizarFuncao('PMP', 'ADMIN'),             pub('pmp.html'));
app.get('/mrp.html',             autenticar, autorizarFuncao('MRP', 'ADMIN'),             pub('mrp.html'));
app.get('/estoque.html',         autenticar, autorizarFuncao('ESTOQUE', 'ADMIN'),         pub('estoque.html'));
app.get('/compra-producao.html', autenticar, autorizarFuncao('COMPRA_PRODUCAO', 'ADMIN'), pub('compra-producao.html'));

app.get('/pedido.html', (req, res) => {
  const jwt   = require('jsonwebtoken');
  const token = req.cookies?.token_cliente;
  if (!token) return res.redirect('/cliente.html');
  try {
    const p = jwt.verify(token, process.env.JWT_SECRET);
    if (p.tipo !== 'CLIENTE') return res.redirect('/cliente.html');
    res.sendFile(path.join(__dirname, 'public', 'pedido.html'));
  } catch { res.redirect('/cliente.html'); }
});

// ── Painel de controle de manutenção (página separada) ─────────
app.get('/painel-manutencao', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'painel-manutencao.html'))
);

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));

// ── START ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 FlowProd rodando na porta ${PORT}`);
  console.log(`   Ambiente: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   URL:      ${process.env.APP_URL || `http://localhost:${PORT}`}\n`);
});
