// Planejamento em 2 telas (endereços -> rotas). Tudo fica só na memória desta página: nada é salvo.
// Os endereços são localizados em segundo plano e nunca bloqueiam o cálculo: exato = pino cheio, aproximado =
// pino vazado, não localizado = entra no fim da rota e o Google Maps acha pelo texto.
(function () {
  "use strict";
  const { api, toast, carregando, copiar, fmt } = window.Rotear;
  const { criarMapa, pino } = window.RotearMapa;

  // Paleta categórica validada (ordem fixa) contra o fundo claro dos tiles do OSM.
  // Do 9º motorista em diante a cor se repete com traço tracejado (codificação composta).
  const CORES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
  const TINTA_SOBRE = { "#eda100": "#0b0b0b" }; // texto escuro sobre o amarelo
  const COR_PARTIDA = "#0e1726";
  const CAMPOS = [
    ["endereco", "Endereço", true], ["numero", "Número"], ["complemento", "Complemento"], ["bairro", "Bairro"],
    ["cidade", "Cidade"], ["uf", "UF"], ["cep", "CEP"], ["referencia", "Cliente / referência"], ["telefone", "Telefone"], ["pedido", "Pedido"],
    ["volumes", "Volumes"], ["observacoes", "Observações"],
  ];
  // Dados de contato que acompanham a parada (nunca entram no texto enviado à geocodificação)
  const EXTRAS = ["complementos", "telefones", "pedidos", "observacoes"];

  const $ = (id) => document.getElementById(id);
  const icone = (nome) => $("tpl-ico-" + nome).content.cloneNode(true);
  const corDe = (i) => CORES[i % CORES.length];
  const tracoDe = (i) => (i < CORES.length ? null : i < CORES.length * 2 ? "10 8" : "2 7");

  const estado = {
    passo: 1,
    config: null,
    partida: null, // {lat, lng, precisao_m, endereco}
    paradas: [], // {id, texto, referencias[], complementos[], telefones[], pedidos[], observacoes[], volumes, linhas, geo}
    planilha: null,
    motoristas: [{ nome: "" }],
    resultado: null,
  };
  let proximoId = 1;

  // ---------------------------------------------------------------- navegação (1 = endereços, 2 = rotas)
  const btnAvancar = $("btn-avancar"), txtAvancar = $("btn-avancar-texto");

  function irPara(passo) {
    estado.passo = passo;
    document.querySelectorAll(".passo").forEach((s) => s.classList.toggle("ativo", Number(s.dataset.passo) === passo));
    window.scrollTo({ top: 0, behavior: "smooth" });
    requestAnimationFrame(() => { if (passo === 2 && mapaResultado) mapaResultado.invalidateSize(); });
    atualizarAcoes();
  }

  function atualizarAcoes() {
    const p = estado.passo;
    $("acoes").classList.toggle("hidden", p === 2);
    const temTexto = !!$("texto-colado").value.trim();
    let texto = "Calcular rotas";
    if (!estado.partida) texto = estado.config && estado.config.modo_partida === "endereco_fixo" ? "Partida não configurada" : "Aguardando localização";
    btnAvancar.disabled = !estado.partida || (!estado.paradas.length && !temTexto);
    txtAvancar.textContent = texto;
  }

  btnAvancar.addEventListener("click", () => calcular());

  // Aviso ao sair: o planejamento não é salvo
  window.addEventListener("beforeunload", (ev) => {
    if (estado.paradas.length || estado.resultado) { ev.preventDefault(); ev.returnValue = ""; }
  });

  // ---------------------------------------------------------------- 1. partida
  let dicaTimer = null;

  function pedirLocalizacao() {
    const btn = $("btn-gps");
    $("gps-negado").classList.add("hidden");
    $("gps-erro").classList.add("hidden");
    $("gps-dica").classList.add("hidden");
    if (!window.isSecureContext) {
      // Sem https o navegador recusa a localização sem perguntar: explicar a causa real
      $("gps-status").textContent = "Não é possível usar a localização neste endereço.";
      $("gps-inseguro").classList.remove("hidden");
      btn.classList.add("hidden");
      return;
    }
    if (!("geolocation" in navigator)) {
      $("gps-erro-texto").textContent = "Este navegador não oferece localização. Use outro navegador ou peça ao administrador um endereço fixo.";
      $("gps-erro").classList.remove("hidden");
      return;
    }
    btn.classList.add("loading"); btn.disabled = true;
    $("gps-status").textContent = "Aguardando a sua permissão para usar a localização…";
    clearTimeout(dicaTimer);
    // Se a pergunta não aparecer (alguns navegadores a escondem na barra de endereço), mostra a dica e libera o botão
    dicaTimer = setTimeout(() => {
      $("gps-dica").classList.remove("hidden");
      btn.classList.remove("loading"); btn.disabled = false;
    }, 4000);
    navigator.geolocation.getCurrentPosition((pos) => {
      clearTimeout(dicaTimer); $("gps-dica").classList.add("hidden");
      btn.classList.remove("loading"); btn.disabled = false;
      const { latitude, longitude, accuracy } = pos.coords;
      estado.partida = { lat: latitude, lng: longitude, precisao_m: accuracy };
      const m = Math.round(accuracy);
      const badge = $("gps-precisao");
      badge.textContent = `± ${fmt.num(m)} m`;
      badge.className = "badge " + (m <= 50 ? "ok" : m <= 200 ? "warn" : "danger");
      $("gps-status").textContent = m <= 200
        ? "Saída: sua localização atual."
        : "Saída: sua localização atual, com pouca precisão. Se puder, ligue o GPS e toque em Atualizar.";
      btn.querySelector("span:last-child").textContent = "Atualizar";
      btn.classList.add("ghost");
      atualizarAcoes();
    }, (erro) => {
      clearTimeout(dicaTimer); $("gps-dica").classList.add("hidden");
      btn.classList.remove("loading"); btn.disabled = false;
      estado.partida = null;
      atualizarAcoes();
      if (erro.code === erro.PERMISSION_DENIED) {
        $("gps-status").textContent = "Saída: precisamos da sua localização para calcular as rotas.";
        $("gps-negado").classList.remove("hidden");
        btn.querySelector("span:last-child").textContent = "Tentar novamente";
      } else {
        $("gps-erro-texto").textContent = erro.code === erro.TIMEOUT
          ? "A localização demorou demais. Verifique se o GPS está ligado e tente de novo."
          : "Não foi possível obter a localização. Tente de novo.";
        $("gps-erro").classList.remove("hidden");
      }
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  }
  $("btn-gps").addEventListener("click", pedirLocalizacao);

  // ---------------------------------------------------------------- 2. endereços
  const chave = (t) => t.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").replace(/^[\s,;.-]+|[\s,;.-]+$/g, "");

  function adicionar(itens) {
    const limite = estado.config.max_paradas;
    const porChave = new Map(estado.paradas.map((p) => [chave(p.texto), p]));
    let novas = 0, agrupadas = 0, cortadas = 0;
    for (const it of itens) {
      const texto = it.texto.replace(/\s+/g, " ").trim();
      if (!texto) continue;
      const k = chave(texto);
      const existente = porChave.get(k);
      if (existente) {
        existente.linhas += 1;
        if (it.referencia) existente.referencias.push(it.referencia);
        if (it.volumes) existente.volumes = (existente.volumes || 0) + it.volumes;
        for (const k of EXTRAS) {
          const v = it[k];
          if (v && !existente[k].includes(v)) existente[k].push(v);
        }
        agrupadas++;
        continue;
      }
      if (estado.paradas.length >= limite) { cortadas++; continue; }
      const p = { id: proximoId++, texto: texto.slice(0, 300), referencias: it.referencia ? [it.referencia] : [],
        volumes: it.volumes || null, linhas: 1, geo: null };
      for (const k of EXTRAS) p[k] = it[k] ? [it[k]] : [];
      estado.paradas.push(p);
      porChave.set(k, p);
      novas++;
    }
    renderParadas();
    localizarPendentes();
    const partes = [];
    if (novas) partes.push(`${novas} parada${novas > 1 ? "s" : ""} adicionada${novas > 1 ? "s" : ""}`);
    if (agrupadas) partes.push(`${agrupadas} repetida${agrupadas > 1 ? "s" : ""} agrupada${agrupadas > 1 ? "s" : ""}`);
    if (partes.length) toast(partes.join(" · "));
    if (cortadas) toast(`Limite de ${limite} paradas por planejamento: ${cortadas} endereço(s) ficaram de fora.`, "erro");
    if (!novas && !agrupadas && !cortadas) toast("Nenhum endereço encontrado.", "erro");
  }

  function renderParadas() {
    const ul = $("lista-paradas");
    ul.replaceChildren();
    const n = estado.paradas.length;
    const linhas = estado.paradas.reduce((s, p) => s + p.linhas, 0);
    $("resumo-paradas").textContent = n
      ? `${n} parada${n > 1 ? "s" : ""}${linhas > n ? ` (${linhas} linhas, repetidas agrupadas)` : ""}`
      : "Nenhum endereço ainda.";
    $("btn-limpar").classList.toggle("hidden", !n);
    if (!n) {
      const li = document.createElement("li");
      li.className = "lista-vazia";
      li.textContent = "Adicione endereços por planilha, colando uma lista ou digitando.";
      ul.append(li);
    }
    estado.paradas.forEach((p, i) => {
      const li = document.createElement("li");
      li.className = "list-row";
      const num = document.createElement("span"); num.className = "num"; num.textContent = i + 1;
      const box = document.createElement("div"); box.className = "grow";
      const t = document.createElement("div"); t.className = "title"; t.textContent = p.texto;
      const meta = [];
      if (p.complementos.length) meta.push(p.complementos.join(" · "));
      if (p.referencias.length) meta.push(p.referencias.join(", "));
      if (p.pedidos.length) meta.push("Pedido " + p.pedidos.join(", "));
      if (p.volumes) meta.push(`${p.volumes} vol.`);
      if (p.linhas > 1) meta.push(`${p.linhas} linhas`);
      box.append(t);
      if (meta.length) { const m = document.createElement("div"); m.className = "meta"; m.textContent = meta.join(" · "); box.append(m); }
      const rm = document.createElement("button");
      rm.className = "btn ghost sm icon-only"; rm.type = "button"; rm.title = "Remover"; rm.setAttribute("aria-label", "Remover " + p.texto);
      rm.append(icone("lixeira"));
      rm.addEventListener("click", () => { removerParada(p.id); renderParadas(); });
      li.append(num, box, rm);
      ul.append(li);
    });
    atualizarAcoes();
  }

  function removerParada(id) {
    estado.paradas = estado.paradas.filter((p) => p.id !== id);
  }

  $("btn-limpar").addEventListener("click", () => {
    estado.paradas = [];
    renderParadas();
  });

  document.querySelectorAll('input[name="fonte"]').forEach((r) => r.addEventListener("change", () => {
    document.querySelectorAll(".fonte").forEach((f) => f.classList.toggle("hidden", f.dataset.fonte !== r.value));
  }));

  // Colar e digitar
  function usarColado() {
    const linhas = $("texto-colado").value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!linhas.length) return;
    adicionar(linhas.map((texto) => ({ texto })));
    $("texto-colado").value = "";
    atualizarAcoes();
  }
  $("btn-usar-colado").addEventListener("click", usarColado);
  $("texto-colado").addEventListener("input", atualizarAcoes);
  $("form-manual").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const campo = $("texto-manual");
    if (!campo.value.trim()) return;
    adicionar([{ texto: campo.value }]);
    campo.value = "";
    campo.focus();
  });

  // Planilha: upload, mapeamento de colunas e prévia
  const entradaArquivo = $("arquivo"), dropzone = $("dropzone");
  async function enviarArquivo(arquivo) {
    if (!arquivo) return;
    if (arquivo.size > 5 * 1024 * 1024) { toast("O arquivo passa de 5 MB.", "erro"); return; }
    if (!/\.(xlsx|csv)$/i.test(arquivo.name)) { toast("Envie um arquivo .xlsx ou .csv.", "erro"); return; }
    const fd = new FormData();
    fd.append("arquivo", arquivo);
    dropzone.classList.add("arrastando");
    try {
      const r = await api("POST", "/api/entrada/arquivo", fd);
      estado.planilha = { nome: arquivo.name, ...r };
      renderMapeamento();
    } catch (e) { toast(e.message, "erro"); } finally { dropzone.classList.remove("arrastando"); entradaArquivo.value = ""; }
  }
  entradaArquivo.addEventListener("change", () => enviarArquivo(entradaArquivo.files[0]));
  ["dragenter", "dragover"].forEach((t) => dropzone.addEventListener(t, (ev) => { ev.preventDefault(); dropzone.classList.add("arrastando"); }));
  ["dragleave", "drop"].forEach((t) => dropzone.addEventListener(t, (ev) => { ev.preventDefault(); dropzone.classList.remove("arrastando"); }));
  dropzone.addEventListener("drop", (ev) => enviarArquivo(ev.dataTransfer.files[0]));
  $("btn-trocar-arquivo").addEventListener("click", () => entradaArquivo.click());

  function valorCampo(linha, mapa, campo) {
    const i = mapa[campo];
    return i === null || i === undefined || i === "" ? "" : (linha[i] || "").trim();
  }

  // Texto enviado à geocodificação: endereço, número, bairro, cidade - UF (sem complemento, CEP ou nome)
  function montarTexto(linha, mapa) {
    const v = (c) => valorCampo(linha, mapa, c);
    let base = v("endereco");
    if (!base) return "";
    if (v("numero") && !base.includes(v("numero"))) base += ", " + v("numero");
    const partes = [base];
    if (v("bairro")) partes.push(v("bairro"));
    const cidade = [v("cidade"), v("uf")].filter(Boolean).join(" - ");
    if (cidade) partes.push(cidade);
    return partes.join(", ");
  }

  function mapaAtual() {
    const mapa = {};
    document.querySelectorAll("#map-campos select").forEach((s) => { mapa[s.name] = s.value === "" ? null : Number(s.value); });
    return mapa;
  }

  function renderMapeamento() {
    const pl = estado.planilha;
    dropzone.classList.add("hidden"); $("modelo-dica").classList.add("hidden");
    $("mapeamento").classList.remove("hidden");
    $("map-arquivo").textContent = pl.nome;
    $("map-linhas").textContent = `${fmt.num(pl.linhas.length)} linha(s) de dados · ${pl.colunas.length} coluna(s)`;
    const box = $("map-campos");
    box.replaceChildren();
    for (const [campo, rotulo, obrig] of CAMPOS) {
      const label = document.createElement("label"); label.className = "field";
      const span = document.createElement("span"); span.textContent = rotulo + (obrig ? " *" : "");
      const sel = document.createElement("select"); sel.name = campo;
      const vazio = document.createElement("option"); vazio.value = ""; vazio.textContent = obrig ? "Escolha a coluna" : "Não usar";
      sel.append(vazio);
      pl.colunas.forEach((c, i) => { const o = document.createElement("option"); o.value = i; o.textContent = c; sel.append(o); });
      if (pl.sugestao[campo] !== null && pl.sugestao[campo] !== undefined) sel.value = pl.sugestao[campo];
      sel.addEventListener("change", renderPrevia);
      label.append(span, sel);
      box.append(label);
    }
    renderPrevia();
  }

  function renderPrevia() {
    const mapa = mapaAtual();
    const ol = $("map-previa");
    ol.replaceChildren();
    const exemplos = estado.planilha.linhas.map((l) => montarTexto(l, mapa)).filter(Boolean).slice(0, 3);
    for (const t of exemplos) { const li = document.createElement("li"); li.textContent = t; ol.append(li); }
    if (!exemplos.length) { const li = document.createElement("li"); li.textContent = "Escolha a coluna do endereço."; ol.append(li); }
    const validos = estado.planilha.linhas.filter((l) => montarTexto(l, mapa)).length;
    $("btn-usar-planilha").disabled = mapa.endereco === null;
    $("btn-usar-planilha").querySelector("span").textContent = `Adicionar ${fmt.num(validos)} endereço(s)`;
  }

  $("btn-usar-planilha").addEventListener("click", () => {
    const mapa = mapaAtual();
    const itens = estado.planilha.linhas.map((l) => {
      const vol = parseInt(valorCampo(l, mapa, "volumes").replace(/\D/g, ""), 10);
      return {
        texto: montarTexto(l, mapa),
        complementos: valorCampo(l, mapa, "complemento"),
        referencia: valorCampo(l, mapa, "referencia"),
        telefones: valorCampo(l, mapa, "telefone"),
        pedidos: valorCampo(l, mapa, "pedido"),
        observacoes: valorCampo(l, mapa, "observacoes"),
        volumes: Number.isFinite(vol) ? vol : null,
      };
    });
    adicionar(itens);
    estado.planilha = null;
    $("mapeamento").classList.add("hidden");
    dropzone.classList.remove("hidden"); $("modelo-dica").classList.remove("hidden");
  });

  // ---------------------------------------------------------------- localização em segundo plano
  // Começa assim que há endereços novos; o cálculo só espera o que ainda faltar. Nada aqui pede ação da operadora.
  let geoRodada = null, controle = null;
  const geoProgresso = { feitos: 0, total: 0, externos: 0 };
  const temPosicao = (p) => !!(p.geo && p.geo.encontrado && p.geo.nivel !== "fora_da_area");
  const exata = (p) => temPosicao(p) && p.geo.precisao === "alta";

  function localizarPendentes() {
    if (geoRodada || !estado.config.geocodificacao_ativa) return geoRodada || Promise.resolve();
    geoRodada = (async () => {
      try {
        for (;;) {
          const faltando = estado.paradas.filter((p) => !p.geo);
          if (!faltando.length) break;
          if (!(await localizarLote(faltando))) break; // sem progresso: não insiste
        }
      } catch (e) {
        if (e.name !== "AbortError") console.warn("Localização interrompida:", e.message);
      } finally {
        geoRodada = null; controle = null;
        renderGeoStatus();
      }
    })();
    return geoRodada;
  }

  async function localizarLote(faltando) {
    Object.assign(geoProgresso, { feitos: 0, total: faltando.length, externos: 0 });
    renderGeoStatus();
    controle = new AbortController();
    const resp = await fetch("/api/geocodificar", {
      method: "POST", credentials: "same-origin", signal: controle.signal,
      headers: { "Content-Type": "application/json", "Accept": "application/x-ndjson" },
      body: JSON.stringify({ enderecos: faltando.map((p) => p.texto) }),
    });
    if (resp.status === 401) { window.location.href = "/login"; return false; }
    if (!resp.ok) throw new Error("Não foi possível localizar os endereços.");
    const leitor = resp.body.getReader();
    const dec = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await leitor.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const linha = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!linha) continue;
        const ev = JSON.parse(linha);
        if (ev.tipo === "inicio") geoProgresso.externos = ev.pendentes;
        else if (ev.tipo === "resultado") {
          const p = faltando[ev.indice];
          if (p) p.geo = ev;
          geoProgresso.feitos++;
          if (!ev.de_cache) geoProgresso.externos = Math.max(0, geoProgresso.externos - 1);
          renderGeoStatus();
        } else if (ev.tipo === "erro") throw new Error(ev.mensagem);
      }
    }
    return geoProgresso.feitos > 0;
  }

  function renderGeoStatus() {
    const el = $("geo-status");
    const ativo = !!geoRodada && geoProgresso.total > 0;
    el.classList.toggle("hidden", !ativo);
    if (ativo) el.querySelector("span:last-child").textContent =
      `Preparando o mapa… ${geoProgresso.feitos} de ${geoProgresso.total}`;
    atualizarOverlayGeo();
  }

  // ---------------------------------------------------------------- motoristas
  function renderMotoristas() {
    $("mot-qtd").textContent = estado.motoristas.length;
    $("mot-menos").disabled = estado.motoristas.length <= 1;
    $("mot-mais").disabled = estado.motoristas.length >= 20;
    const box = $("mot-nomes");
    box.replaceChildren();
    estado.motoristas.forEach((m, i) => {
      const label = document.createElement("label"); label.className = "field";
      const s = document.createElement("span");
      s.innerHTML = `<i style="display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;background:${corDe(i)}"></i>`;
      s.append(document.createTextNode(`Motorista ${i + 1}`));
      const inp = document.createElement("input"); inp.type = "text"; inp.maxLength = 60; inp.placeholder = "Nome (opcional)"; inp.value = m.nome;
      inp.addEventListener("input", () => { m.nome = inp.value; });
      label.append(s, inp);
      box.append(label);
    });
  }
  $("mot-menos").addEventListener("click", () => { if (estado.motoristas.length > 1) estado.motoristas.pop(); renderMotoristas(); });
  $("mot-mais").addEventListener("click", () => { if (estado.motoristas.length < 20) estado.motoristas.push({ nome: "" }); renderMotoristas(); });

  // ---------------------------------------------------------------- cálculo
  const MENSAGENS = ["Calculando distâncias reais pelas ruas…", "Dividindo as paradas entre os motoristas…",
    "Agrupando endereços próximos…", "Testando combinações para encurtar o trajeto…", "Refinando a ordem das entregas…"];

  const ANEL = 326.7;
  let overlayAberto = false, timerCalculo = null;

  function abrirOverlay() {
    overlayAberto = true;
    $("calculando").classList.remove("hidden");
    $("anel").style.transition = "none"; $("anel").style.strokeDashoffset = ANEL;
    requestAnimationFrame(() => { $("anel").style.transition = ""; });
  }

  function fecharOverlay() {
    overlayAberto = false;
    clearInterval(timerCalculo);
    $("calculando").classList.add("hidden");
  }

  // Fase 1 (só se faltar algo): localizar endereços novos. O serviço gratuito permite 1 consulta por segundo.
  function atualizarOverlayGeo() {
    if (!overlayAberto || !geoRodada) return;
    const { feitos, total, externos } = geoProgresso;
    $("calc-titulo").textContent = "Localizando endereços";
    $("calc-msg").textContent = `${feitos} de ${total} · endereços já usados antes são instantâneos`;
    $("calc-seg").textContent = Math.max(1, Math.ceil(externos * 1.1));
    $("anel").style.strokeDashoffset = ANEL * (1 - (total ? feitos / total : 0));
  }

  // Fase 2: otimizar. Mesmas faixas de app/roteamento/solver.py (FAIXAS_TEMPO_S).
  function tempoOtimizador(n) {
    return Math.min(n <= 15 ? 1 : n <= 40 ? 5 : Infinity, estado.config.solver_tempo_limite_s);
  }

  function faseOtimizar(segundos) {
    let passados = 0;
    $("calc-titulo").textContent = "Otimizando as rotas";
    $("calc-seg").textContent = segundos;
    $("calc-msg").textContent = MENSAGENS[0];
    $("anel").style.strokeDashoffset = ANEL;
    clearInterval(timerCalculo);
    timerCalculo = setInterval(() => {
      passados++;
      $("calc-seg").textContent = Math.max(0, segundos - passados);
      $("anel").style.strokeDashoffset = ANEL * (1 - Math.min(1, passados / segundos));
      $("calc-msg").textContent = passados >= segundos ? "Finalizando…" : MENSAGENS[Math.floor(passados / Math.max(1, segundos / MENSAGENS.length)) % MENSAGENS.length];
    }, 1000);
  }

  async function calcular() {
    usarColado(); // o que estiver colado e ainda não adicionado entra também
    if (!estado.paradas.length || !estado.partida) return;
    abrirOverlay();
    try {
      if (estado.paradas.some((p) => !p.geo)) {
        atualizarOverlayGeo();
        await localizarPendentes();
      }
      faseOtimizar(tempoOtimizador(estado.paradas.filter(temPosicao).length));
      const maxInp = $("max-por-motorista").value.trim();
      const corpo = {
        partida: estado.config.modo_partida === "localizacao_atual" ? { lat: estado.partida.lat, lng: estado.partida.lng } : null,
        paradas: estado.paradas.map((p) => (temPosicao(p) ? { lat: p.geo.lat, lng: p.geo.lng, endereco: p.texto } : { endereco: p.texto })),
        motoristas: estado.motoristas.map((m) => ({ nome: m.nome })),
        max_por_motorista: maxInp ? Number(maxInp) : null,
        fim: document.querySelector('input[name="fim"]:checked').value,
      };
      estado.resultado = await api("POST", "/api/calcular", corpo);
      fecharOverlay();
      renderResultado();
      irPara(2);
    } catch (e) {
      fecharOverlay();
      toast(e.message, "erro");
    }
  }

  // ---------------------------------------------------------------- 2. resultado
  let mapaResultado = null, camadaResultado = null;

  function ordinal(n) { return `${n}ª entrega`; }

  function descreverTrecho(t, total) {
    const de = t.de === 0 ? "Partida" : ordinal(t.de);
    const ate = t.volta_a_partida ? "volta à partida" : ordinal(t.ate);
    return `${de} → ${ate}`;
  }

  function textoWhatsApp(m, idx) {
    const linhas = [`*Rota de ${m.nome}*`, `${m.paradas.length} entrega(s) · ${fmt.km(m.distancia_m)} · cerca de ${fmt.duracao(m.duracao_s)}`, "",
      "Abra no aplicativo Google Maps para manter a ordem das paradas.", ""];
    m.trechos.forEach((t, i) => { linhas.push(`*Trecho ${i + 1}* (${descreverTrecho(t)}):`, t.url, ""); });
    linhas.push("*Paradas*");
    m.paradas.forEach((pi, i) => {
      const p = estado.paradas[pi];
      linhas.push(`${i + 1}. ${[p.texto, ...p.complementos].join(" · ")}`);
      const info = [p.referencias.join(", "), p.telefones.join(" / "), p.pedidos.length ? "Pedido " + p.pedidos.join(", ") : "",
        p.volumes ? `${p.volumes} vol.` : ""].filter(Boolean);
      if (info.length) linhas.push("   " + info.join(" · "));
      if (p.observacoes.length) linhas.push("   Obs.: " + p.observacoes.join(" / "));
    });
    return linhas.join("\n").trim();
  }

  // Telefones da célula em dígitos com DDI 55 (para tel: e wa.me). Número sem DDD herda o DDD do anterior (ou 61).
  function telefonesBR(texto) {
    const lista = [];
    let ddd = "61";
    for (const parte of texto.split(/[\/;|,]| ou | e /)) {
      let d = parte.replace(/\D/g, "").replace(/^0+/, "");
      if (d.startsWith("55") && (d.length === 12 || d.length === 13)) d = d.slice(2);
      if (d.length === 8 || d.length === 9) d = ddd + d;
      if (d.length !== 10 && d.length !== 11) continue;
      ddd = d.slice(0, 2);
      lista.push({ numero: "55" + d, celular: d.length === 11 && d[2] === "9" });
    }
    return lista;
  }

  function botaoContato(href, rotulo, nomeIcone, extraClasse) {
    const a = document.createElement("a"); a.className = "btn sm " + (extraClasse || ""); a.href = href;
    if (href.startsWith("http")) { a.target = "_blank"; a.rel = "noopener"; }
    a.append(icone(nomeIcone)); a.append(document.createTextNode(rotulo));
    return a;
  }

  function stat(rotulo, valor, dica) {
    const d = document.createElement("div"); d.className = "card stat";
    d.innerHTML = '<div class="label"></div><div class="value"></div>' + (dica ? '<div class="hint"></div>' : "");
    d.querySelector(".label").textContent = rotulo;
    d.querySelector(".value").textContent = valor;
    if (dica) d.querySelector(".hint").textContent = dica;
    return d;
  }

  function renderResultado() {
    const r = estado.resultado;
    const paradas = estado.paradas;
    const alocadas = r.motoristas.reduce((s, m) => s + m.paradas.length, 0);
    const usados = r.motoristas.filter((m) => m.paradas.length).length;
    const semMapa = new Set(r.sem_posicao || []);
    $("res-stats").replaceChildren(
      stat("Paradas nas rotas", fmt.num(alocadas), r.nao_alocadas.length ? `${r.nao_alocadas.length} não alocada(s)` : "todas alocadas"),
      stat("Distância total", fmt.km(r.km_total * 1000), semMapa.size ? `sem contar ${semMapa.size} fora do mapa` : ""),
      stat("Tempo de direção", fmt.duracao(r.tempo_total_s), "estimado pelas ruas"),
      stat("Motoristas", `${usados} de ${r.motoristas.length}`, `cálculo em ${fmt.num(r.tempo_calculo_ms / 1000, 0)} s`),
    );

    // Mapa
    if (!mapaResultado) mapaResultado = criarMapa("mapa-resultado");
    if (camadaResultado) camadaResultado.remove();
    camadaResultado = L.layerGroup().addTo(mapaResultado);
    const limites = [[r.partida.lat, r.partida.lng]];
    r.motoristas.forEach((m, mi) => {
      if (!m.linha.length) return; // sem nenhuma parada com posição: nada a desenhar
      const cor = corDe(mi), traco = tracoDe(mi);
      L.polyline(m.linha, { color: "#ffffff", weight: 8, opacity: 0.9 }).addTo(camadaResultado); // contorno (contraste)
      L.polyline(m.linha, { color: cor, weight: 4.5, opacity: 1, dashArray: traco }).addTo(camadaResultado)
        .bindTooltip(m.nome, { className: "rotulo", sticky: true });
      m.linha.forEach((pt) => limites.push(pt));
      m.paradas.forEach((pi, ordem) => {
        const p = paradas[pi];
        if (semMapa.has(pi)) return; // só na lista e no link: o Google Maps acha pelo texto
        const aprox = !exata(p);
        const icon = L.divIcon({ className: "pino" + (aprox ? " aprox" : ""), iconSize: [26, 26], iconAnchor: [13, 13],
          html: `<span style="--cor:${cor};width:26px;height:26px;color:${aprox ? cor : TINTA_SOBRE[cor] || "#fff"}">${ordem + 1}</span>` });
        L.marker([p.geo.lat, p.geo.lng], { icon }).addTo(camadaResultado)
          .bindTooltip(`${m.nome} · ${ordem + 1}ª: ${p.texto}${aprox ? " (posição aproximada)" : ""}`,
            { className: "rotulo", direction: "top", offset: [0, -12] });
      });
    });
    L.marker([r.partida.lat, r.partida.lng], { icon: pino(COR_PARTIDA, "", { tamanho: 24 }), zIndexOffset: 1000 })
      .addTo(camadaResultado).bindTooltip("Partida", { className: "rotulo", direction: "top", offset: [0, -12] });
    requestAnimationFrame(() => { mapaResultado.invalidateSize(); mapaResultado.fitBounds(limites, { padding: [24, 24] }); });

    // Cartões por motorista
    const box = $("res-motoristas");
    box.replaceChildren();
    r.motoristas.forEach((m, mi) => {
      const card = document.createElement("article"); card.className = "card motorista";
      const topo = document.createElement("div"); topo.className = "motorista-topo";
      const cor = document.createElement("span"); cor.className = "motorista-cor"; cor.style.background = corDe(mi);
      if (tracoDe(mi)) cor.style.backgroundImage = "repeating-linear-gradient(180deg, transparent 0 6px, rgba(255,255,255,.85) 6px 9px)";
      const g = document.createElement("div"); g.className = "grow";
      const h = document.createElement("h3"); h.textContent = m.nome;
      const met = document.createElement("div"); met.className = "metricas-mot";
      met.innerHTML = "<span></span><span></span><span></span>";
      met.children[0].textContent = `${m.paradas.length} parada(s)`;
      met.children[1].textContent = fmt.km(m.distancia_m);
      met.children[2].textContent = fmt.duracao(m.duracao_s);
      g.append(h, met);
      topo.append(cor, g);
      card.append(topo);

      if (!m.paradas.length) {
        const v = document.createElement("div"); v.className = "bloco subtle"; v.textContent = "Nenhuma parada para este motorista.";
        card.append(v); box.append(card); return;
      }

      const bloco = document.createElement("div"); bloco.className = "bloco";
      m.trechos.forEach((t, ti) => {
        const linha = document.createElement("div"); linha.className = "trecho";
        const txt = document.createElement("div"); txt.className = "grow";
        txt.innerHTML = '<div class="t1"></div><div class="t2"></div>';
        txt.children[0].textContent = `Trecho ${ti + 1}`;
        txt.children[1].textContent = descreverTrecho(t);
        const abrir = document.createElement("a"); abrir.className = "btn sm"; abrir.href = t.url; abrir.target = "_blank"; abrir.rel = "noopener";
        abrir.append(icone("mapa")); abrir.append(document.createTextNode("Abrir"));
        const cp = document.createElement("button"); cp.type = "button"; cp.className = "btn sm icon-only"; cp.title = "Copiar link";
        cp.setAttribute("aria-label", `Copiar link do trecho ${ti + 1}`); cp.append(icone("copiar"));
        cp.addEventListener("click", () => copiar(t.url));
        linha.append(txt, abrir, cp);
        bloco.append(linha);
      });
      const dica = document.createElement("p"); dica.className = "dica-app";
      dica.append(icone("pino")); dica.append(document.createTextNode("Abra no aplicativo Google Maps para manter a ordem das paradas."));
      bloco.append(dica);
      const wa = document.createElement("a"); wa.className = "btn block mt-16"; wa.target = "_blank"; wa.rel = "noopener";
      wa.href = "https://wa.me/?text=" + encodeURIComponent(textoWhatsApp(m, mi));
      wa.style.cssText = "background:#25d366;color:#06301a;border-color:transparent";
      wa.append(icone("msg")); wa.append(document.createTextNode("Enviar no WhatsApp"));
      bloco.append(wa);
      card.append(bloco);

      const det = document.createElement("details"); det.className = "ordem";
      const sum = document.createElement("summary"); sum.textContent = "Ordem das paradas";
      const ol = document.createElement("ol");
      m.paradas.forEach((pi) => {
        const p = paradas[pi];
        const li = document.createElement("li"); li.textContent = p.texto;
        if (semMapa.has(pi) || !exata(p)) {
          const tag = document.createElement("span"); tag.className = "tag-posicao";
          tag.textContent = semMapa.has(pi) ? "fora do mapa" : "aproximado";
          tag.title = "O link do Google Maps leva ao endereço escrito.";
          li.append(" ", tag);
        }
        const extra = [...p.complementos, ...p.referencias].filter(Boolean);
        if (p.pedidos.length) extra.push("Pedido " + p.pedidos.join(", "));
        if (p.volumes) extra.push(`${p.volumes} vol.`);
        if (extra.length) { const s = document.createElement("small"); s.textContent = extra.join(" · "); li.append(s); }
        if (p.observacoes.length) {
          const o = document.createElement("small"); o.className = "obs"; o.textContent = "Obs.: " + p.observacoes.join(" / "); li.append(o);
        }
        const tels = p.telefones.flatMap(telefonesBR);
        const celular = tels.find((t) => t.celular);
        if (tels.length) {
          const acoes = document.createElement("div"); acoes.className = "contato";
          acoes.append(botaoContato("tel:+" + (celular || tels[0]).numero, "Ligar", "telefone"));
          if (celular) acoes.append(botaoContato("https://wa.me/" + celular.numero, "WhatsApp", "msg", "whats"));
          li.append(acoes);
        } else if (p.telefones.length) {
          const t = document.createElement("small"); t.textContent = "Tel.: " + p.telefones.join(" / "); li.append(t);
        }
        ol.append(li);
      });
      det.append(sum, ol);
      card.append(det);
      box.append(card);
    });

    // Não alocadas
    const na = $("lista-nao-alocadas");
    na.replaceChildren();
    $("res-nao-alocadas").classList.toggle("hidden", !r.nao_alocadas.length);
    for (const item of r.nao_alocadas) {
      const li = document.createElement("li"); li.className = "list-row";
      li.innerHTML = '<div class="grow"><div class="title"></div><div class="meta"></div></div>';
      li.querySelector(".title").textContent = paradas[item.indice].texto;
      li.querySelector(".meta").textContent = item.motivo;
      na.append(li);
    }
  }

  $("btn-exportar").addEventListener("click", (ev) => {
    const r = estado.resultado, paradas = estado.paradas;
    const semMapa = new Set(r.sem_posicao || []);
    const corpo = {
      motoristas: r.motoristas.map((m) => ({
        nome: m.nome, distancia_m: m.distancia_m, duracao_s: m.duracao_s,
        paradas: m.paradas.map((pi) => {
          const p = paradas[pi];
          return { endereco: [p.texto, ...p.complementos].join(" · ").slice(0, 400), referencia: p.referencias.join(", ").slice(0, 200),
            telefone: p.telefones.join(" / ").slice(0, 60), pedido: p.pedidos.join(", ").slice(0, 100),
            observacoes: p.observacoes.join(" / ").slice(0, 300),
            volumes: p.volumes ? String(p.volumes) : "",
            lat: semMapa.has(pi) ? null : p.geo.lat, lng: semMapa.has(pi) ? null : p.geo.lng };
        }),
        trechos: m.trechos.map((t) => ({ url: t.url })),
      })),
      nao_alocadas: r.nao_alocadas.map((n) => ({ endereco: paradas[n.indice].texto, motivo: n.motivo })),
    };
    carregando(ev.currentTarget, async () => {
      try {
        const resp = await fetch("/api/exportar/xlsx", { method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) });
        if (!resp.ok) throw new Error("Não foi possível gerar a planilha.");
        const blob = await resp.blob();
        const nome = (resp.headers.get("content-disposition") || "").match(/filename="([^"]+)"/);
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob); a.download = nome ? nome[1] : "rotas.xlsx";
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      } catch (e) { toast(e.message, "erro"); }
    });
  });

  $("btn-novo").addEventListener("click", () => $("dlg-novo").showModal());
  $("btn-novo-ok").addEventListener("click", () => {
    if (controle) controle.abort();
    estado.paradas = [];
    estado.resultado = null;
    if (camadaResultado) camadaResultado.remove();
    $("dlg-novo").close();
    renderParadas();
    irPara(1);
  });

  // ---------------------------------------------------------------- início
  async function iniciar() {
    try {
      estado.config = await api("GET", "/api/planejamento/config");
    } catch (e) { toast(e.message, "erro"); return; }
    const c = estado.config;
    if (c.modo_partida === "endereco_fixo") {
      $("partida-fixa").classList.remove("hidden");
      if (c.partida) {
        estado.partida = c.partida;
        $("partida-fixa-texto").textContent = c.partida.endereco;
      } else {
        $("partida-fixa-texto").textContent = "O administrador ainda não definiu o endereço de partida.";
      }
    } else {
      $("partida-gps").classList.remove("hidden");
      pedirLocalizacao(); // pede a permissão logo ao abrir
      // Quando a pessoa libera a permissão nas configurações do navegador, segue sem recarregar
      if (navigator.permissions && navigator.permissions.query) {
        navigator.permissions.query({ name: "geolocation" }).then((st) => {
          st.onchange = () => { if (st.state === "granted" && !estado.partida) pedirLocalizacao(); };
        }).catch(() => {});
      }
    }
    if (!c.geocodificacao_ativa) toast("A localização de endereços está desativada pelo administrador.", "erro");
    renderParadas();
    renderMotoristas();
    irPara(1);
  }
  iniciar();
})();
