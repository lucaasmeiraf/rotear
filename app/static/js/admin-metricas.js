(function () {
  "use strict";
  const { api, toast, dadosDaPagina, fmt } = window.Rotear;
  const NS = "http://www.w3.org/2000/svg";

  function el(tag, attrs, pai) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (pai) pai.appendChild(e);
    return e;
  }

  const rotuloDia = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

  // Colunas de uma série: barra <= 24px, topo arredondado 4px, base reta, grade discreta, tooltip por coluna.
  function desenharGrafico(dados) {
    const caixa = document.getElementById("grafico");
    const tip = document.getElementById("grafico-tip");
    caixa.replaceChildren();
    const serie = dados.por_dia.map((d) => ({ dia: d.dia, n: d.planejamentos, p: d.paradas }));
    const total = serie.reduce((s, d) => s + d.n, 0);
    document.getElementById("sub-grafico").textContent = total
      ? `${fmt.num(total)} planejamento${total === 1 ? "" : "s"} nos últimos ${dados.dias} dias`
      : `Nenhum planejamento nos últimos ${dados.dias} dias`;

    const W = caixa.clientWidth || 600, H = caixa.clientHeight || 220;
    const m = { t: 8, r: 4, b: 24, l: 30 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const max = Math.max(1, ...serie.map((d) => d.n));
    const passo = max <= 4 ? 1 : Math.ceil(max / 4);
    const topo = Math.ceil(max / passo) * passo;
    const y = (v) => m.t + ih - (v / topo) * ih;
    const banda = iw / serie.length;
    const larg = Math.max(2, Math.min(24, banda - 2)); // gap >= 2px entre colunas

    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true" }, caixa);
    for (let v = 0; v <= topo; v += passo) {
      el("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: "grade" }, svg);
      const t = el("text", { x: m.l - 8, y: y(v) + 4, "text-anchor": "end", class: "eixo" }, svg);
      t.textContent = fmt.num(v);
    }
    const cadaRotulo = Math.ceil(serie.length / Math.max(2, Math.floor(iw / 56)));
    serie.forEach((d, i) => {
      const cx = m.l + banda * i + banda / 2;
      const ultimo = i === serie.length - 1;
      if ((i % cadaRotulo === 0 && (serie.length - 1 - i >= cadaRotulo || ultimo)) || ultimo) {
        const t = el("text", { x: cx, y: H - 6, "text-anchor": "middle", class: "eixo" }, svg);
        t.textContent = rotuloDia(d.dia);
      }
      let barra = null;
      if (d.n > 0) {
        const x0 = cx - larg / 2, y0 = y(d.n), base = y(0), r = Math.min(4, larg / 2, base - y0);
        barra = el("path", {
          class: "barra",
          d: `M${x0},${base}V${y0 + r}Q${x0},${y0} ${x0 + r},${y0}H${x0 + larg - r}Q${x0 + larg},${y0} ${x0 + larg},${y0 + r}V${base}Z`,
        }, svg);
      }
      const alvo = el("rect", { x: m.l + banda * i, y: m.t, width: banda, height: ih, class: "alvo" }, svg);
      const mostrar = () => {
        caixa.classList.add("focando");
        svg.querySelectorAll(".barra.ativa").forEach((b) => b.classList.remove("ativa"));
        if (barra) barra.classList.add("ativa");
        tip.innerHTML = "";
        const a = document.createElement("div"); a.className = "subtle"; a.textContent = rotuloDia(d.dia);
        const b = document.createElement("div");
        b.innerHTML = `<strong></strong> planejamento(s) · <strong></strong> paradas`;
        b.querySelectorAll("strong")[0].textContent = fmt.num(d.n);
        b.querySelectorAll("strong")[1].textContent = fmt.num(d.p);
        tip.append(a, b);
        tip.classList.remove("hidden");
        const px = (cx / W) * caixa.clientWidth;
        const largTip = tip.offsetWidth;
        tip.style.left = Math.min(Math.max(0, px - largTip / 2 + 18), caixa.clientWidth - largTip + 18) + "px";
        tip.style.top = Math.max(0, (y(d.n) / H) * caixa.clientHeight - 52) + "px";
      };
      alvo.addEventListener("pointerenter", mostrar);
      alvo.addEventListener("pointerdown", mostrar);
    });
    svg.addEventListener("pointerleave", () => { caixa.classList.remove("focando"); tip.classList.add("hidden"); });
  }

  function render(dados) {
    const t = dados.totais;
    const v = (k) => document.querySelector(`[data-v="${k}"]`);
    v("planejamentos").textContent = fmt.num(t.planejamentos);
    v("paradas").textContent = fmt.num(t.paradas);
    v("km").textContent = fmt.num(t.km, 0);
    v("tempo").textContent = `${fmt.duracao(t.tempo_total_s)} de direção`;
    v("calculo").textContent = t.planejamentos ? `${fmt.num(t.media_calculo_ms / 1000, 1)} s` : "–";
    v("motoristas").textContent = t.planejamentos ? `${fmt.num(t.media_motoristas, 1)} motorista(s) em média` : "";

    desenharGrafico(dados);

    const pu = document.getElementById("por-usuario");
    pu.replaceChildren();
    if (!dados.por_usuario.length) {
      pu.innerHTML = '<li class="list-row"><span class="subtle">Sem uso no período.</span></li>';
    }
    for (const u of dados.por_usuario) {
      const li = document.createElement("li");
      li.className = "list-row";
      li.innerHTML = '<span class="avatar"></span><div class="grow"><div class="title"></div><div class="meta"></div></div>';
      li.querySelector(".avatar").textContent = (u.nome[0] || "?").toUpperCase();
      li.querySelector(".title").textContent = u.nome;
      li.querySelector(".meta").textContent = `${fmt.num(u.planejamentos)} planejamento(s) · ${fmt.num(u.paradas)} paradas`;
      pu.append(li);
    }

    const tb = document.getElementById("recentes");
    tb.replaceChildren();
    if (!dados.recentes.length) {
      tb.innerHTML = '<tr><td colspan="6" class="subtle">Nenhum cálculo no período.</td></tr>';
    }
    for (const r of dados.recentes) {
      const tr = document.createElement("tr");
      for (const [valor, num] of [
        [fmt.dataHora(r.criado_em), false], [r.usuario, false], [fmt.num(r.qtd_paradas), true],
        [fmt.num(r.qtd_motoristas), true], [fmt.num(r.km_total, 1), true], [`${fmt.num(r.tempo_calculo_ms / 1000, 1)} s`, true],
      ]) {
        const td = document.createElement("td");
        td.textContent = valor;
        if (num) td.className = "num";
        tr.append(td);
      }
      tb.append(tr);
    }
  }

  let atual = dadosDaPagina("dados");
  document.querySelectorAll('input[name="periodo"]').forEach((r) => r.addEventListener("change", async () => {
    try {
      atual = await api("GET", `/api/admin/metricas?dias=${r.value}`);
      render(atual);
    } catch (e) { toast(e.message, "erro"); }
  }));
  let espera;
  window.addEventListener("resize", () => { clearTimeout(espera); espera = setTimeout(() => desenharGrafico(atual), 120); });
  render(atual);
})();
