(function () {
  "use strict";
  const { api, toast, carregando, dadosDaPagina } = window.Rotear;
  const { criarMapa, pino } = window.RotearMapa;
  const cfg = dadosDaPagina("dados").config;

  const form = document.getElementById("form-config");
  const blocoFixo = document.getElementById("bloco-fixo");
  const ajudaAtual = document.getElementById("ajuda-atual");
  const campoEndereco = document.getElementById("endereco");
  const coords = document.getElementById("coords");
  const badgePonto = document.getElementById("badge-ponto");

  let ponto = cfg.partida_lat != null ? { lat: cfg.partida_lat, lng: cfg.partida_lng } : null;
  let mapa = null, marcador = null;

  // Preenche o formulário
  form.modo_partida.value = cfg.modo_partida;
  campoEndereco.value = cfg.partida_endereco || "";
  form.solver_tempo_limite_s.value = cfg.solver_tempo_limite_s;
  form.max_paradas.value = cfg.max_paradas;
  form.geocodificacao_ativa.checked = cfg.geocodificacao_ativa;

  function mostrarPonto(confirmado) {
    if (!ponto) {
      coords.textContent = "Nenhum ponto definido.";
      badgePonto.className = "badge warn"; badgePonto.textContent = "Defina o ponto";
      return;
    }
    coords.textContent = `${ponto.lat.toFixed(6)}, ${ponto.lng.toFixed(6)}`;
    badgePonto.className = "badge " + (confirmado ? "ok" : "brand");
    badgePonto.textContent = confirmado ? "Ponto salvo" : "Ponto ajustado: salve para confirmar";
  }

  function posicionar(latlng, zoom, confirmado) {
    ponto = { lat: latlng.lat, lng: latlng.lng };
    if (!marcador) {
      marcador = L.marker(latlng, { draggable: true, icon: pino("var(--brand)", "", { tamanho: 34 }), autoPan: true }).addTo(mapa);
      marcador.on("dragend", () => posicionar(marcador.getLatLng(), null, false));
    } else {
      marcador.setLatLng(latlng);
    }
    if (zoom) mapa.setView(latlng, zoom);
    mostrarPonto(confirmado);
  }

  function iniciarMapa() {
    if (mapa) { mapa.invalidateSize(); return; }
    mapa = criarMapa("mapa");
    mapa.on("click", (ev) => posicionar(ev.latlng, null, false));
    if (ponto) posicionar(ponto, 16, true);
    else mostrarPonto(false);
  }

  function atualizarModo() {
    const fixo = form.modo_partida.value === "endereco_fixo";
    blocoFixo.classList.toggle("hidden", !fixo);
    ajudaAtual.classList.toggle("hidden", fixo);
    if (fixo) requestAnimationFrame(iniciarMapa);
  }
  form.querySelectorAll('input[name="modo_partida"]').forEach((r) => r.addEventListener("change", atualizarModo));
  atualizarModo();

  // Busca do endereço (geocodificação)
  const btnBuscar = document.getElementById("btn-buscar");
  async function buscar() {
    const texto = campoEndereco.value.trim();
    if (!texto) { toast("Digite o endereço.", "erro"); campoEndereco.focus(); return; }
    await carregando(btnBuscar, async () => {
      try {
        const r = await api("POST", "/api/geocodificar/um", { endereco: texto });
        if (!r.encontrado) { toast("Endereço não encontrado. Ajuste o texto ou marque o ponto no mapa.", "erro"); return; }
        posicionar({ lat: r.lat, lng: r.lng }, 17, false);
        if (r.precisao !== "alta") toast("Localização aproximada: confira e ajuste o pino.");
      } catch (e) { toast(e.message, "erro"); }
    });
  }
  btnBuscar.addEventListener("click", buscar);
  campoEndereco.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); buscar(); } });

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const fixo = form.modo_partida.value === "endereco_fixo";
    const dados = {
      modo_partida: form.modo_partida.value,
      partida_endereco: campoEndereco.value.trim() || null,
      partida_lat: ponto ? ponto.lat : null,
      partida_lng: ponto ? ponto.lng : null,
      solver_tempo_limite_s: Number(form.solver_tempo_limite_s.value),
      max_paradas: Number(form.max_paradas.value),
      geocodificacao_ativa: form.geocodificacao_ativa.checked,
    };
    if (fixo && (!dados.partida_endereco || !ponto)) {
      toast("Para usar endereço fixo, informe o endereço e marque o ponto no mapa.", "erro");
      return;
    }
    carregando(document.getElementById("btn-salvar"), async () => {
      try {
        await api("PUT", "/api/admin/configuracoes", dados);
        if (ponto) mostrarPonto(true);
        toast("Configurações salvas.");
      } catch (e) { toast(e.message, "erro"); }
    });
  });
})();
