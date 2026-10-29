-- ============================================================
-- FlowProd — Script ÚNICO para DBeaver
-- ⚠️  Apaga TODOS os dados e recria tudo do zero
-- Execute conectado ao banco "flowprod" no DBeaver
-- ============================================================

-- ── 1. APAGA TUDO (ordem importa por causa das FK) ──────────
DROP TABLE IF EXISTS notificacoes_cliente    CASCADE;
DROP TABLE IF EXISTS notificacoes            CASCADE;
DROP TABLE IF EXISTS logs_admin              CASCADE;
DROP TABLE IF EXISTS convites                CASCADE;
DROP TABLE IF EXISTS solicitacoes_senha      CASCADE;
DROP TABLE IF EXISTS solicitacoes_executor   CASCADE;
DROP TABLE IF EXISTS compra_producao         CASCADE;
DROP TABLE IF EXISTS ordens_producao         CASCADE;
DROP TABLE IF EXISTS mrp                     CASCADE;
DROP TABLE IF EXISTS pmp                     CASCADE;
DROP TABLE IF EXISTS pap                     CASCADE;
DROP TABLE IF EXISTS plano_mestre            CASCADE;
DROP TABLE IF EXISTS estoque_movimentacoes   CASCADE;
DROP TABLE IF EXISTS estoque                 CASCADE;
DROP TABLE IF EXISTS bom                     CASCADE;
DROP TABLE IF EXISTS forecast                CASCADE;
DROP TABLE IF EXISTS demanda                CASCADE;
DROP TABLE IF EXISTS pedido_itens            CASCADE;
DROP TABLE IF EXISTS pedidos_cliente         CASCADE;
DROP TABLE IF EXISTS pedidos                 CASCADE;
DROP TABLE IF EXISTS produtos                CASCADE;
DROP TABLE IF EXISTS clientes                CASCADE;
DROP FUNCTION IF EXISTS gerar_numero_pedido  CASCADE;
DROP TABLE IF EXISTS usuarios                CASCADE;

-- ── 2. RECRIA TABELAS ────────────────────────────────────────

-- Usuários internos (admin + executores)
CREATE TABLE usuarios (
  id        SERIAL PRIMARY KEY,
  nome      VARCHAR(100)        NOT NULL,
  email     VARCHAR(150) UNIQUE NOT NULL,
  senha     VARCHAR(255)        NOT NULL,
  funcoes   TEXT[]              NOT NULL DEFAULT '{}',
  ativo     BOOLEAN             DEFAULT TRUE,
  criado_em TIMESTAMP           DEFAULT NOW()
);

-- Clientes externos
CREATE TABLE clientes (
  id                 SERIAL PRIMARY KEY,
  nome               VARCHAR(100)        NOT NULL,
  email              VARCHAR(150) UNIQUE NOT NULL,
  senha              VARCHAR(255),
  empresa            VARCHAR(100),
  telefone           VARCHAR(30),
  mensagem_interesse TEXT,
  status             VARCHAR(20)         DEFAULT 'PENDENTE'
                     CHECK (status IN ('PENDENTE','APROVADO','RECUSADO')),
  criado_em          TIMESTAMP           DEFAULT NOW(),
  aprovado_em        TIMESTAMP
);

-- Solicitações de acesso de novos colaboradores (executores)
CREATE TABLE solicitacoes_executor (
  id           SERIAL PRIMARY KEY,
  nome         VARCHAR(100)        NOT NULL,
  email        VARCHAR(150) UNIQUE NOT NULL,
  senha        VARCHAR(255)        NOT NULL,
  funcoes      TEXT[]              NOT NULL DEFAULT '{}',
  status       VARCHAR(20)         DEFAULT 'PENDENTE'
               CHECK (status IN ('PENDENTE','APROVADO','RECUSADO')),
  criado_em    TIMESTAMP           DEFAULT NOW(),
  resolvido_em TIMESTAMP
);

