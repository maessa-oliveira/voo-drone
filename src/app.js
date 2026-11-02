// Interface do planejador. Os cálculos estão em ./voo.js.
import { CAMERAS, gsd, planejar, direcaoSugerida, paraKML, EXEMPLO_AREA } from './voo.js';

const L = window.L;
const $ = (id) => document.getElementById(id);
const nf = (v, c = 0) => v.toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c });

// ---------- mapa ----------
const mapa = L.map('mapa', { zoomControl: false }).setView([-12.97, -38.5], 12);
L.control.zoom({ position: 'topright' }).addTo(mapa);
L.control.scale({ imperial: false, position: 'bottomright' }).addTo(mapa);
const satelite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 19, attribution: 'Imagens &copy; Esri, Maxar, Earthstar Geographics',
});
const ruas = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
});
satelite.addTo(mapa);
L.control.layers({ 'Satélite': satelite, 'Mapa': ruas }, null, { position: 'topright' }).addTo(mapa);

const camArea = L.layerGroup().addTo(mapa);
const camVoo = L.layerGroup().addTo(mapa);
let vertices = [];
let desenhando = false;
let plano = null;

// ---------- controles ----------
for (const [k, c] of Object.entries(CAMERAS)) $('camera').append(new Option(c.nome, k));
const cam = () => CAMERAS[$('camera').value];
const params = () => ({
  camera: cam(), altura: +$('altura').value, frontal: +$('frontal').value / 100,
  lateral: +$('lateral').value / 100, direcao: +$('direcao').value,
});

function rotulos() {
  const p = params();
  $('vAltura').textContent = `${p.altura} m`;
  $('vFrontal').textContent = `${$('frontal').value}%`;
  $('vLateral').textContent = `${$('lateral').value}%`;
  $('vDirecao').textContent = `${p.direcao}°`;
  $('vGsd').textContent = `${nf(gsd(p.camera, p.altura).gsdCm, 2)} cm/px`;
}

