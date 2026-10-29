/* flowprod-shell.js — casca comum das telas internas (topbar, sessão, notificações,
   troca de módulo) + utilitários. Uso em cada página:
     FlowShell.init({ modulo:'FORECAST', titulo:'Forecast — Previsão de demanda', icone:'📊' })
       .then(() => iniciarPagina());
*/
(function () {
  const DEST  = { COMERCIAL:'/comercial.html', FORECAST:'/forecast.html', PAP:'/pap.html', PMP:'/pmp.html', MRP:'/mrp.html', ESTOQUE:'/estoque.html', COMPRA_PRODUCAO:'/compra-producao.html', ADMIN:'/admin.html' };
  const ICON  = { COMERCIAL:'🤝', FORECAST:'📊', PAP:'📐', PMP:'📋', MRP:'⚙️', ESTOQUE:'📦', COMPRA_PRODUCAO:'🏭', ADMIN:'🛠️' };
  const LABEL = { COMERCIAL:'Comercial', FORECAST:'Forecast', PAP:'PAP', PMP:'PMP', MRP:'MRP', ESTOQUE:'Estoque', COMPRA_PRODUCAO:'Compra/Produção', ADMIN:'Admin' };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const fmt = (n, casas = 2) => Number(n || 0).toLocaleString('pt-BR', { maximumFractionDigits: casas });
  const MESES = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
  const rotuloMes = (p) => { const [a, m] = String(p).slice(0, 7).split('-'); return `${MESES[parseInt(m, 10) - 1]} de ${a}`; };
  const mesAtual = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };

  // Período escolhido fica salvo para acompanhar o usuário entre os módulos
  function lerPeriodo() { try { return localStorage.getItem('flowprod_periodo') || mesAtual(); } catch { return mesAtual(); } }
  function salvarPeriodo(p) { try { localStorage.setItem('flowprod_periodo', p); } catch {} }

  async function api(caminho, { metodo = 'GET', corpo } = {}) {
    const r = await fetch(caminho, {
      method: metodo, credentials: 'include',
      headers: corpo ? { 'Content-Type': 'application/json' } : undefined,
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    if (r.status === 401) { window.location.href = '/'; throw new Error('Sessão expirada.'); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.erro || 'Erro na requisição.');
    return d;
  }

  function toast(msg, tipo) {
    let box = document.getElementById('toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
    const el = document.createElement('div');
    el.className = 'toast ' + (tipo === 'erro' ? 'erro-t' : tipo === 'ok' ? 'ok-t' : '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), tipo === 'erro' ? 6000 : 3500);
  }

  const Shell = { usuario: null, modulo: null, podeEscrever: false, esc, fmt, rotuloMes, mesAtual, lerPeriodo, salvarPeriodo, api, toast, DEST, aoReceberNotificacao: null };
  window.FlowShell = Shell;


  // Executa uma ação de botão: bloqueia o botão, mostra aviso de sucesso/erro e recarrega a tela
  Shell.executar = async function (btn, fn, mensagemOk, recarregar) {
    if (btn) btn.disabled = true;
    try {
      const d = await fn();
      const msg = typeof mensagemOk === 'function' ? mensagemOk(d) : (mensagemOk || (d && d.mensagem));
      if (msg) toast(msg, 'ok');
      if (recarregar) await recarregar();
    } catch (e) {
      toast(e.message, 'erro');
      if (btn) btn.disabled = false;
    }
  };

  // Evita recarregar a tela por notificação enquanto o usuário digita em algum campo
  Shell.digitando = () => !!(document.activeElement && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName));

  Shell.init = async function ({ modulo, titulo, icone }) {
    Shell.modulo = modulo;
    document.title = 'FlowProd — ' + titulo;
    const alvo = document.getElementById('shell-topbar');
    alvo.className = 'topbar';
    alvo.innerHTML = `
      <div class="topbar-left"><span class="logo">FlowProd</span><div class="divider"></div><span class="page-title">${esc(titulo)}</span></div>
      <div class="topbar-right">
        <div class="notif-wrap">
          <button class="notif-bell" id="btnNotif" title="Notificações">🔔<span class="notif-count" id="notifCount"></span></button>
          <div class="notif-panel" id="notifPanel">
            <div class="notif-header"><span>🔔 Notificações</span><button class="notif-mark" id="btnMarcar">Marcar lidas</button></div>
            <div id="notifLista"></div>
          </div>
        </div>
        <div id="moduleSwitcher">
          <div class="mod-current"><span>${icone} ${esc(LABEL[modulo])}</span></div>
          <button class="mod-arrow-btn" id="btnMod" title="Trocar módulo">▾</button>
          <div class="mod-dropdown" id="moduleDropdown"></div>
        </div>
        <div class="user-info"><div class="user-avatar" id="avatar">?</div><span class="user-name" id="userName">Carregando...</span></div>
        <button class="btn-logout" id="btnSair">Sair</button>
      </div>`;

    let u;
    try {
      const r = await fetch('/api/me', { credentials: 'include', headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error();
      u = (await r.json()).usuario;
    } catch { window.location.href = '/'; return new Promise(() => {}); }
    const funcoes = u.funcoes || [u.funcao];
    if (!funcoes.includes(modulo) && !funcoes.includes('ADMIN')) { window.location.href = '/'; return new Promise(() => {}); }
    Shell.usuario = u;
    Shell.funcoes = funcoes;
    Shell.podeEscrever = true; // a rota da página já exige o módulo (ou ADMIN)
    document.getElementById('userName').textContent = u.nome;
    document.getElementById('avatar').textContent = u.nome.charAt(0).toUpperCase();

    // Troca de módulo
    const outros = funcoes.filter(f => f !== modulo && DEST[f]);
    const sw = document.getElementById('moduleSwitcher');
    sw.style.display = outros.length ? 'flex' : 'none';
    const dd = document.getElementById('moduleDropdown');
    document.getElementById('btnMod').onclick = (e) => {
      e.stopPropagation();
      const abrir = dd.style.display !== 'block';
      dd.style.display = 'none';
      if (abrir) {
        dd.innerHTML = outros.map(f => `<a class="mod-item" href="${DEST[f]}">${ICON[f] || '🔧'} ${esc(LABEL[f] || f)}</a>`).join('');
        dd.style.display = 'block';
      }
    };
    document.getElementById('btnSair').onclick = async () => {
      await fetch('/api/logout', { method: 'POST', credentials: 'include' });
      window.location.href = '/';
    };

    // Notificações
    const painel = document.getElementById('notifPanel');
    let aberto = false;
    const carregar = async () => {
      try {
        const d = await api('/api/notificacoes');
        const lista = d.notificacoes || [];
        const el = document.getElementById('notifLista');
        if (!lista.length) { el.innerHTML = '<div class="notif-vazia">Sem notificações</div>'; return; }
        el.innerHTML = lista.map(n => {
          const diff = Date.now() - new Date(n.criado_em).getTime();
          const min = Math.floor(diff / 60000), h = Math.floor(diff / 3600000), dias = Math.floor(diff / 86400000);
          const tempo = min < 1 ? 'agora' : min < 60 ? `há ${min}min` : h < 24 ? `há ${h}h` : `há ${dias}d`;
          return `<div class="notif-item ${n.lida ? '' : 'nao-lida'}"><div class="notif-dot ${n.lida ? 'lida' : ''}"></div>
            <div style="flex:1"><div class="notif-titulo">${esc(n.titulo)}</div>
            ${n.mensagem ? `<div class="notif-msg">${esc(n.mensagem).replace(/\n/g, '<br>')}</div>` : ''}
            <div class="notif-tempo">${tempo}</div></div></div>`;
        }).join('');
      } catch {}
    };
    const badge = async () => {
      try {
        const d = await api('/api/notificacoes/nao-lidas/contagem');
        const b = document.getElementById('notifCount');
        if (d.total > 0) { b.textContent = d.total > 9 ? '9+' : d.total; b.style.display = 'inline-flex'; }
        else b.style.display = 'none';
      } catch {}
    };
    document.getElementById('btnNotif').onclick = (e) => {
      e.stopPropagation();
      aberto = !aberto;
      painel.style.display = aberto ? 'block' : 'none';
      if (aberto) carregar();
    };
    painel.onclick = (e) => e.stopPropagation();
    document.getElementById('btnMarcar').onclick = async () => {
      try { await api('/api/notificacoes/marcar-lidas', { metodo: 'POST' }); } catch {}
      document.getElementById('notifCount').style.display = 'none';
      carregar();
    };
    document.addEventListener('click', () => {
      dd.style.display = 'none';
      if (aberto) { painel.style.display = 'none'; aberto = false; }
    });
    badge();
    setInterval(badge, 30000);

    // Tempo real (SSE): atualiza o sino e avisa a página para recarregar seus dados
    if (typeof EventSource !== 'undefined') {
      const conectar = () => {
        const es = new EventSource('/api/notificacoes/stream', { withCredentials: true });
        es.addEventListener('message', () => {
          badge();
          if (aberto) carregar();
          if (typeof Shell.aoReceberNotificacao === 'function') Shell.aoReceberNotificacao();
        });
        es.addEventListener('error', () => { es.close(); setTimeout(conectar, 5000); });
      };
      conectar();
    }
    return u;
  };
})();