-- Produtos (tabela mestre — acabados e matérias-primas)
CREATE TABLE produtos (
  id             SERIAL PRIMARY KEY,
  nome           VARCHAR(200) NOT NULL UNIQUE,
  tipo           VARCHAR(20)  NOT NULL
                 CHECK (tipo IN ('ACABADO','MATERIA_PRIMA')),
  unidade_padrao VARCHAR(20)  NOT NULL,
  ativo          BOOLEAN      DEFAULT TRUE,
  criado_em      TIMESTAMP    DEFAULT NOW(),
  atualizado_em  TIMESTAMP    DEFAULT NOW()
);

-- Pedidos dos clientes (cabeçalho — um pedido pode ter vários produtos)
CREATE TABLE pedidos (
  id            SERIAL PRIMARY KEY,
  numero        VARCHAR(20)  UNIQUE,   -- preenchido pela trigger abaixo (ex: PED-000123)
  cliente_id    INTEGER      NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  data_desejada DATE,
  observacoes   TEXT,
  status        VARCHAR(20)  DEFAULT 'PENDENTE'
                CHECK (status IN ('PENDENTE','CONFIRMADO','CANCELADO')),
  criado_em     TIMESTAMP    DEFAULT NOW(),
  atualizado_em TIMESTAMP    DEFAULT NOW()
);

