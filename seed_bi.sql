-- ============================================================
-- FlowProd — Seed de dados para BI
-- Rode DEPOIS do flowprod_banco.sql, conectado ao banco "flowprod".
--
-- Gera: 12 clientes, 8 produtos acabados, 11 matérias-primas, BOM,
--       estoque inicial, 1000 pedidos (~2000 itens) de mai/2025 a out/2026,
--       demanda consolidada e forecast histórico (média móvel de 3 meses).
--
-- Não apaga nada: se já existir qualquer pedido no banco, o script aborta.
-- Dados fictícios (e-mails .test). Login dos clientes: Cliente@123
-- ============================================================

BEGIN;

SELECT setseed(0.42);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pedidos) THEN
    RAISE EXCEPTION 'Já existem pedidos no banco. Rode o flowprod_banco.sql (recria tudo) antes deste seed.';
  END IF;
END $$;

-- ── 1. CLIENTES ──────────────────────────────────────────────
INSERT INTO clientes (nome, email, senha, empresa, telefone, status, criado_em, aprovado_em) VALUES
  ('Carlos Mendes',    'compras@aurora-moveis.test',     'Cliente@123', 'Móveis Aurora Ltda',        '(19) 3251-1001', 'APROVADO', '2025-03-10', '2025-03-11'),
  ('Fernanda Lima',    'pedidos@officeplus.test',        'Cliente@123', 'OfficePlus Escritórios',    '(19) 3251-1002', 'APROVADO', '2025-03-12', '2025-03-13'),
  ('Ricardo Alves',    'suprimentos@univale.test',       'Cliente@123', 'Colégio Univale',           '(11) 4002-1003', 'APROVADO', '2025-03-15', '2025-03-16'),
  ('Juliana Costa',    'compras@clinicavida.test',       'Cliente@123', 'Clínica Vida Saudável',     '(19) 3251-1004', 'APROVADO', '2025-03-20', '2025-03-21'),
  ('Marcos Pereira',   'obras@construtorabase.test',     'Cliente@123', 'Construtora Base',          '(11) 4002-1005', 'APROVADO', '2025-03-25', '2025-03-26'),
  ('Patrícia Souza',   'compras@hotelmirante.test',      'Cliente@123', 'Hotel Mirante',             '(19) 3251-1006', 'APROVADO', '2025-04-02', '2025-04-03'),
  ('André Barbosa',    'pedidos@coworkhub.test',         'Cliente@123', 'CoWork Hub',                '(11) 4002-1007', 'APROVADO', '2025-04-05', '2025-04-06'),
  ('Luciana Rocha',    'compras@prefeituramunicipal.test','Cliente@123','Prefeitura Municipal',      '(19) 3251-1008', 'APROVADO', '2025-04-10', '2025-04-12'),
  ('Eduardo Martins',  'suprimentos@techsoft.test',      'Cliente@123', 'TechSoft Sistemas',         '(11) 4002-1009', 'APROVADO', '2025-04-15', '2025-04-16'),
  ('Camila Ribeiro',   'compras@restaurantesabor.test',  'Cliente@123', 'Restaurante Sabor & Arte',  '(19) 3251-1010', 'APROVADO', '2025-04-20', '2025-04-21'),
  ('Rafael Gomes',     'pedidos@faculdadenorte.test',    'Cliente@123', 'Faculdade Norte',           '(11) 4002-1011', 'APROVADO', '2025-04-25', '2025-04-26'),
  ('Beatriz Nogueira', 'compras@lojaconceito.test',      'Cliente@123', 'Loja Conceito Decor',       '(19) 3251-1012', 'APROVADO', '2025-05-02', '2025-05-03')
ON CONFLICT (email) DO NOTHING;

-- ── 2. PRODUTOS ──────────────────────────────────────────────
INSERT INTO produtos (nome, tipo, unidade_padrao) VALUES
  ('Cadeira de Escritório',     'ACABADO',       'un'),
  ('Mesa de Escritório',        'ACABADO',       'un'),
  ('Armário 2 Portas',          'ACABADO',       'un'),
  ('Estante 5 Prateleiras',     'ACABADO',       'un'),
  ('Gaveteiro 3 Gavetas',       'ACABADO',       'un'),
  ('Mesa de Reunião',           'ACABADO',       'un'),
  ('Balcão de Atendimento',     'ACABADO',       'un'),
  ('Poltrona Estofada',         'ACABADO',       'un'),
  ('Chapa MDF 15mm',            'MATERIA_PRIMA', 'un'),
  ('Chapa MDF 18mm',            'MATERIA_PRIMA', 'un'),
  ('Tubo de Aço',               'MATERIA_PRIMA', 'm'),
  ('Espuma D33',                'MATERIA_PRIMA', 'm'),
  ('Tecido Suede',              'MATERIA_PRIMA', 'm'),
  ('Rodízio Giratório',         'MATERIA_PRIMA', 'un'),
  ('Dobradiça',                 'MATERIA_PRIMA', 'un'),
  ('Corrediça Telescópica',     'MATERIA_PRIMA', 'un'),
  ('Parafuso Confirmat',        'MATERIA_PRIMA', 'un'),
  ('Verniz PU',                 'MATERIA_PRIMA', 'l'),
  ('Cola PVA',                  'MATERIA_PRIMA', 'kg')