// ---------- desenho da área ----------
function desenharArea() {
  camArea.clearLayers();
  if (!vertices.length) return;
  if (vertices.length >= 3 && !desenhando) {
    L.polygon(vertices, { color: '#e0a64a', weight: 2.5, fillOpacity: 0.12 }).addTo(camArea);
  } else {
    L.polyline(vertices, { color: '#e0a64a', weight: 2.5, dashArray: '6 6' }).addTo(camArea);
  }
  vertices.forEach((v, i) => {
    const m = L.marker(v, {
      draggable: true,
      icon: L.divIcon({ className: '', html: '<div class="vertice"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
      title: `Vértice ${i + 1} (arraste para mover)`,
    }).addTo(camArea);
    m.on('drag', (ev) => { vertices[i] = [ev.latlng.lat, ev.latlng.lng]; atualizar(false); });
    m.on('click', () => { if (desenhando && i === 0 && vertices.length >= 3) concluir(); });
  });
}

function iniciarDesenho() {
  vertices = []; plano = null; desenhando = true;
  camVoo.clearLayers(); camArea.clearLayers();
  $('btnDesenhar').textContent = 'Concluir';
  $('btnDesenhar').classList.add('ativo');
  $('instrucao').hidden = false;
  limparResultado();
}
function concluir() {
  if (vertices.length < 3) { $('erro').textContent = 'Marque pelo menos 3 vértices.'; return; }
  desenhando = false;
  $('btnDesenhar').textContent = 'Redesenhar área';
  $('btnDesenhar').classList.remove('ativo');
  $('direcao').value = direcaoSugerida(vertices);
  atualizar();
}
mapa.on('click', (ev) => {
  if (!desenhando) return;
  vertices.push([ev.latlng.lat, ev.latlng.lng]);
  $('erro').textContent = '';
  desenharArea();
});

// ---------- cálculo e resultado ----------
function limparResultado() {
  for (const id of ['rArea', 'rFotos', 'rTempo', 'rBaterias', 'rGsd', 'rPegada', 'rLinhas', 'rBase', 'rVel', 'rDist', 'rPrec']) $(id).textContent = '—';
  window.__voo = null;
}

function atualizar(enquadrar = false) {
  rotulos();
  desenharArea();
  camVoo.clearLayers();
  $('erro').textContent = '';
  if (desenhando || vertices.length < 3) { limparResultado(); return; }
  try {
    plano = planejar({ area: vertices, ...params() });
  } catch (e) {
    plano = null; limparResultado();
    $('erro').textContent = e.message.charAt(0).toUpperCase() + e.message.slice(1) + '.';
    return;
  }
  const p = plano;
  L.polyline(p.caminhoGeo, { color: '#33a39a', weight: 2, opacity: 0.95 }).addTo(camVoo);
  L.marker(p.caminhoGeo[0], {
    icon: L.divIcon({ className: '', html: '<div class="inicio-voo">início</div>', iconSize: [44, 18], iconAnchor: [22, 9] }),
    interactive: false,
  }).addTo(camVoo);

  $('rArea').textContent = `${nf(p.areaHa, 1)} ha`;
  $('rFotos').textContent = nf(p.fotos);
  $('rTempo').textContent = p.tempoMin < 60 ? `${nf(p.tempoMin)} min` : `${Math.floor(p.tempoMin / 60)} h ${nf(p.tempoMin % 60)} min`;
  $('rBaterias').textContent = nf(p.baterias);
  $('rGsd').textContent = `${nf(p.gsdCm, 2)} cm/px`;
  $('rPegada').textContent = `${nf(p.pegada.largura)} × ${nf(p.pegada.altura)} m`;
  $('rLinhas').textContent = `${nf(p.nLinhas)} · a cada ${nf(p.espacLinhas, 1)} m`;
  $('rBase').textContent = `${nf(p.base, 1)} m`;
  $('rVel').textContent = `${nf(p.velocidade, 1)} m/s (limite: ${p.limitante})`;
  $('rDist').textContent = `${nf(p.distanciaM / 1000, 2)} km`;
  $('rPrec').textContent = `H ${nf(p.precisao.horizontalCm[0], 1)}–${nf(p.precisao.horizontalCm[1], 1)} cm · V ${nf(p.precisao.verticalCm[0], 1)}–${nf(p.precisao.verticalCm[1], 1)} cm`;
  window.__voo = p;
  if (enquadrar) mapa.fitBounds(L.latLngBounds(vertices), margem());
}
const margem = () => (innerWidth > 720
  ? { paddingTopLeft: [400, 40], paddingBottomRight: [60, 40] }
  : { paddingTopLeft: [20, 20], paddingBottomRight: [20, innerHeight * 0.55 + 20] });

// ---------- eventos ----------
for (const id of ['altura', 'frontal', 'lateral', 'direcao']) $(id).addEventListener('input', () => atualizar());
$('camera').addEventListener('change', () => atualizar());
$('btnDesenhar').addEventListener('click', () => (desenhando ? concluir() : iniciarDesenho()));
$('btnLimpar').addEventListener('click', () => {
  vertices = []; desenhando = false; plano = null;
  camArea.clearLayers(); camVoo.clearLayers(); limparResultado();
  $('btnDesenhar').textContent = 'Desenhar área'; $('btnDesenhar').classList.remove('ativo');
});
$('btnSugerir').addEventListener('click', () => { if (vertices.length >= 3) { $('direcao').value = direcaoSugerida(vertices); atualizar(); } });
$('btnExemplo').addEventListener('click', carregarExemplo);
$('btnKML').addEventListener('click', () => {
  if (!plano) { $('erro').textContent = 'Desenhe uma área primeiro.'; return; }
  const kml = paraKML(plano, vertices, { nome: `Plano de voo ${cam().nome}`, altura: params().altura });
  const url = URL.createObjectURL(new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'plano-de-voo.kml'; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

function carregarExemplo() {
  vertices = EXEMPLO_AREA.map((v) => [...v]);
  desenhando = false;
  $('btnDesenhar').textContent = 'Redesenhar área'; $('btnDesenhar').classList.remove('ativo');
  $('direcao').value = direcaoSugerida(vertices);
  atualizar(true);
}

rotulos();
carregarExemplo();
window.__pronto = true;
