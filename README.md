# FlowProd

Sistema web de Planejamento e Controle da Produção (PCP) — Trabalho de Conclusão de Curso.

Fluxo de módulos: **Comercial → Demanda → Forecast → PAP → PMP → MRP → Compra/Produção**, com Estoque (saldos e BOM) alimentando o planejamento, um cadastro mestre de produtos e controle de acesso por função (RBAC).

### Fluxo do planejamento

| Etapa | O que o sistema faz sozinho | O que o responsável decide |
|-------|-----------------------------|----------------------------|
| Pedido → Demanda | recalcula a demanda a cada confirmação/cancelamento | confirmar ou cancelar o pedido (Comercial) |
| Demanda → Forecast | sugere a quantidade (média móvel dos 3 meses anteriores) | disparar o cálculo, ajustar e aprovar (Forecast) |
| Forecast → PAP | sugere produção = forecast − estoque do acabado | montar o PAP, ajustar e aprovar (PAP) |
| PAP → PMP | gera 4 semanas iguais ao aprovar o PAP | redistribuir entre semanas e aprovar (PMP) |
| PMP → MRP | explode pelo BOM e abate o estoque (100% automático) | — |
| MRP → Compra/Produção | cria as ordens sugeridas | aprovar (ajustando a quantidade), executar e concluir (Compra/Produção) |

Ao concluir uma ordem, o saldo do produto recebe a entrada automaticamente. Mudanças de estoque, de BOM ou de PMP recalculam o MRP.

## Estrutura de pastas

```
flowprod/
├── server.js                        ← servidor principal (rotas HTML + montagem da API)
├── package.json                     ← dependências
├── .env.example                     ← modelo de variáveis de ambiente
├── flowprod_banco.sql               ← script completo de criação do banco (schema + seed do admin)
├── render.yaml                      ← configuração de deploy no Render
├── DEPLOY.md                        ← passo a passo de deploy (Render + Neon)
├── GUIA_RAPIDO_SSE.md               ← guia rápido do sistema de notificações em tempo real
├── NOTIFICACOES_SSE.md              ← arquitetura das notificações SSE
├── TESTE_PRATICO_SSE.md             ← roteiro de teste das notificações
│
├── src/
│   ├── db.js                        ← conexão com PostgreSQL (local ou Neon via DATABASE_URL)
│   ├── demanda.js                   ← reconstrução da tabela demanda a partir dos pedidos confirmados
│   ├── forecast.js                  ← sugestão de forecast (média móvel de 3 meses)
│   ├── pmp.js                       ← desagregação do PAP em 4 semanas
│   ├── mrp.js                       ← explosão de necessidades (PMP → BOM → estoque) e ordens sugeridas
│   ├── estoque.js                   ← movimentação de saldo (entrada/saída/ajuste)
│   ├── fluxo.js                     ← utilitários compartilhados (transação, validações, notificações por função)
│   ├── email.js                     ← envio de e-mails (nodemailer)
│   ├── notificar.js                 ← disparo de notificações (SSE + e-mail)
│   ├── sse.js                       ← conexões Server-Sent Events
│   ├── controllers/
│   │   ├── authController.js        ← login, logout, /api/me
│   │   ├── senhaController.js       ← recuperação/redefinição de senha
│   │   └── usuariosController.js    ← gestão de usuários
│   ├── middlewares/
│   │   ├── auth.js                  ← autenticar (JWT) e autorizarFuncao (RBAC)
│   │   └── rateLimiter.js           ← bloqueio por tentativas de login
│   └── routes/
│       ├── auth.js, usuarios.js, senha.js
│       ├── pedidos.js, produtos.js, demanda.js, clientes.js
│       ├── forecast.js, pap.js, pmp.js, mrp.js, compra-producao.js
│       ├── estoque.js, bom.js           ← saldo/movimentações e estrutura de produto
│       ├── colaborador.js, solicitacoes-executor.js, convites.js
│       ├── notificacoes.js, alertas.js, logs.js
│       └── teste.js                 ← endpoint de teste das notificações SSE
│
└── public/
    ├── css/flowprod-app.css         ← estilos compartilhados das telas de PCP
    ├── js/flowprod-shell.js         ← topbar, sessão, notificações e utilitários das telas de PCP
    ├── index.html                   ← landing page
    ├── login.html                   ← login de colaborador
    ├── cliente.html                 ← portal do cliente (pedidos)
    ├── pedido.html                  ← detalhe/criação de pedido
    ├── solicitar-acesso.html        ← solicitação de acesso self-service (novos colaboradores)
    ├── primeiro-acesso.html         ← definição de senha no primeiro acesso
    ├── colaborador.html             ← menu do colaborador com múltiplas funções
    ├── admin.html                   ← painel administrativo (usuários, solicitações, convites)
    ├── comercial.html, forecast.html, pap.html, pmp.html,
    │   mrp.html, estoque.html, compra-producao.html   ← uma tela por módulo
    ├── painel-alertas.html          ← alertas do sistema
    ├── manutencao.html              ← tela exibida ao usuário durante manutenção
    └── painel-manutencao.html       ← painel para ativar/desativar o modo manutenção
```