ON CONFLICT (nome) DO NOTHING;

-- ── 3. BOM (quantidade de componente por unidade de acabado) ─
INSERT INTO bom (produto_pai_id, componente_id, quantidade_por_unidade)
SELECT pai.id, comp.id, v.q
FROM (VALUES
  ('Cadeira de Escritório', 'Tubo de Aço',           1.2000),
  ('Cadeira de Escritório', 'Espuma D33',            0.8000),
  ('Cadeira de Escritório', 'Tecido Suede',          1.0000),
  ('Cadeira de Escritório', 'Rodízio Giratório',     5.0000),
  ('Cadeira de Escritório', 'Parafuso Confirmat',    8.0000),
  ('Mesa de Escritório',    'Chapa MDF 15mm',        1.0000),
  ('Mesa de Escritório',    'Tubo de Aço',           2.4000),
  ('Mesa de Escritório',    'Parafuso Confirmat',   12.0000),
  ('Mesa de Escritório',    'Verniz PU',             0.3000),
  ('Armário 2 Portas',      'Chapa MDF 18mm',        3.0000),
  ('Armário 2 Portas',      'Dobradiça',             4.0000),
  ('Armário 2 Portas',      'Parafuso Confirmat',   20.0000),
  ('Armário 2 Portas',      'Cola PVA',              0.2000),
  ('Estante 5 Prateleiras', 'Chapa MDF 15mm',        2.5000),
  ('Estante 5 Prateleiras', 'Parafuso Confirmat',   16.0000),
  ('Estante 5 Prateleiras', 'Verniz PU',             0.4000),
  ('Gaveteiro 3 Gavetas',   'Chapa MDF 15mm',        1.5000),
  ('Gaveteiro 3 Gavetas',   'Corrediça Telescópica', 3.0000),
  ('Gaveteiro 3 Gavetas',   'Rodízio Giratório',     4.0000),
  ('Gaveteiro 3 Gavetas',   'Parafuso Confirmat',   14.0000),
  ('Mesa de Reunião',       'Chapa MDF 18mm',        2.0000),
  ('Mesa de Reunião',       'Tubo de Aço',           4.0000),
  ('Mesa de Reunião',       'Verniz PU',             0.6000),
  ('Mesa de Reunião',       'Parafuso Confirmat',   16.0000),
  ('Balcão de Atendimento', 'Chapa MDF 18mm',        4.0000),
  ('Balcão de Atendimento', 'Dobradiça',             2.0000),
  ('Balcão de Atendimento', 'Corrediça Telescópica', 2.0000),
  ('Balcão de Atendimento', 'Cola PVA',              0.3000),
  ('Poltrona Estofada',     'Espuma D33',            2.0000),
  ('Poltrona Estofada',     'Tecido Suede',          2.5000),
  ('Poltrona Estofada',     'Tubo de Aço',           1.5000),
  ('Poltrona Estofada',     'Cola PVA',              0.4000)
) AS v(pai, comp, q)
JOIN produtos pai  ON pai.nome  = v.pai
JOIN produtos comp ON comp.nome = v.comp
ON CONFLICT (produto_pai_id, componente_id) DO NOTHING;

-- ── 4. ESTOQUE INICIAL ───────────────────────────────────────
INSERT INTO estoque (produto_id, quantidade_atual)
SELECT id,
       CASE tipo
         WHEN 'ACABADO' THEN 40 + floor(random() * 160)
         ELSE 800 + floor(random() * 4200)
       END
FROM produtos
ON CONFLICT (produto_id) DO NOTHING;

