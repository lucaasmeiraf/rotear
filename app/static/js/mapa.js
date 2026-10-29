// Fábrica de mapas Leaflet com tiles do OpenStreetMap (atribuição obrigatória).
(function () {
  "use strict";
  const CENTRO_PADRAO = [-15.7939, -47.8828]; // Brasília

  function criarMapa(elemento, opcoes) {
    const mapa = L.map(elemento, Object.assign({ zoomControl: true, attributionControl: true }, opcoes || {}));
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
    }).addTo(mapa);
    mapa.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
    mapa.setView(CENTRO_PADRAO, 11);
    return mapa;
  }

  // Marcador numerado/colorido (div), sem depender das imagens padrão
  function pino(cor, texto, opcoes) {
    const o = opcoes || {};
    const tam = o.tamanho || 30;
    return L.divIcon({
      className: "pino",
      html: `<span style="--cor:${cor};width:${tam}px;height:${tam}px">${texto || ""}</span>`,
      iconSize: [tam, tam],
      iconAnchor: [tam / 2, tam / 2],
    });
  }

  window.RotearMapa = { criarMapa, pino, CENTRO_PADRAO };
})();
