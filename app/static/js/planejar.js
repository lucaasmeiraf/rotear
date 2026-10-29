// Assistente de planejamento. Tudo fica só na memória desta página: nada é salvo.
(function () {
  "use strict";
  const { api, toast, carregando, copiar, fmt } = window.Rotear;
  const { criarMapa, pino } = window.RotearMapa;

  // Paleta categórica validada (ordem fixa) contra o fundo claro dos tiles do OSM.
  // Do 9º motorista em diante a cor se repete com traço tracejado (codificação composta).
  const CORES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
  const TINTA_SOBRE = { "#eda100": "#0b0b0b" }; // texto escuro sobre o amarelo
  const COR_OK = "#1baf7a", COR_ATENCAO = "#eda100", COR_MANUAL = "#3056f5", COR_PARTIDA = "#0e1726";
  const NIVEL_TEXTO = { rua: "Só a rua foi encontrada", bairro: "Só o bairro foi encontrado", cidade: "Só a cidade foi encontrada",
    fora_da_area: "Fora da área atendida (DF e entorno)" };
  const CAMPOS = [
    ["endereco", "Endereço", true], ["numero", "Número"], ["complemento", "Complemento"], ["bairro", "Bairro"],
    ["cidade", "Cidade"], ["uf", "UF"], ["cep", "CEP"], ["referencia", "Nome / referência"], ["volumes", "Volumes"],
  ];

  const $ = (id) => document.getElementById(id);
  const icone = (nome) => $("tpl-ico-" + nome).content.cloneNode(true);
  const corDe = (i) => CORES[i % CORES.length];
  const tracoDe = (i) => (i < CORES.length ? null : i < CORES.length * 2 ? "10 8" : "2 7");

  const estado = {
    passo: 1,
    config: null,
    partida: null, // {lat, lng, precisao_m, endereco}
    paradas: [], // {id, texto, exibicao, referencias[], volumes, linhas, geo, status}
    planilha: null,
    motoristas: [{ nome: "" }],
    resultado: null,
  };
  let proximoId = 1;

  // ---------------------------------------------------------------- navegação
  const btnVoltar = $("btn-voltar"), btnAvancar = $("btn-avancar"), txtAvancar = $("btn-avancar-texto");

  function irPara(passo) {
    if (passo === 3 && estado.passo !== 3) iniciarGeocodificacao();
    estado.passo = passo;
    document.querySelectorAll(".passo").forEach((s) => s.classList.toggle("ativo", Number(s.dataset.passo) === passo));
    document.querySelectorAll("#stepper li").forEach((li) => {
      const n = Number(li.dataset.passo);
      li.classList.toggle("atual", n === passo);
      li.classList.toggle("feito", n < passo);
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
    requestAnimationFrame(() => {
      if (passo === 1 && mapaPartida) mapaPartida.invalidateSize();
      if (passo === 3 && mapaConferir) { mapaConferir.invalidateSize(); enquadrarConferir(); }
      if (passo === 4) renderMotoristas();
      if (passo === 5 && mapaResultado) mapaResultado.invalidateSize();
    });
    atualizarAcoes();
  }

  function atualizarAcoes() {
    const p = estado.passo;
    btnVoltar.classList.toggle("hidden", p === 1 || p === 5);
    btnAvancar.classList.toggle("hidden", p === 5);
    $("acoes").classList.toggle("hidden", p === 5);
    let pode = true, texto = "Continuar";
    if (p === 1) pode = !!estado.partida;
    if (p === 2) { pode = estado.paradas.length > 0; texto = "Localizar endereços"; }
    if (p === 3) {
      const pend = pendencias();
      pode = !geoRodando && estado.paradas.length > 0 && pend.length === 0 && estado.paradas.every((x) => x.geo);
      texto = pend.length ? `Resolva ${pend.length} pendência${pend.length > 1 ? "s" : ""}` : "Continuar";
    }
    if (p === 4) texto = "Calcular rotas";
    btnAvancar.disabled = !pode;
    txtAvancar.textContent = texto;
  }

  btnVoltar.addEventListener("click", () => {
    if (estado.passo === 3) cancelarGeocodificacao();
    irPara(Math.max(1, estado.passo - 1));
  });
  btnAvancar.addEventListener("click", () => {
    if (estado.passo === 4) return calcular();
    irPara(estado.passo + 1);
  });

  // Aviso ao sair: o planejamento não é salvo
  window.addEventListener("beforeunload", (ev) => {
    if (estado.paradas.length || estado.resultado) { ev.preventDefault(); ev.returnValue = ""; }
  });

  // ---------------------------------------------------------------- 1. partida
  let mapaPartida = null, marcadorPartida = null, circuloPartida = null;

  function mostrarPartidaNoMapa(lat, lng, precisao) {
    $("mapa-partida").classList.remove("hidden");
    if (!mapaPartida) mapaPartida = criarMapa("mapa-partida");
    mapaPartida.invalidateSize();
    const ll = [lat, lng];
    if (!marcadorPartida) {
      marcadorPartida = L.marker(ll, { icon: pino(COR_PARTIDA, "", { tamanho: 26 }), keyboard: false }).addTo(mapaPartida);
    } else marcadorPartida.setLatLng(ll);
    if (precisao) {
      if (!circuloPartida) circuloPartida = L.circle(ll, { radius: precisao, color: COR_MANUAL, weight: 1.5, fillOpacity: 0.12 }).addTo(mapaPartida);
      else circuloPartida.setLatLng(ll).setRadius(precisao);
      mapaPartida.fitBounds(circuloPartida.getBounds(), { maxZoom: 17, padding: [24, 24] });
    } else {
      mapaPartida.setView(ll, 16);
    }
  }

  function pedirLocalizacao() {
    const btn = $("btn-gps");
    $("gps-negado").classList.add("hidden");
    $("gps-erro").classList.add("hidden");
    if (!("geolocation" in navigator)) {
      $("gps-erro-texto").textContent = "Este navegador não oferece localização. Use outro navegador ou peça ao administrador um endereço fixo.";
      $("gps-erro").classList.remove("hidden");
      return;
    }
    btn.classList.add("loading"); btn.disabled = true;
    $("gps-status").textContent = "Obtendo a sua localização…";
    navigator.geolocation.getCurrentPosition((pos) => {
      btn.classList.remove("loading"); btn.disabled = false;
      const { latitude, longitude, accuracy } = pos.coords;
      estado.partida = { lat: latitude, lng: longitude, precisao_m: accuracy };
      const m = Math.round(accuracy);
      const badge = $("gps-precisao");
      badge.textContent = `Precisão: ± ${fmt.num(m)} m`;
      badge.className = "badge " + (m <= 50 ? "ok" : m <= 200 ? "warn" : "danger");
      $("gps-status").textContent = m <= 50
        ? "Localização obtida. Confira o ponto no mapa."
        : "Localização obtida, mas com pouca precisão. Se puder, ative o GPS ou vá para um local aberto e toque em Atualizar.";
      btn.querySelector("span:last-child").textContent = "Atualizar localização";
      mostrarPartidaNoMapa(latitude, longitude, accuracy);
      atualizarAcoes();
    }, (erro) => {
      btn.classList.remove("loading"); btn.disabled = false;
      estado.partida = null;
      atualizarAcoes();
      if (erro.code === erro.PERMISSION_DENIED) {
        $("gps-status").textContent = "Precisamos da sua localização para calcular as rotas.";
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
        if (it.complemento && !existente.complementos.includes(it.complemento)) existente.complementos.push(it.complemento);
        agrupadas++;
        continue;
      }
      if (estado.paradas.length >= limite) { cortadas++; continue; }
      const p = { id: proximoId++, texto: texto.slice(0, 300), referencias: it.referencia ? [it.referencia] : [],
        complementos: it.complemento ? [it.complemento] : [], volumes: it.volumes || null, linhas: 1, geo: null, status: "pendente" };
      estado.paradas.push(p);
      porChave.set(k, p);
      novas++;
    }
    renderParadas();
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
      ? `${n} parada${n > 1 ? "s" : ""}${linhas > n ? ` (${linhas} linhas, repetidas agrupadas)` : ""} · limite ${estado.config.max_paradas}`
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
    if (marcadores.has(id)) { marcadores.get(id).remove(); marcadores.delete(id); }
  }

  $("btn-limpar").addEventListener("click", () => {
    estado.paradas.forEach((p) => removerParada(p.id));
    renderParadas();
  });

  document.querySelectorAll('input[name="fonte"]').forEach((r) => r.addEventListener("change", () => {
    document.querySelectorAll(".fonte").forEach((f) => f.classList.toggle("hidden", f.dataset.fonte !== r.value));
  }));

  // Colar e digitar
  $("btn-usar-colado").addEventListener("click", () => {
    const linhas = $("texto-colado").value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    adicionar(linhas.map((texto) => ({ texto })));
    if (linhas.length) $("texto-colado").value = "";
  });
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
    dropzone.classList.add("hidden");
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
        complemento: valorCampo(l, mapa, "complemento"),
        referencia: valorCampo(l, mapa, "referencia"),
        volumes: Number.isFinite(vol) ? vol : null,
      };
    });
    adicionar(itens);
    estado.planilha = null;
    $("mapeamento").classList.add("hidden");
    dropzone.classList.remove("hidden");
  });

  // ---------------------------------------------------------------- 3. conferir
  let mapaConferir = null, geoRodando = false, controle = null;
  const marcadores = new Map();
  let modoMarcar = null; // id da parada aguardando um toque no mapa

  const precisaAtencao = (p) => p.status === "erro" || p.status === "atencao";
  const pendencias = () => estado.paradas.filter(precisaAtencao);

  function aplicarGeo(p, geo) {
    p.geo = geo;
    p.status = !geo.encontrado ? "erro" : geo.precisao === "alta" ? "ok" : "atencao";
  }

  function cancelarGeocodificacao() {
    if (controle) controle.abort();
    controle = null;
    geoRodando = false;
  }

  async function iniciarGeocodificacao() {
    $("geo-falha").classList.add("hidden");
    const faltando = estado.paradas.filter((p) => !p.geo);
    if (!faltando.length) { mostrarConferir(); return; }
    geoRodando = true;
    atualizarAcoes();
    $("geo-progresso").classList.remove("hidden");
    $("conferir").classList.add("hidden");
    const total = faltando.length;
    let feitos = 0, pendentesExternos = 0, externosFeitos = 0;
    const progresso = () => {
      $("geo-conta").textContent = `${feitos} de ${total}`;
      $("geo-barra").style.width = `${(feitos / total) * 100}%`;
      const restantes = pendentesExternos - externosFeitos;
      $("geo-eta").textContent = restantes > 0
        ? `Cerca de ${fmt.duracao(restantes * 1.1 + 30).replace(/^0 min$/, "1 min")} restantes · o serviço de mapas permite 1 consulta por segundo.`
        : "Quase pronto…";
    };
    $("geo-titulo").textContent = "Localizando endereços…";
    progresso();
    controle = new AbortController();
    try {
      const resp = await fetch("/api/geocodificar", {
        method: "POST", credentials: "same-origin", signal: controle.signal,
        headers: { "Content-Type": "application/json", "Accept": "application/x-ndjson" },
        body: JSON.stringify({ enderecos: faltando.map((p) => p.texto) }),
      });
      if (resp.status === 401) { window.location.href = "/login"; return; }
      if (!resp.ok) {
        const d = await resp.json().catch(() => ({}));
        throw new Error(typeof d.detail === "string" ? d.detail : "Não foi possível localizar os endereços.");
      }
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
          if (ev.tipo === "inicio") pendentesExternos = ev.pendentes;
          else if (ev.tipo === "resultado") {
            const p = faltando[ev.indice];
            if (p) aplicarGeo(p, ev);
            feitos++;
            if (!ev.de_cache) externosFeitos++;
            progresso();
          } else if (ev.tipo === "erro") throw new Error(ev.mensagem);
        }
      }
      geoRodando = false;
      mostrarConferir();
    } catch (e) {
      geoRodando = false;
      if (e.name === "AbortError") return;
      $("geo-falha-texto").textContent = e.message + (feitos ? ` (${feitos} de ${total} já foram localizados e ficam guardados.)` : "");
      $("geo-falha").classList.remove("hidden");
      $("geo-progresso").classList.add("hidden");
      if (feitos) mostrarConferir(true);
    } finally {
      controle = null;
      atualizarAcoes();
    }
  }
  $("btn-geo-repetir").addEventListener("click", iniciarGeocodificacao);

  function corParada(p) {
    return p.status === "manual" ? COR_MANUAL : p.status === "ok" ? COR_OK : COR_ATENCAO;
  }

  function mostrarConferir(parcial) {
    if (!parcial) $("geo-progresso").classList.add("hidden");
    $("conferir").classList.remove("hidden");
    if (!mapaConferir) {
      mapaConferir = criarMapa("mapa-conferir");
      mapaConferir.on("click", (ev) => {
        if (!modoMarcar) return;
        const p = estado.paradas.find((x) => x.id === modoMarcar);
        modoMarcar = null;
        $("mapa-conferir").style.cursor = "";
        if (!p) return;
        p.geo = { ...(p.geo || {}), encontrado: true, lat: ev.latlng.lat, lng: ev.latlng.lng, precisao: "manual" };
        p.status = "manual";
        desenharMarcadores();
        renderAtencao();
        toast("Ponto marcado.");
      });
    }
    mapaConferir.invalidateSize();
    desenharMarcadores();
    renderAtencao();
    enquadrarConferir();
    atualizarAcoes();
  }

  function desenharMarcadores() {
    const vivos = new Set();
    estado.paradas.forEach((p, i) => {
      if (!p.geo || !p.geo.encontrado) return;
      vivos.add(p.id);
      const icon = pino(corParada(p), i + 1, { tamanho: 28 });
      let m = marcadores.get(p.id);
      if (!m) {
        m = L.marker([p.geo.lat, p.geo.lng], { icon, draggable: true, autoPan: true }).addTo(mapaConferir);
        m.on("dragend", () => {
          const ll = m.getLatLng();
          p.geo = { ...p.geo, lat: ll.lat, lng: ll.lng, precisao: "manual" };
          p.status = "manual";
          desenharMarcadores();
          renderAtencao();
        });
        m.on("click", () => focarItem(p.id));
        marcadores.set(p.id, m);
      } else {
        m.setLatLng([p.geo.lat, p.geo.lng]).setIcon(icon);
      }
      m.bindTooltip(p.texto, { className: "rotulo", direction: "top", offset: [0, -14] });
    });
    for (const [id, m] of marcadores) if (!vivos.has(id)) { m.remove(); marcadores.delete(id); }
  }

  function enquadrarConferir() {
    if (!mapaConferir) return;
    const pts = estado.paradas.filter((p) => p.geo && p.geo.encontrado).map((p) => [p.geo.lat, p.geo.lng]);
    if (estado.partida) pts.push([estado.partida.lat, estado.partida.lng]);
    if (pts.length) mapaConferir.fitBounds(pts, { padding: [30, 30], maxZoom: 15 });
  }

  function focarItem(id) {
    const el = document.querySelector(`[data-parada="${id}"]`);
    if (!el) return;
    document.querySelectorAll(".item-atencao.focado").forEach((x) => x.classList.remove("focado"));
    el.classList.add("focado");
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function botao(texto, ico, classe, fn) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn sm " + (classe || "");
    if (ico) b.append(icone(ico));
    const s = document.createElement("span"); s.textContent = texto; b.append(s);
    b.addEventListener("click", fn);
    return b;
  }

  function renderAtencao() {
    const pend = pendencias();
    const ul = $("lista-atencao");
    ul.replaceChildren();
    const total = estado.paradas.length;
    const ok = total - pend.length;
    $("atencao-titulo").textContent = pend.length ? `${pend.length} endereço${pend.length > 1 ? "s precisam" : " precisa"} de atenção` : "Tudo certo!";
    $("atencao-sub").textContent = pend.length
      ? `${ok} de ${total} localizados. Corrija o texto, ajuste o pino no mapa ou confirme.`
      : `${total} parada${total > 1 ? "s" : ""} no mapa. Se quiser, arraste qualquer pino para ajustar.`;
    if (!pend.length) {
      const li = document.createElement("li"); li.className = "lista-vazia";
      li.textContent = "Nenhuma pendência. Continue para escolher os motoristas.";
      ul.append(li);
    }
    for (const p of pend) {
      const li = document.createElement("li");
      li.className = "item-atencao";
      li.dataset.parada = p.id;
      const topo = document.createElement("div"); topo.className = "row between";
      const b = document.createElement("span");
      b.className = "badge " + (p.status === "erro" ? "danger" : "warn");
      b.textContent = p.status === "erro" ? "Não encontrado" : (NIVEL_TEXTO[p.geo.nivel] || "Localização aproximada");
      const num = document.createElement("span"); num.className = "subtle"; num.textContent = `Parada ${estado.paradas.indexOf(p) + 1}`;
      topo.append(b, num);

      const form = document.createElement("form"); form.className = "input-group";
      const inp = document.createElement("input"); inp.type = "text"; inp.value = p.texto; inp.maxLength = 300; inp.setAttribute("aria-label", "Endereço");
      const buscar = document.createElement("button"); buscar.type = "submit"; buscar.className = "btn icon-only"; buscar.title = "Buscar de novo";
      buscar.setAttribute("aria-label", "Buscar de novo"); buscar.innerHTML = '<span class="spin"></span>'; buscar.append(icone("localizar"));
      form.append(inp, buscar);
      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        const texto = inp.value.replace(/\s+/g, " ").trim();
        if (!texto) return;
        carregando(buscar, async () => {
          try {
            const r = await api("POST", "/api/geocodificar/um", { endereco: texto });
            p.texto = texto;
            aplicarGeo(p, r);
            desenharMarcadores();
            renderAtencao();
            if (p.status === "ok") toast("Endereço localizado.");
            else if (p.status === "erro") toast("Ainda não encontrado. Tente outro texto ou marque no mapa.", "erro");
            else if (marcadores.has(p.id)) mapaConferir.setView(marcadores.get(p.id).getLatLng(), 16);
          } catch (e) { toast(e.message, "erro"); }
        });
      });

      const acoes = document.createElement("div"); acoes.className = "acoes";
      if (p.status === "atencao") {
        acoes.append(botao("Ver no mapa", "pino", "", () => {
          mapaConferir.setView([p.geo.lat, p.geo.lng], 17);
          if (window.innerWidth < 960) $("mapa-conferir").scrollIntoView({ behavior: "smooth", block: "center" });
          toast("Arraste o pino se precisar ajustar.");
        }));
        acoes.append(botao("Está certo", "check", "", () => { p.status = "manual"; desenharMarcadores(); renderAtencao(); }));
      } else {
        acoes.append(botao("Marcar no mapa", "pino", "", () => {
          modoMarcar = p.id;
          $("mapa-conferir").style.cursor = "crosshair";
          if (window.innerWidth < 960) $("mapa-conferir").scrollIntoView({ behavior: "smooth", block: "center" });
          toast("Toque no mapa onde fica este endereço.");
        }));
      }
      acoes.append(botao("Remover", "lixeira", "ghost", () => {
        removerParada(p.id); desenharMarcadores(); renderAtencao(); renderParadas();
      }));
      if (p.geo && p.geo.descricao) {
        const d = document.createElement("div"); d.className = "desc"; d.textContent = "Encontrado: " + p.geo.descricao;
        li.append(topo, form, d, acoes);
      } else li.append(topo, form, acoes);
      ul.append(li);
    }
    atualizarAcoes();
  }

  // ---------------------------------------------------------------- 4. motoristas
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
    const n = estado.paradas.length, k = estado.motoristas.length;
    $("resumo-calculo").textContent =
      `${n} parada${n > 1 ? "s" : ""} para ${k} motorista${k > 1 ? "s" : ""}. O cálculo usa o modo de maior qualidade e leva cerca de ${estado.config.solver_tempo_limite_s} segundos.`;
  }
  $("mot-menos").addEventListener("click", () => { if (estado.motoristas.length > 1) estado.motoristas.pop(); renderMotoristas(); });
  $("mot-mais").addEventListener("click", () => { if (estado.motoristas.length < 20) estado.motoristas.push({ nome: "" }); renderMotoristas(); });

  // ---------------------------------------------------------------- cálculo
  const MENSAGENS = ["Calculando distâncias reais pelas ruas…", "Dividindo as paradas entre os motoristas…",
    "Agrupando endereços próximos…", "Testando combinações para encurtar o trajeto…", "Refinando a ordem das entregas…"];

  function mostrarCalculando(segundos) {
    const ov = $("calculando"), anel = $("anel"), total = 326.7;
    ov.classList.remove("hidden");
    let passados = 0;
    $("calc-seg").textContent = segundos;
    anel.style.transition = "none"; anel.style.strokeDashoffset = total;
    requestAnimationFrame(() => { anel.style.transition = ""; });
    const timer = setInterval(() => {
      passados++;
      $("calc-seg").textContent = Math.max(0, segundos - passados);
      anel.style.strokeDashoffset = total * (1 - Math.min(1, passados / segundos));
      $("calc-msg").textContent = passados >= segundos ? "Finalizando…" : MENSAGENS[Math.floor(passados / Math.max(1, segundos / MENSAGENS.length)) % MENSAGENS.length];
    }, 1000);
    return () => { clearInterval(timer); ov.classList.add("hidden"); };
  }

  async function calcular() {
    const maxInp = $("max-por-motorista").value.trim();
    const corpo = {
      partida: estado.config.modo_partida === "localizacao_atual" ? { lat: estado.partida.lat, lng: estado.partida.lng } : null,
      paradas: estado.paradas.map((p) => ({ lat: p.geo.lat, lng: p.geo.lng, endereco: p.texto })),
      motoristas: estado.motoristas.map((m) => ({ nome: m.nome })),
      max_por_motorista: maxInp ? Number(maxInp) : null,
      fim: document.querySelector('input[name="fim"]:checked').value,
    };
    const fechar = mostrarCalculando(estado.config.solver_tempo_limite_s);
    try {
      estado.resultado = await api("POST", "/api/calcular", corpo);
      fechar();
      renderResultado();
      irPara(5);
    } catch (e) {
      fechar();
      toast(e.message, "erro");
    }
  }

  // ---------------------------------------------------------------- 5. resultado
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
    return linhas.join("\n").trim();
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
    $("res-stats").replaceChildren(
      stat("Paradas nas rotas", fmt.num(alocadas), r.nao_alocadas.length ? `${r.nao_alocadas.length} não alocada(s)` : "todas alocadas"),
      stat("Distância total", fmt.km(r.km_total * 1000)),
      stat("Tempo de direção", fmt.duracao(r.tempo_total_s), "estimado pelas ruas"),
      stat("Motoristas", `${usados} de ${r.motoristas.length}`, `cálculo em ${fmt.num(r.tempo_calculo_ms / 1000, 0)} s`),
    );

    // Mapa
    if (!mapaResultado) mapaResultado = criarMapa("mapa-resultado");
    if (camadaResultado) camadaResultado.remove();
    camadaResultado = L.layerGroup().addTo(mapaResultado);
    const limites = [[r.partida.lat, r.partida.lng]];
    r.motoristas.forEach((m, mi) => {
      if (!m.linha.length) return;
      const cor = corDe(mi), traco = tracoDe(mi);
      L.polyline(m.linha, { color: "#ffffff", weight: 8, opacity: 0.9 }).addTo(camadaResultado); // contorno (contraste)
      L.polyline(m.linha, { color: cor, weight: 4.5, opacity: 1, dashArray: traco }).addTo(camadaResultado)
        .bindTooltip(m.nome, { className: "rotulo", sticky: true });
      m.linha.forEach((pt) => limites.push(pt));
      m.paradas.forEach((pi, ordem) => {
        const p = paradas[pi];
        const icon = L.divIcon({ className: "pino", iconSize: [26, 26], iconAnchor: [13, 13],
          html: `<span style="--cor:${cor};width:26px;height:26px;color:${TINTA_SOBRE[cor] || "#fff"}">${ordem + 1}</span>` });
        L.marker([p.geo.lat, p.geo.lng], { icon }).addTo(camadaResultado)
          .bindTooltip(`${m.nome} · ${ordem + 1}ª: ${p.texto}`, { className: "rotulo", direction: "top", offset: [0, -12] });
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
        const extra = [...p.complementos, ...p.referencias].filter(Boolean);
        if (p.volumes) extra.push(`${p.volumes} vol.`);
        if (extra.length) { const s = document.createElement("small"); s.textContent = extra.join(" · "); li.append(s); }
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
    const corpo = {
      motoristas: r.motoristas.map((m) => ({
        nome: m.nome, distancia_m: m.distancia_m, duracao_s: m.duracao_s,
        paradas: m.paradas.map((pi) => {
          const p = paradas[pi];
          return { endereco: [p.texto, ...p.complementos].join(" · ").slice(0, 400), referencia: p.referencias.join(", ").slice(0, 200),
            volumes: p.volumes ? String(p.volumes) : "", lat: p.geo.lat, lng: p.geo.lng };
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
    estado.paradas.forEach((p) => removerParada(p.id));
    estado.paradas = [];
    estado.resultado = null;
    if (camadaResultado) camadaResultado.remove();
    $("dlg-novo").close();
    renderParadas();
    irPara(estado.config.modo_partida === "endereco_fixo" || estado.partida ? 2 : 1);
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
        mostrarPartidaNoMapa(c.partida.lat, c.partida.lng, null);
      } else {
        $("partida-fixa-texto").textContent = "O administrador ainda não definiu o endereço de partida.";
      }
    } else {
      $("partida-gps").classList.remove("hidden");
      pedirLocalizacao(); // pede a permissão logo ao abrir, como combinado
    }
    if (!c.geocodificacao_ativa) toast("A localização de endereços está desativada pelo administrador.", "erro");
    renderParadas();
    irPara(1);
  }
  iniciar();
})();
