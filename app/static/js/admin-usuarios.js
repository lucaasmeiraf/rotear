(function () {
  "use strict";
  const { api, toast, carregando, copiar, gerarSenha, dadosDaPagina } = window.Rotear;
  const inicial = dadosDaPagina("dados");
  let usuarios = inicial.usuarios;
  const eu = inicial.eu;

  const lista = document.getElementById("lista");
  const tpl = document.getElementById("tpl-linha");

  function badge(texto, tipo) {
    const b = document.createElement("span");
    b.className = "badge " + (tipo || "");
    b.textContent = texto;
    return b;
  }

  function render() {
    lista.replaceChildren();
    const ativos = usuarios.filter((u) => u.ativo).length;
    document.getElementById("resumo").textContent =
      `${ativos} ativo${ativos === 1 ? "" : "s"} · ${usuarios.length} no total`;
    for (const u of usuarios) {
      const li = tpl.content.firstElementChild.cloneNode(true);
      li.querySelector("[data-inicial]").textContent = (u.nome[0] || "?").toUpperCase();
      li.querySelector("[data-nome]").textContent = u.nome + (u.id === eu ? " (você)" : "");
      li.querySelector("[data-email]").textContent = u.email;
      const badges = li.querySelector("[data-badges]");
      badges.append(u.papel === "admin" ? badge("Administrador", "brand") : badge("Operador"));
      badges.append(u.ativo ? badge("Ativo", "ok") : badge("Inativo", "danger"));
      if (u.bloqueado) badges.append(badge("Bloqueado por tentativas", "warn"));
      if (!u.ativo) li.style.opacity = ".65";

      const bStatus = li.querySelector('[data-acao="status"]');
      const ico = document.getElementById(u.ativo ? "ico-bloquear" : "ico-reativar").content.cloneNode(true);
      bStatus.append(ico);
      bStatus.title = u.ativo ? "Desativar" : "Reativar";
      bStatus.setAttribute("aria-label", bStatus.title);
      if (u.id === eu) bStatus.disabled = true;
      bStatus.addEventListener("click", () => abrirStatus(u));
      li.querySelector('[data-acao="senha"]').addEventListener("click", () => abrirSenha(u));
      lista.append(li);
    }
  }

  function atualizar(u) {
    usuarios = usuarios.map((x) => (x.id === u.id ? u : x));
    if (!usuarios.some((x) => x.id === u.id)) usuarios.push(u);
    usuarios.sort((a, b) => (b.ativo - a.ativo) || a.nome.localeCompare(b.nome, "pt-BR"));
    render();
  }

  // Botões gerar/copiar senha dentro dos formulários
  document.querySelectorAll("form").forEach((form) => {
    const campo = form.querySelector('input[name="senha"]');
    if (!campo) return;
    form.querySelector("[data-gerar]").addEventListener("click", () => { campo.value = gerarSenha(14); });
    form.querySelector("[data-copiar]").addEventListener("click", () => campo.value && copiar(campo.value));
  });

  // Novo usuário
  const dlgNovo = document.getElementById("dlg-novo");
  const formNovo = document.getElementById("form-novo");
  document.getElementById("btn-novo").addEventListener("click", () => {
    formNovo.reset();
    formNovo.senha.value = gerarSenha(14);
    dlgNovo.showModal();
    formNovo.nome.focus();
  });
  formNovo.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const dados = Object.fromEntries(new FormData(formNovo));
    carregando(ev.submitter, async () => {
      try {
        const u = await api("POST", "/api/admin/usuarios", dados);
        atualizar(u);
        dlgNovo.close();
        toast(`${u.nome} foi adicionado.`);
      } catch (e) { toast(e.message, "erro"); }
    });
  });

  // Redefinir senha
  const dlgSenha = document.getElementById("dlg-senha");
  const formSenha = document.getElementById("form-senha");
  let alvoSenha = null;
  function abrirSenha(u) {
    alvoSenha = u;
    formSenha.reset();
    formSenha.senha.value = gerarSenha(14);
    document.getElementById("senha-quem").textContent = `${u.nome} · ${u.email}`;
    dlgSenha.showModal();
  }
  formSenha.addEventListener("submit", (ev) => {
    ev.preventDefault();
    carregando(ev.submitter, async () => {
      try {
        const u = await api("POST", `/api/admin/usuarios/${alvoSenha.id}/senha`, { senha: formSenha.senha.value });
        atualizar(u);
        dlgSenha.close();
        toast("Senha redefinida.");
      } catch (e) { toast(e.message, "erro"); }
    });
  });

  // Desativar / reativar
  const dlgStatus = document.getElementById("dlg-status");
  const btnStatusOk = document.getElementById("btn-status-ok");
  let alvoStatus = null;
  function abrirStatus(u) {
    alvoStatus = u;
    document.getElementById("t-status").textContent = u.ativo ? "Desativar usuário?" : "Reativar usuário?";
    document.getElementById("status-texto").textContent = u.ativo
      ? `${u.nome} não poderá mais entrar, e as sessões abertas serão encerradas. Você pode reativar depois.`
      : `${u.nome} poderá entrar de novo com a senha atual.`;
    btnStatusOk.lastElementChild.textContent = u.ativo ? "Desativar" : "Reativar";
    btnStatusOk.className = "btn " + (u.ativo ? "danger" : "primary");
    dlgStatus.showModal();
  }
  btnStatusOk.addEventListener("click", () => {
    carregando(btnStatusOk, async () => {
      try {
        const u = await api("PATCH", `/api/admin/usuarios/${alvoStatus.id}`, { ativo: !alvoStatus.ativo });
        atualizar(u);
        dlgStatus.close();
        toast(u.ativo ? `${u.nome} foi reativado.` : `${u.nome} foi desativado.`);
      } catch (e) { toast(e.message, "erro"); }
    });
  });

  render();
})();