---

## Módulos e funções (RBAC)

Cada usuário tem uma ou mais funções (`funcoes`, array), que definem quais telas e rotas ele acessa:

| Função            | Tela                    |
|--------------------|--------------------------|
| ADMIN              | `/admin.html`            |
| COMERCIAL          | `/comercial.html`        |
| FORECAST           | `/forecast.html`         |
| PAP                | `/pap.html`               |
| PMP                | `/pmp.html`               |
| MRP                | `/mrp.html`               |
| ESTOQUE            | `/estoque.html`          |
| COMPRA_PRODUCAO    | `/compra-producao.html`  |

Usuário com uma função só é redirecionado direto ao logar; com mais de uma, vê um menu (`colaborador.html`) para escolher a tela.

---

## Rodando localmente

### Pré-requisitos

1. **Node.js** — https://nodejs.org/pt-br
2. **PostgreSQL** — https://www.postgresql.org/download
3. **DBeaver** (opcional, para ver o banco visualmente) — https://dbeaver.io

### Passo 1 — Instalar dependências

```bash
npm install
```

### Passo 2 — Criar o banco local

Crie o banco e rode o script completo:

```sql
CREATE DATABASE flowprod;
```

Depois conecte nele e execute todo o conteúdo de `flowprod_banco.sql` — ele recria todas as tabelas do zero e já insere um usuário ADMIN inicial:

- **E-mail:** `admin@flowprod.com`
- **Senha:** `Admin@123`

### Passo 3 — Configurar o `.env`

Copie o modelo e preencha:

```bash
cp .env.example .env
```

Variáveis principais:

```env
# Banco local (não preencher se for usar DATABASE_URL do Neon)
DB_HOST=localhost
DB_PORT=5432
DB_NAME=flowprod
DB_USER=postgres
DB_PASSWORD=sua_senha_do_postgres

PORT=3000
NODE_ENV=development
APP_URL=http://localhost:3000

# JWT
JWT_SECRET=gerar_uma_chave_longa
JWT_EXPIRES_IN=8h

# E-mail (Gmail — usado para notificações e recuperação de senha)
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_SECURE=false
EMAIL_USER=seu_email@gmail.com
EMAIL_PASS=senha_de_app_do_gmail
EMAIL_ADMIN=email_que_recebe_notificacoes

# Painel de manutenção
MANUTENCAO_SENHA=defina_uma_senha
```

Gere o `JWT_SECRET` com:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

`EMAIL_PASS` precisa ser uma **senha de app** do Gmail (não a senha normal da conta) — gerada em myaccount.google.com/apppasswords.

### Passo 4 — Iniciar o servidor

