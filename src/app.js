// Interface do planejador. Os cálculos estão em ./voo.js.
import { DRONES, gsd, planejar, planejarCorredor, direcaoSugerida, lerGeometriasKML, area as areaPlano, projecao, comprimento, kmlDeKMZ, missoesDJIFly, lerMissaoDJIFly, lerExifJPEG, conferirFotos, fotosParaCSV, EXEMPLO_AREA } from './voo.js';

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
const camFotos = L.layerGroup().addTo(mapa);
let fotosLidas = []; // [{nome, lat, lon, data}] das fotos escolhidas em "Conferir fotos"
let conferencia = null;
let vertices = [];
let desenhando = false;
let plano = null;
let missoes = [];
let eixo = null; // linha (lat, lon) quando o arquivo traz o eixo do duto em vez de uma área
let geos = []; // geometrias do último arquivo aberto
let modelo = null; // { nome, droneEnum, droneSub } lido da missão-modelo do DJI Fly

// ---------- controles ----------
for (const [k, c] of Object.entries(DRONES)) $('camera').append(new Option(c.nome, k));
const cam = () => DRONES[$('camera').value];
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
  $('vLargura').textContent = `${$('largura').value} m`;
  $('vGsd').textContent = `${nf(gsd(p.camera, p.altura).gsdCm, 2)} cm/px`;
}

// ---------- desenho da área ----------
function desenharArea() {
  camArea.clearLayers();
  $('blocoLargura').hidden = !eixo;
  $('blocoDirecao').hidden = !!eixo;
  if (eixo) {
    if (plano?.areaGeo) L.polygon(plano.areaGeo, { color: '#e0a64a', weight: 1.5, fillOpacity: 0.1, dashArray: '4 4' }).addTo(camArea);
    L.polyline(eixo, { color: '#e0a64a', weight: 3 }).addTo(camArea);
    return;
  }
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
  vertices = []; eixo = null; plano = null; desenhando = true;
  $('escolha').hidden = true;
  camVoo.clearLayers(); camArea.clearLayers();
  $('btnDesenhar').textContent = 'Concluir';
  $('btnDesenhar').classList.add('ativo');
  $('instrucao').hidden = false;
  limparResultado();
}
function concluir() {
  if (vertices.length < 3) { $('erro').textContent = 'Marque pelo menos 3 vértices.'; return; }
  desenhando = false;
  $('instrucao').hidden = true;
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
  missoes = [];
  $('partes').replaceChildren();
  $('aviso').hidden = true;
}

