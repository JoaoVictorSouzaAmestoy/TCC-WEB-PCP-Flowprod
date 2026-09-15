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
DROP TABLE IF EXISTS ordens_producao         CASCADE;
DROP TABLE IF EXISTS mrp                     CASCADE;
DROP TABLE IF EXISTS estoque                 CASCADE;
DROP TABLE IF EXISTS plano_mestre            CASCADE;
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

-- Forecast (previsão de demanda) — nasce a partir de um item de pedido
CREATE TABLE forecast (
  id               SERIAL PRIMARY KEY,
  pedido_item_id   INTEGER REFERENCES pedido_itens(id) ON DELETE SET NULL,
  produto          VARCHAR(200) NOT NULL,
  demanda_prevista INTEGER      NOT NULL CHECK (demanda_prevista > 0),
  data_inicio      DATE         NOT NULL,
  prazo_limite     DATE         NOT NULL,
  observacoes      TEXT,
  status           VARCHAR(20)  DEFAULT 'PENDENTE'
                   CHECK (status IN ('PENDENTE','APROVADO','REVISAO')),
  criado_por       INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em        TIMESTAMP    DEFAULT NOW()
);

-- Plano Mestre de Producao
CREATE TABLE plano_mestre (
  id          SERIAL PRIMARY KEY,
  forecast_id INTEGER REFERENCES forecast(id) ON DELETE SET NULL,
  descricao   TEXT,
  status      VARCHAR(20) DEFAULT 'RASCUNHO'
              CHECK (status IN ('RASCUNHO','EM_REVISAO','APROVADO')),
  criado_por  INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em   TIMESTAMP   DEFAULT NOW()
);

-- Estoque
CREATE TABLE estoque (
  id                SERIAL PRIMARY KEY,
  materia_prima     VARCHAR(200)  NOT NULL,
  unidade           VARCHAR(20)   NOT NULL,
  quantidade_atual  NUMERIC(10,2) DEFAULT 0,
  quantidade_minima NUMERIC(10,2) DEFAULT 0,
  atualizado_em     TIMESTAMP     DEFAULT NOW()
);

-- MRP (Planejamento de Recursos)
CREATE TABLE mrp (
  id                    SERIAL PRIMARY KEY,
  plano_id              INTEGER REFERENCES plano_mestre(id) ON DELETE SET NULL,
  estoque_id            INTEGER REFERENCES estoque(id)      ON DELETE SET NULL,
  quantidade_necessaria NUMERIC(10,2) NOT NULL,
  situacao              VARCHAR(20)   DEFAULT 'OK'
                        CHECK (situacao IN ('OK','FALTA','COMPRA_SOLICITADA')),
  criado_em             TIMESTAMP     DEFAULT NOW()
);

-- Ordens de Producao
CREATE TABLE ordens_producao (
  id         SERIAL PRIMARY KEY,
  mrp_id     INTEGER REFERENCES mrp(id) ON DELETE SET NULL,
  tipo       VARCHAR(20) CHECK (tipo IN ('PRODUCAO','COMPRA')),
  status     VARCHAR(20) DEFAULT 'ABERTA'
             CHECK (status IN ('ABERTA','EM_ANDAMENTO','CONCLUIDA','CANCELADA')),
  criado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em  TIMESTAMP   DEFAULT NOW()
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