-- ── 5. PEDIDOS (1000) + ITENS ────────────────────────────────
-- Período: mai/2025 a out/2026 (18 meses). Quantidades com tendência de
-- crescimento (~4% ao mês) e sazonalidade anual. Status: ~85% CONFIRMADO e
-- ~15% CANCELADO; em out/2026 (mês corrente) entram PENDENTES (~40%).
WITH cli AS (
  SELECT array_agg(id ORDER BY id) AS ids FROM clientes WHERE status = 'APROVADO'
),
base AS (
  SELECT g,
         floor(random() * 18)::int AS mes_off,
         random() AS r_status,
         random() AS r_cli,
         (5 + floor(random() * 25))::int AS lead_dias,
         random() * 12 AS hora,
         floor(random() * 28)::int AS dia
  FROM generate_series(1, 1000) g
),
datas AS (
  SELECT b.*,
         (DATE '2025-05-01' + b.mes_off * INTERVAL '1 month' + b.dia * INTERVAL '1 day')::date AS d
  FROM base b
),
novos AS (
  INSERT INTO pedidos (cliente_id, data_desejada, status, criado_em, atualizado_em)
  SELECT cli.ids[1 + floor(x.r_cli * array_length(cli.ids, 1))::int],
         x.d,
         CASE
           WHEN x.mes_off >= 17 THEN
             CASE WHEN x.r_status < 0.40 THEN 'PENDENTE'
                  WHEN x.r_status < 0.85 THEN 'CONFIRMADO'
                  ELSE 'CANCELADO' END
           ELSE
             CASE WHEN x.r_status < 0.85 THEN 'CONFIRMADO' ELSE 'CANCELADO' END
         END,
         (x.d - x.lead_dias)::timestamp + x.hora * INTERVAL '1 hour',
         (x.d - x.lead_dias)::timestamp + x.hora * INTERVAL '1 hour' + INTERVAL '1 day'
  FROM datas x CROSS JOIN cli
  RETURNING id, data_desejada, criado_em
)
INSERT INTO pedido_itens (pedido_id, produto_id, quantidade, unidade, criado_em)
SELECT n.id,
       pr.id,
       GREATEST(1, ROUND((15 + (pr.id * 13 % 45)) * n.fator * (0.5 + random())))::int,
       pr.unidade_padrao,
       n.criado_em
FROM (
  SELECT n0.*,
         (1 + 0.04 * ((EXTRACT(YEAR FROM n0.data_desejada) - 2025) * 12
                      + EXTRACT(MONTH FROM n0.data_desejada) - 5))
         * (1 + 0.2 * sin(2 * pi() * EXTRACT(MONTH FROM n0.data_desejada) / 12)) AS fator
  FROM novos n0
) n
CROSS JOIN LATERAL (
  SELECT p.id, p.unidade_padrao
  FROM produtos p
  WHERE p.tipo = 'ACABADO'
  ORDER BY random()
  LIMIT (1 + (n.id % 3))
) pr;

-- ── 6. DEMANDA (mesma lógica de src/demanda.js: pedidos CONFIRMADO por produto/mês) ─
DELETE FROM demanda;

INSERT INTO demanda (produto_id, periodo_inicio, quantidade, origem)
SELECT pi.produto_id,
       DATE_TRUNC('month', COALESCE(p.data_desejada, p.criado_em))::date,
       SUM(pi.quantidade),
       'PEDIDOS'
FROM pedido_itens pi
JOIN pedidos p ON p.id = pi.pedido_id
WHERE p.status = 'CONFIRMADO'
GROUP BY pi.produto_id, DATE_TRUNC('month', COALESCE(p.data_desejada, p.criado_em));

-- ── 7. FORECAST HISTÓRICO (média móvel de 3 meses da demanda) ─
-- ago/2025 a set/2026 = APROVADO; out e nov/2026 = PENDENTE.
-- quantidade_prevista = sugerida com ajuste do PCP de -8% a +8%.
INSERT INTO forecast (produto_id, periodo_inicio, quantidade_sugerida, quantidade_prevista,
                      status, criado_por, criado_em, atualizado_em)
SELECT s.produto_id,
       s.mes,
       s.sug,
       ROUND((s.sug * (0.92 + random() * 0.16))::numeric, 2),
       CASE WHEN s.mes < DATE '2026-10-01' THEN 'APROVADO' ELSE 'PENDENTE' END,
       (SELECT id FROM usuarios WHERE email = 'admin@flowprod.com'),
       (s.mes - INTERVAL '10 days')::timestamp,
       (s.mes - INTERVAL '8 days')::timestamp
FROM (
  SELECT p.id AS produto_id,
         m::date AS mes,
         COALESCE(ROUND(AVG(d.quantidade), 2), 0) AS sug
  FROM produtos p
  CROSS JOIN generate_series(DATE '2025-08-01', DATE '2026-11-01', INTERVAL '1 month') m
  LEFT JOIN demanda d
         ON d.produto_id = p.id
        AND d.periodo_inicio >= (m::date - INTERVAL '3 months')::date
        AND d.periodo_inicio <  m::date
  WHERE p.tipo = 'ACABADO'
  GROUP BY p.id, m
) s;

-- ── 8. CONFERÊNCIA ───────────────────────────────────────────
SELECT 'clientes' AS tabela, COUNT(*) AS registros FROM clientes
UNION ALL SELECT 'produtos',      COUNT(*) FROM produtos
UNION ALL SELECT 'bom',           COUNT(*) FROM bom
UNION ALL SELECT 'estoque',       COUNT(*) FROM estoque
UNION ALL SELECT 'pedidos',       COUNT(*) FROM pedidos
UNION ALL SELECT 'pedido_itens',  COUNT(*) FROM pedido_itens
UNION ALL SELECT 'demanda',       COUNT(*) FROM demanda
UNION ALL SELECT 'forecast',      COUNT(*) FROM forecast;

COMMIT;