-- Gera o número do pedido (PED-000001, PED-000002, ...) automaticamente
CREATE OR REPLACE FUNCTION gerar_numero_pedido() RETURNS TRIGGER AS $$
BEGIN
  NEW.numero := 'PED-' || LPAD(NEW.id::text, 6, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_numero_pedido
BEFORE INSERT ON pedidos
FOR EACH ROW EXECUTE FUNCTION gerar_numero_pedido();

-- Itens do pedido (um produto + quantidade por linha)
CREATE TABLE pedido_itens (
  id         SERIAL PRIMARY KEY,
  pedido_id  INTEGER      NOT NULL REFERENCES pedidos(id)  ON DELETE CASCADE,
  produto_id INTEGER      NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
  quantidade INTEGER      NOT NULL CHECK (quantidade > 0),
  unidade    VARCHAR(20),
  criado_em  TIMESTAMP    DEFAULT NOW()
);

-- Demanda consolidada — agregada por produto + mês, a partir de pedidos CONFIRMADO.
-- Não é cópia de pedido: reconstruída via DELETE+INSERT (src/demanda.js) sempre que
-- o status de um pedido muda (feito em código Node, não trigger de banco).
CREATE TABLE demanda (
  id             SERIAL PRIMARY KEY,
  produto_id     INTEGER       NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
  periodo_inicio DATE          NOT NULL,   -- sempre dia 1 do mês
  quantidade     NUMERIC(12,2) NOT NULL DEFAULT 0,
  origem         VARCHAR(30)   DEFAULT 'PEDIDOS',
  criado_em      TIMESTAMP     DEFAULT NOW(),
  atualizado_em  TIMESTAMP     DEFAULT NOW(),
  UNIQUE (produto_id, periodo_inicio)
);

-- Forecast — estimativa futura por produto/mês (demanda = real, forecast = previsto).
-- quantidade_sugerida = média móvel de 3 meses calculada pelo sistema;
-- quantidade_prevista = valor final (sugerido ou ajustado pelo PCP).
CREATE TABLE forecast (
  id                  SERIAL PRIMARY KEY,
  produto_id          INTEGER       NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
  periodo_inicio      DATE          NOT NULL,   -- sempre dia 1 do mês
  quantidade_sugerida NUMERIC(12,2) NOT NULL DEFAULT 0,
  quantidade_prevista NUMERIC(12,2) NOT NULL DEFAULT 0,
  status              VARCHAR(20)   NOT NULL DEFAULT 'PENDENTE'
                      CHECK (status IN ('PENDENTE','APROVADO','REVISAO')),
  observacoes         TEXT,
  criado_por          INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em           TIMESTAMP     DEFAULT NOW(),
  atualizado_em       TIMESTAMP     DEFAULT NOW(),
  UNIQUE (produto_id, periodo_inicio)
);

-- PAP — Plano Agregado de Produção (um registro por produto/mês, montado a partir do forecast APROVADO)
CREATE TABLE pap (
  id                   SERIAL PRIMARY KEY,
  forecast_id          INTEGER REFERENCES forecast(id) ON DELETE SET NULL,
  produto_id           INTEGER       NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
  periodo_inicio       DATE          NOT NULL,
  quantidade_forecast  NUMERIC(12,2) NOT NULL DEFAULT 0,
  estoque_atual        NUMERIC(12,2) NOT NULL DEFAULT 0,   -- saldo do acabado no momento da montagem
  quantidade_planejada NUMERIC(12,2) NOT NULL DEFAULT 0,   -- produção planejada (sugestão = forecast − estoque, ajustável)
  status               VARCHAR(20)   NOT NULL DEFAULT 'RASCUNHO'
                       CHECK (status IN ('RASCUNHO','APROVADO')),
  observacoes          TEXT,
  criado_por           INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em            TIMESTAMP     DEFAULT NOW(),
  atualizado_em        TIMESTAMP     DEFAULT NOW(),
  UNIQUE (produto_id, periodo_inicio)
);

-- PMP — Plano Mestre de Produção (PAP desagregado em 4 semanas; gerado automaticamente ao aprovar o PAP)
CREATE TABLE pmp (
  id            SERIAL PRIMARY KEY,
  pap_id        INTEGER       NOT NULL REFERENCES pap(id) ON DELETE CASCADE,
  produto_id    INTEGER       NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
  periodo_inicio DATE         NOT NULL,
  semana        INTEGER       NOT NULL CHECK (semana BETWEEN 1 AND 4),
  quantidade    NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (quantidade >= 0),
  status        VARCHAR(20)   NOT NULL DEFAULT 'RASCUNHO'
                CHECK (status IN ('RASCUNHO','APROVADO')),
  atualizado_em TIMESTAMP     DEFAULT NOW(),
  UNIQUE (pap_id, semana)
);

-- BOM — estrutura de produto (acabado = pai, matéria-prima = componente)
CREATE TABLE bom (
  id                   SERIAL PRIMARY KEY,
  produto_pai_id       INTEGER       NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  componente_id        INTEGER       NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
  quantidade_por_unidade NUMERIC(12,4) NOT NULL CHECK (quantidade_por_unidade > 0),
  criado_em            TIMESTAMP     DEFAULT NOW(),
  UNIQUE (produto_pai_id, componente_id),
  CHECK (produto_pai_id <> componente_id)
);

-- Estoque — saldo atual por produto (acabado ou matéria-prima)
CREATE TABLE estoque (
  produto_id       INTEGER PRIMARY KEY REFERENCES produtos(id) ON DELETE CASCADE,
  quantidade_atual NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (quantidade_atual >= 0),
  atualizado_em    TIMESTAMP     DEFAULT NOW()
);

-- Movimentações de estoque (histórico). delta é com sinal: + entrada, − saída.
CREATE TABLE estoque_movimentacoes (
  id          SERIAL PRIMARY KEY,
  produto_id  INTEGER       NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  tipo        VARCHAR(20)   NOT NULL CHECK (tipo IN ('ENTRADA','SAIDA','AJUSTE')),
  delta       NUMERIC(12,2) NOT NULL CHECK (delta <> 0),
  saldo_apos  NUMERIC(12,2) NOT NULL,
  motivo      TEXT,
  origem      VARCHAR(30)   NOT NULL DEFAULT 'MANUAL',   -- MANUAL | COMPRA_PRODUCAO
  usuario_id  INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em   TIMESTAMP     DEFAULT NOW()
);

-- MRP — necessidades por produto/mês (recalculado automaticamente: PMP aprovado → BOM → estoque).
-- Agregado por produto porque a matéria-prima é compartilhada entre acabados.
CREATE TABLE mrp (
  id                  SERIAL PRIMARY KEY,
  periodo_inicio      DATE          NOT NULL,
  produto_id          INTEGER       NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
  tipo                VARCHAR(20)   NOT NULL CHECK (tipo IN ('PRODUCAO','COMPRA')),
  necessidade_bruta   NUMERIC(12,2) NOT NULL DEFAULT 0,
  estoque_considerado NUMERIC(12,2) NOT NULL DEFAULT 0,
  necessidade_liquida NUMERIC(12,2) NOT NULL DEFAULT 0,
  atualizado_em       TIMESTAMP     DEFAULT NOW(),
  UNIQUE (periodo_inicio, produto_id)
);

-- Compra/Produção — ordens sugeridas pelo MRP; aprovação e execução manuais
CREATE TABLE compra_producao (
  id             SERIAL PRIMARY KEY,
  origem_mrp_id  INTEGER REFERENCES mrp(id) ON DELETE SET NULL,
  produto_id     INTEGER       NOT NULL REFERENCES produtos(id) ON DELETE RESTRICT,
  periodo_inicio DATE          NOT NULL,
  tipo           VARCHAR(20)   NOT NULL CHECK (tipo IN ('PRODUCAO','COMPRA')),
  quantidade     NUMERIC(12,2) NOT NULL CHECK (quantidade > 0),
  status         VARCHAR(20)   NOT NULL DEFAULT 'SUGERIDA'
                 CHECK (status IN ('SUGERIDA','APROVADA','EM_ANDAMENTO','CONCLUIDA','CANCELADA')),
  observacoes    TEXT,
  descartada     BOOLEAN       NOT NULL DEFAULT FALSE,   -- true = sugestão recusada direto (SUGERIDA → CANCELADA)
  atualizado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em      TIMESTAMP     DEFAULT NOW(),
  atualizado_em  TIMESTAMP     DEFAULT NOW()
);

-- Solicitacoes de redefinicao de senha (executor pede, admin aprova)
CREATE TABLE solicitacoes_senha (
  id           SERIAL PRIMARY KEY,
  usuario_id   INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
  status       VARCHAR(20) DEFAULT 'PENDENTE'
               CHECK (status IN ('PENDENTE','APROVADA','RECUSADA')),
  nova_senha   VARCHAR(255),
  criado_em    TIMESTAMP   DEFAULT NOW(),
  resolvido_em TIMESTAMP
);

-- Convites de primeiro acesso
CREATE TABLE convites (
  id         SERIAL PRIMARY KEY,
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
  codigo     VARCHAR(8) UNIQUE NOT NULL,
  usado      BOOLEAN   DEFAULT FALSE,
  criado_em  TIMESTAMP DEFAULT NOW(),
  usado_em   TIMESTAMP
);

-- Notificacoes internas (executores e admin)
CREATE TABLE notificacoes (
  id         SERIAL PRIMARY KEY,
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo       VARCHAR(50)  DEFAULT 'info',
  titulo     VARCHAR(200) NOT NULL,
  mensagem   TEXT,
  lida       BOOLEAN      DEFAULT FALSE,
  criado_em  TIMESTAMP    DEFAULT NOW()
);

-- Notificacoes para clientes
CREATE TABLE notificacoes_cliente (
  id         SERIAL PRIMARY KEY,
  cliente_id INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
  tipo       VARCHAR(50)  DEFAULT 'info',
  titulo     VARCHAR(200) NOT NULL,
  mensagem   TEXT,
  lida       BOOLEAN      DEFAULT FALSE,
  criado_em  TIMESTAMP    DEFAULT NOW()
);

-- Log de acoes do admin
CREATE TABLE logs_admin (
  id        SERIAL PRIMARY KEY,
  admin_id  INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  acao      VARCHAR(100) NOT NULL,
  detalhes  TEXT,
  criado_em TIMESTAMP    DEFAULT NOW()
);

-- ── 3. ADMIN INICIAL ─────────────────────────────────────────
INSERT INTO usuarios (nome, email, senha, funcoes)
VALUES ('Administrador', 'admin@flowprod.com', 'Admin@123', '{ADMIN}');

-- ── 4. CONFIRMA ──────────────────────────────────────────────
SELECT 'Banco FlowProd recriado com sucesso!' AS resultado;

SELECT table_name AS tabelas_criadas
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;