```bash
npm start
```

Ou com recarga automática:

```bash
npm run dev
```

No terminal:

```
✅ PostgreSQL conectado — 🏠 Local (desenvolvimento)
🚀 FlowProd rodando em http://localhost:3000
```

### Passo 5 — Acessar

http://localhost:3000, login com `admin@flowprod.com` / `Admin@123`.

---

## Deploy em produção (Render + Neon)

Stack gratuita: **Render** hospeda o Node.js, **Neon** hospeda o PostgreSQL.

Resumo (passo a passo completo em `DEPLOY.md`):

1. **Neon** (neon.tech) → criar projeto `flowprod` → copiar a *connection string* → rodar `flowprod_banco.sql` nela via DBeaver. (Em um banco que já tem dados, rode `migration_etapa_2_3_a_2_8.sql` em vez do script completo: ele preserva usuários, clientes, produtos e pedidos.)
2. **GitHub** → subir o repositório (o `.env` está no `.gitignore`, nunca sobe).
3. **Render** (render.com) → New Web Service → conectar o repositório → `render.yaml` já define build (`npm install`) e start (`npm start`).
4. No painel do Render, preencher as variáveis marcadas como `sync: false` no `render.yaml`:

   | Variável | Valor |
   |----------|-------|
   | `DATABASE_URL` | connection string do Neon |
   | `APP_URL` | URL que o Render atribuir, ex: `https://flowprod.onrender.com` |
   | `EMAIL_USER` / `EMAIL_PASS` / `EMAIL_ADMIN` | credenciais de e-mail |
   | `MANUTENCAO_SENHA` | senha do painel de manutenção |

   `JWT_SECRET` é gerado automaticamente pelo Render (`generateValue: true`).

5. Deploy automático a cada `git push` na branch `main`.

**Limitação do plano free:** o servidor dorme após 15 min sem acesso e leva ~1 min para acordar — acesse o link com antecedência antes de uma apresentação.

Health check: `/api/health` → `{"ok":true}`.

---

## Painel de manutenção

- `/manutencao` — tela exibida a todos os usuários enquanto o modo manutenção está ativo (rota liberada mesmo durante o bloqueio).
- `/painel-manutencao` — painel para ativar/desativar, protegido pela senha em `MANUTENCAO_SENHA`.

---

## Notificações em tempo real (SSE)

O sistema notifica os usuários via Server-Sent Events (login, aprovações, alertas etc.). Detalhes:

- `NOTIFICACOES_SSE.md` — arquitetura
- `GUIA_RAPIDO_SSE.md` — guia rápido de uso
- `TESTE_PRATICO_SSE.md` — roteiro de teste manual

---

## Cadastro de novos colaboradores

O cadastro não é mais manual via banco: o próprio colaborador solicita acesso.

1. Colaborador acessa `/solicitar-acesso.html` e preenche o pedido (nome, e-mail, função desejada).
2. ADMIN vê a solicitação pendente em `/admin.html` e aprova ou recusa.
3. Aprovado, o colaborador recebe acesso e define a senha em `/primeiro-acesso.html`.

---

## Como o login funciona (resumo técnico)

```
Navegador                    Servidor Node.js              PostgreSQL
    |                              |                            |
    |-- POST /api/login ---------->|                            |
    |   { email, senha }           |-- SELECT * FROM usuarios ->|
    |                              |<-- usuário encontrado -----|
    |                              |   (comparação direta,      |
    |                              |    sem hash — modo teste)  |
    |<-- { redirecionar, token } --|                            |
    |   + cookie httpOnly com JWT  |                            |
    |                              |                            |
    |-- GET /forecast.html ------->|                            |
    |   (envia cookie JWT)         |-- verifica JWT + funcao ---|
    |<-- forecast.html ------------|                            |
```

> A senha ainda é comparada em texto puro (`src/controllers/authController.js`) — modo de teste do TCC, não usar assim em produção real.