function atualizar(enquadrar = false) {
  rotulos();
  desenharArea();
  camVoo.clearLayers();
  $('erro').textContent = '';
  if (desenhando || (!eixo && vertices.length < 3)) { limparResultado(); return; }
  try {
    plano = eixo
      ? planejarCorredor({ eixo, largura: +$('largura').value, ...params() })
      : planejar({ area: vertices, ...params() });
    if (eixo) desenharArea();
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
  missoes = missoesDJIFly(p, opcoesMissao());
  const tMin = missoes.reduce((t, m) => t + m.tempoMin, 0);
  $('rFotos').textContent = nf(missoes.reduce((t, m) => t + m.fotos, 0));
  $('rTempo').textContent = tMin < 60 ? `${nf(tMin)} min` : `${Math.floor(tMin / 60)} h ${nf(tMin % 60)} min`;
  $('rBaterias').textContent = nf(missoes.length);
  mostrarPartes();
  $('rGsd').textContent = `${nf(p.gsdCm, 2)} cm/px`;
  $('rPegada').textContent = `${nf(p.pegada.largura)} × ${nf(p.pegada.altura)} m`;
  $('rLinhas').textContent = `${nf(p.nLinhas)} · a cada ${nf(p.espacLinhas, 1)} m`;
  $('rBase').textContent = `${nf(p.base, 1)} m`;
  $('rVel').textContent = `${nf(p.velocidade, 1)} m/s (limite: ${p.limitante})`;
  $('rDist').textContent = `${nf(p.distanciaM / 1000, 2)} km`;
  $('rPrec').textContent = `H ${nf(p.precisao.horizontalCm[0], 1)}–${nf(p.precisao.horizontalCm[1], 1)} cm · V ${nf(p.precisao.verticalCm[0], 1)}–${nf(p.precisao.verticalCm[1], 1)} cm`;
  window.__voo = p;
  window.__missoes = missoes;
  mostrarConferencia();
  if (enquadrar) mapa.fitBounds(L.latLngBounds(eixo ? plano.areaGeo : vertices), margem());
}
const margem = () => (innerWidth > 720
  ? { paddingTopLeft: [400, 40], paddingBottomRight: [60, 40] }
  : { paddingTopLeft: [20, 20], paddingBottomRight: [20, innerHeight * 0.55 + 20] });

// ---------- eventos ----------
for (const id of ['altura', 'frontal', 'lateral', 'direcao', 'largura']) $(id).addEventListener('input', () => atualizar());
$('fonte').addEventListener('change', () => usarGeometria(geos[+$('fonte').value]));
$('camera').addEventListener('change', () => atualizar());
$('modo').addEventListener('change', () => atualizar());
$('btnDesenhar').addEventListener('click', () => (desenhando ? concluir() : iniciarDesenho()));
$('btnLimpar').addEventListener('click', () => {
  vertices = []; eixo = null; desenhando = false; plano = null;
  $('escolha').hidden = true;
  camArea.clearLayers(); camVoo.clearLayers(); limparResultado();
  $('btnDesenhar').textContent = 'Desenhar área'; $('btnDesenhar').classList.remove('ativo');
});
$('btnSugerir').addEventListener('click', () => { if (vertices.length >= 3) { $('direcao').value = direcaoSugerida(vertices); atualizar(); } });
$('btnExemplo').addEventListener('click', carregarExemplo);
function baixar(nome, dados, tipo) {
  const url = URL.createObjectURL(new Blob([dados], { type: tipo }));
  const el = document.createElement('a');
  el.href = url; el.download = nome; document.body.append(el); el.click(); el.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const TIPO_KMZ = 'application/vnd.google-earth.kmz';

function opcoesMissao(extra = {}) {
  return {
    altura: params().altura, drone: cam(), modo: $('modo').value,
    ...(modelo ? { droneEnum: modelo.droneEnum, droneSub: modelo.droneSub } : {}),
    ...extra,
  };
}

// nome do arquivo: com uma parte e a missão-modelo aberta, usa o mesmo nome dela (pronto para trocar)
const nomeArquivo = (m, total) => (modelo && total === 1 ? modelo.nome : m.arquivo);

function mostrarPartes() {
  const box = $('partes');
  box.replaceChildren();
  missoes.forEach((m, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = i ? 'sec' : '';
    b.dataset.parte = i;
    b.textContent = `Baixar ${missoes.length > 1 ? `parte ${i + 1} de ${missoes.length}` : 'missão'} · ${nf(m.fotos)} fotos · ${nf(m.tempoMin)} min`;
    b.addEventListener('click', () => baixar(nomeArquivo(m, missoes.length), m.kmz, TIPO_KMZ));
    box.append(b);
  });
  const avisos = [];
  if (!cam().enumConfirmado && !modelo) avisos.push(`Para o ${cam().nome}, abra antes a missão-modelo do DJI Fly: o código deste drone não é publicado pela DJI e eu copio da missão que o app salvou.`);
  if ($('modo').value === 'distancia') avisos.push('Foto por distância é experimental: nem toda versão do DJI Fly dispara as fotos. Voe primeiro o KMZ de teste.');
  if (missoes.length > 1) avisos.push(`A área foi dividida em ${missoes.length} missões (até 200 pontos e uma bateria cada). Crie uma missão-modelo no DJI Fly para cada parte.`);
  $('aviso').textContent = avisos.join(' ');
  $('aviso').hidden = !avisos.length;
}

$('btnTeste').addEventListener('click', () => {
  if (!plano) { $('erro').textContent = 'Abra ou desenhe uma área primeiro.'; return; }
  const [t] = missoesDJIFly(plano, opcoesMissao({ modo: 'ponto', maxPontos: 5 }));
  baixar(modelo ? modelo.nome : 'voo-drone-teste-5-fotos.kmz', t.kmz, TIPO_KMZ);
});

$('modelo').addEventListener('change', async () => {
  const f = $('modelo').files[0];
  $('modelo').value = '';
  if (!f) return;
  $('erro').textContent = '';
  try {
    const info = await lerMissaoDJIFly(await f.arrayBuffer(), inflarRaw);
    modelo = { nome: f.name, ...info };
    $('modeloInfo').textContent = `Missão-modelo: ${f.name} (drone código ${info.droneEnum}). O arquivo baixado sai com este nome.`;
    atualizar();
  } catch (e) {
    $('erro').textContent = `${f.name}: ${e.message}.`;
  }
});

async function inflarRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const saida = new Response(new Blob([bytes]).stream().pipeThrough(ds));
  return new Uint8Array(await saida.arrayBuffer());
}
$('arquivo').addEventListener('change', async () => {
  const f = $('arquivo').files[0];
  $('arquivo').value = '';
  if (!f) return;
  $('erro').textContent = '';
  try {
    const buf = await f.arrayBuffer();
    const texto = /\.kmz$/i.test(f.name) || new Uint8Array(buf, 0, 2).join() === '80,75'
      ? await kmlDeKMZ(buf, inflarRaw)
      : new TextDecoder().decode(buf);
    abrirGeometrias(lerGeometriasKML(texto));
  } catch (e) {
    $('erro').textContent = `${f.name}: ${e.message}.`;
  }
});

// descreve cada geometria do arquivo para a lista "O que mapear"
function rotuloGeo(g, i) {
  const nome = g.nome || `${g.tipo === 'eixo' ? 'Linha' : 'Área'} ${i + 1}`;
  if (g.tipo === 'eixo') return `Eixo: ${nome} (${nf(comprimento(g.pts) / 1000, 2)} km) → faixa`;
  const lat0 = g.pts[0][0], lon0 = g.pts[0][1];
  return `Área: ${nome} (${nf(areaPlano(g.pts.map(projecao(lat0, lon0).para)) / 10000, 1)} ha)`;
}

function abrirGeometrias(lista) {
  if (!lista.length) throw new Error('não encontrei área (polígono) nem eixo (linha) no arquivo');
  geos = lista;
  // preferência: primeira área; sem área, o eixo mais longo
  let i = lista.findIndex((g) => g.tipo === 'area');
  if (i < 0) i = lista.reduce((b, g, k) => (comprimento(g.pts) > comprimento(lista[b].pts) ? k : b), 0);
  $('fonte').replaceChildren(...lista.map((g, k) => new Option(rotuloGeo(g, k), k)));
  $('fonte').value = i;
  $('escolha').hidden = lista.length < 2;
  usarGeometria(lista[i]);
}

function usarGeometria(g) {
  if (g.tipo === 'eixo') {
    eixo = g.pts.map((v) => [...v]); vertices = []; desenhando = false;
    $('btnDesenhar').textContent = 'Desenhar área'; $('btnDesenhar').classList.remove('ativo');
    atualizar(true);
  } else usarArea(g.pts);
}

function usarArea(pts) {
  eixo = null;
  vertices = pts.map((v) => [...v]);
  desenhando = false;
  $('btnDesenhar').textContent = 'Redesenhar área'; $('btnDesenhar').classList.remove('ativo');
  $('direcao').value = direcaoSugerida(vertices);
  atualizar(true);
}

function carregarExemplo() {
  eixo = null;
  $('escolha').hidden = true;
  vertices = EXEMPLO_AREA.map((v) => [...v]);
  desenhando = false;
  $('btnDesenhar').textContent = 'Redesenhar área'; $('btnDesenhar').classList.remove('ativo');
  $('direcao').value = direcaoSugerida(vertices);
  atualizar(true);
}

// ---------- conferir fotos ----------
function mostrarConferencia() {
  camFotos.clearLayers();
  conferencia = null;
  $('fotosResultado').hidden = !fotosLidas.length;
  if (!fotosLidas.length || !plano) { window.__conferencia = null; return; }
  const c = conferencia = conferirFotos(plano, fotosLidas, { missoes: $('modo').value === 'ponto' ? missoes : undefined });
  for (const ponto of c.pontos) {
    L.circleMarker([ponto.lat, ponto.lon], {
      radius: ponto.foto ? 3 : 5, weight: ponto.foto ? 0 : 2, color: '#ff8a7a',
      fillColor: ponto.foto ? '#5cd68a' : '#ff5a4a', fillOpacity: 0.95,
    }).bindTooltip(ponto.foto
      ? `${ponto.parte ? `Parte ${ponto.parte}, ponto ${ponto.ponto}: ` : ''}${ponto.foto}`
      : `${ponto.parte ? `Parte ${ponto.parte}, ponto ${ponto.ponto}: ` : ''}sem foto`).addTo(camFotos);
  }
  for (const f of c.fotos.filter((x) => x.ponto == null)) {
    L.circleMarker([f.lat, f.lon], { radius: 4, weight: 1, color: '#fff', fillColor: '#e0a64a', fillOpacity: 0.9 })
      .bindTooltip(`${f.nome}: fora do plano`).addTo(camFotos);
  }
  $('cOk').textContent = `${nf(c.fotografados)} de ${nf(c.total)}`;
  $('cFalta').textContent = nf(c.faltando);
  const partes = Object.entries(c.partesComFalta).map(([pt, n]) => `parte ${pt} (${n})`);
  $('cDetalhe').textContent = (c.faltando
    ? `Faltam fotos em ${nf(c.faltando)} pontos${partes.length ? `: ${partes.join(', ')}. Refaça essas partes` : ''}.`
    : 'Todos os pontos têm foto.')
    + ` ${nf(fotosLidas.length)} fotos lidas${c.foraDoPlano ? `, ${nf(c.foraDoPlano)} fora do plano (em laranja)` : ''}. Tolerância: ${nf(c.tolerancia, 1)} m.`;
  window.__conferencia = c;
}

$('fotos').addEventListener('change', async () => {
  const lista = [...$('fotos').files];
  $('fotos').value = '';
  if (!lista.length) return;
  $('erro').textContent = '';
  $('fotosInfo').textContent = `Lendo ${lista.length} fotos…`;
  const lidas = [];
  let semGps = 0;
  for (const f of lista) {
    try {
      const e = lerExifJPEG(new Uint8Array(await f.slice(0, 256 * 1024).arrayBuffer()));
      if (e) lidas.push({ nome: f.name, lat: e.lat, lon: e.lon, data: e.data }); else semGps++;
    } catch { semGps++; }
  }
  fotosLidas = lidas;
  $('fotosInfo').textContent = semGps
    ? `${semGps} de ${lista.length} fotos sem localização (GPS) foram deixadas de fora. No iPhone, escolha pelo app Arquivos.`
    : `${lista.length} fotos lidas.`;
  if (!lidas.length) { $('erro').textContent = 'Nenhuma foto com localização (GPS).'; mostrarConferencia(); return; }
  mostrarConferencia();
  mapa.fitBounds(L.latLngBounds(lidas.map((f) => [f.lat, f.lon])), margem());
});
$('btnCSV').addEventListener('click', () => { if (conferencia) baixar('fotos-na-ordem-do-voo.csv', fotosParaCSV(conferencia), 'text/csv;charset=utf-8'); });
$('btnLimparFotos').addEventListener('click', () => { fotosLidas = []; mostrarConferencia(); $('fotosInfo').textContent = 'Conferência retirada.'; });

rotulos();
carregarExemplo();
window.__pronto = true;

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
