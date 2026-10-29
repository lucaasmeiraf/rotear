// Utilitários compartilhados: toasts, chamadas à API, diálogos e cópia.
(function () {
  "use strict";

  function toast(mensagem, tipo) {
    const area = document.getElementById("toasts");
    if (!area) return;
    const el = document.createElement("div");
    el.className = "toast" + (tipo === "erro" ? " erro" : "");
    el.setAttribute("role", tipo === "erro" ? "alert" : "status");
    el.textContent = mensagem;
    area.appendChild(el);
    setTimeout(() => { el.classList.add("saindo"); setTimeout(() => el.remove(), 220); }, tipo === "erro" ? 5000 : 2800);
  }

  async function api(metodo, url, corpo) {
    const opcoes = { method: metodo, headers: { "Accept": "application/json" }, credentials: "same-origin" };
    if (corpo instanceof FormData) {
      opcoes.body = corpo;
    } else if (corpo !== undefined) {
      opcoes.headers["Content-Type"] = "application/json";
      opcoes.body = JSON.stringify(corpo);
    }
    const resp = await fetch(url, opcoes);
    if (resp.status === 401) { window.location.href = "/login"; throw new Error("Sessão expirada."); }
    const tipo = resp.headers.get("content-type") || "";
    const dados = tipo.includes("application/json") ? await resp.json() : null;
    if (!resp.ok) {
      let msg = "Algo deu errado. Tente novamente.";
      if (dados && typeof dados.detail === "string") msg = dados.detail;
      else if (dados && Array.isArray(dados.detail) && dados.detail[0]) msg = dados.detail[0].msg || msg;
      const erro = new Error(msg);
      erro.status = resp.status;
      throw erro;
    }
    return dados;
  }

  // Botão com estado de carregamento enquanto a promessa roda
  async function carregando(botao, fn) {
    botao.classList.add("loading");
    botao.disabled = true;
    try { return await fn(); } finally { botao.classList.remove("loading"); botao.disabled = false; }
  }

  async function copiar(texto) {
    try {
      await navigator.clipboard.writeText(texto);
    } catch {
      const area = document.createElement("textarea");
      area.value = texto; area.style.position = "fixed"; area.style.opacity = "0";
      document.body.appendChild(area); area.select(); document.execCommand("copy"); area.remove();
    }
    toast("Copiado!");
  }

  function gerarSenha(tamanho) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    const buf = new Uint32Array(tamanho || 14);
    crypto.getRandomValues(buf);
    return Array.from(buf, (n) => chars[n % chars.length]).join("");
  }

  function dadosDaPagina(id) {
    const el = document.getElementById(id);
    return el ? JSON.parse(el.textContent) : null;
  }

  // Fecha <dialog> ao tocar fora dele e em botões [data-fechar]
  document.addEventListener("click", (ev) => {
    const alvo = ev.target;
    if (alvo instanceof HTMLDialogElement) alvo.close();
    const fechar = alvo.closest && alvo.closest("[data-fechar]");
    if (fechar) fechar.closest("dialog").close();
  });

  const fmt = {
    num: (v, casas) => Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: casas || 0, maximumFractionDigits: casas || 0 }),
    km: (m) => (Number(m || 0) / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " km",
    duracao: (s) => {
      s = Math.round(Number(s || 0) / 60);
      const h = Math.floor(s / 60), m = s % 60;
      return h ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
    },
    dataHora: (iso) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
  };

  window.Rotear = { toast, api, carregando, copiar, gerarSenha, dadosDaPagina, fmt };
})();
