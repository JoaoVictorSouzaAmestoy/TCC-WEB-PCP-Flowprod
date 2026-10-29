-- ============================================================
-- FlowProd — Migration: Forecast, PAP, PMP, Estoque/BOM, MRP e Compra/Produção
-- Para o banco JÁ EXISTENTE (Neon/local) — preserva usuários, clientes,
-- produtos, pedidos, demanda, notificações e logs.
--
-- ⚠️  Remove as tabelas legadas e SEM uso: forecast, plano_mestre, estoque,
--     mrp e ordens_producao (modelo antigo, incompatível com o novo).
--     Se houver dado real nelas que você queira guardar, faça backup antes.
-- Rodar uma única vez, conectado ao banco "flowprod".
-- ============================================================
BEGIN;

DROP TABLE IF EXISTS ordens_producao CASCADE;
DROP TABLE IF EXISTS mrp             CASCADE;
DROP TABLE IF EXISTS plano_mestre    CASCADE;
DROP TABLE IF EXISTS estoque         CASCADE;
DROP TABLE IF EXISTS forecast        CASCADE;

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


COMMIT;

SELECT table_name AS tabelas FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;
