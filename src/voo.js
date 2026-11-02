// Planejamento de voo fotogramétrico (aerolevantamento com drone), sem dependência de navegador.
//
// Convenções:
//  - a área vem em graus (lat, lon) e é projetada num plano local em metros (equiretangular
//    centrado na área; erro desprezível para áreas de alguns km);
//  - as linhas de voo seguem o azimute `direcao` (0° = norte–sul);
//  - o lado maior da imagem fica atravessado à linha de voo (padrão dos drones DJI em mapeamento).

const R = 6371008.8; // raio médio da Terra (m)
const RAD = Math.PI / 180;

/** Câmeras comuns em mapeamento. Valores de catálogo, conferir no manual do equipamento. */
export const CAMERAS = {
  m3e: { nome: 'DJI Mavic 3 Enterprise (4/3")', sensorL: 17.3, sensorA: 13.0, focal: 12.29, pxL: 5280, pxA: 3956, intervalo: 0.7, bateriaMin: 30 },
  m4e: { nome: 'DJI Matrice 4E (grande-angular)', sensorL: 17.3, sensorA: 13.0, focal: 12.29, pxL: 5280, pxA: 3956, intervalo: 0.5, bateriaMin: 32 },
  p4rtk: { nome: 'DJI Phantom 4 RTK (1")', sensorL: 13.2, sensorA: 8.8, focal: 8.8, pxL: 5472, pxA: 3648, intervalo: 2.0, bateriaMin: 20 },
  p1: { nome: 'DJI Zenmuse P1 35 mm (full frame)', sensorL: 35.9, sensorA: 24.0, focal: 35, pxL: 8192, pxA: 5460, intervalo: 0.7, bateriaMin: 30 },
  mini4: { nome: 'DJI Mini 4 Pro (1/1,3")', sensorL: 9.6, sensorA: 7.2, focal: 6.72, pxL: 4032, pxA: 3024, intervalo: 2.0, bateriaMin: 22 },
};

/** Projeção local (lat, lon) ↔ (x, y) em metros em torno de uma origem. */
export function projecao(lat0, lon0) {
  const k = Math.cos(lat0 * RAD);
  return {
    para: ([lat, lon]) => [(lon - lon0) * RAD * R * k, (lat - lat0) * RAD * R],
    de: ([x, y]) => [lat0 + y / (R * RAD), lon0 + x / (R * RAD * k)],
  };
}

/** Área (m²) de um polígono no plano. */
export function area(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/**
 * Geometria da foto. GSD em cm/px e pegada no terreno em metros.
 * GSD = sensor × altura / (focal × pixels)
 */
export function gsd(cam, altura) {
  const g = (cam.sensorL * altura) / (cam.focal * cam.pxL); // m/px
  return { gsdCm: g * 100, larguraM: g * cam.pxL, alturaM: g * cam.pxA };
}

/** Altura de voo (m) para atingir um GSD desejado (cm/px). */
export function alturaParaGsd(cam, gsdCm) {
  return (gsdCm / 100) * cam.focal * cam.pxL / cam.sensorL;
}

const girar = ([x, y], ang) => {
  const c = Math.cos(ang), s = Math.sin(ang);
  return [x * c - y * s, x * s + y * c];
};

/** Intersecções de uma reta vertical x = cx com o polígono: lista ordenada de intervalos [y1, y2]. */
function cortes(poly, cx) {
  const ys = [];
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    if ((x1 <= cx && x2 > cx) || (x2 <= cx && x1 > cx)) {
      ys.push(y1 + ((cx - x1) / (x2 - x1)) * (y2 - y1));
    }
  }
  ys.sort((a, b) => a - b);
  const pares = [];
  for (let i = 0; i + 1 < ys.length; i += 2) pares.push([ys[i], ys[i + 1]]);
  return pares;
}

/**
 * Planeja o voo.
 * @param {object} p
 * @param {Array<[number, number]>} p.area  vértices (lat, lon), pelo menos 3
 * @param {object} p.camera  um item de CAMERAS (ou equivalente)
 * @param {number} p.altura  altura de voo sobre o terreno (m)
 * @param {number} p.frontal  sobreposição frontal (0–1)
 * @param {number} p.lateral  sobreposição lateral (0–1)
 * @param {number} p.direcao  azimute das linhas de voo (graus)
 * @param {number} [p.velocidade]  m/s; se omitida usa a máxima recomendada (limitada a 12 m/s)
 * @param {number} [p.obturador]  tempo de exposição (s), para o limite de arrasto (padrão 1/1000)
 * @param {number} [p.tempoCurva]  segundos gastos em cada curva (padrão 8)
 * @param {number} [p.bateriaMin]  minutos úteis por bateria (padrão o da câmera, ou 20)
 */
export function planejar(p) {
  const { camera: cam, altura, frontal, lateral, direcao = 0 } = p;
  if (!Array.isArray(p.area) || p.area.length < 3) throw new Error('desenhe uma área com pelo menos 3 vértices');
  if (!(altura > 0)) throw new Error('altura de voo inválida');
  if (!(frontal >= 0 && frontal < 1 && lateral >= 0 && lateral < 1)) throw new Error('sobreposições devem estar entre 0% e 99%');
  const lat0 = p.area.reduce((s, q) => s + q[0], 0) / p.area.length;
  const lon0 = p.area.reduce((s, q) => s + q[1], 0) / p.area.length;
  const proj = projecao(lat0, lon0);
  const xy = p.area.map(proj.para);
  const areaM2 = area(xy);
  if (areaM2 < 1) throw new Error('área muito pequena');

  const foto = gsd(cam, altura);
  const espacLinhas = foto.larguraM * (1 - lateral); // entre linhas (atravessado)
  const base = foto.alturaM * (1 - frontal); // entre fotos (ao longo da linha)

  // velocidade: não fotografar mais rápido que o intervalo mínimo da câmera e arrasto ≤ 0,5 px
  const obt = p.obturador ?? 1 / 1000;
  const vIntervalo = base / (cam.intervalo ?? 1);
  const vArrasto = (0.5 * foto.gsdCm / 100) / obt;
  const vMax = Math.min(12, vIntervalo, vArrasto);
  const vel = p.velocidade ?? Math.floor(vMax * 10) / 10;

  // gira o polígono para as linhas de voo ficarem verticais (eixo y)
  const ang = direcao * RAD; // azimuth: rotação horária a partir do norte
  const rot = xy.map((q) => girar(q, ang));
  const xs = rot.map((q) => q[0]);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const nLinhas = Math.max(1, Math.ceil((xmax - xmin) / espacLinhas));
  const x0 = (xmin + xmax) / 2 - ((nLinhas - 1) * espacLinhas) / 2;

  const linhas = [];
  for (let i = 0; i < nLinhas; i++) {
    const cx = x0 + i * espacLinhas;
    for (const [ya, yb] of cortes(rot, cx)) {
      // estende meia pegada em cada ponta para cobrir as bordas
      linhas.push({ cx, y1: ya - base, y2: yb + base });
    }
  }
  if (!linhas.length) throw new Error('não foi possível traçar linhas de voo nessa área');
  // ordem em zigue-zague
  linhas.forEach((l, i) => { if (i % 2) [l.y1, l.y2] = [l.y2, l.y1]; });

  let dist = 0, fotos = 0;
  const caminho = [];
  linhas.forEach((l, i) => {
    const comp = Math.abs(l.y2 - l.y1);
    dist += comp;
    l.fotos = Math.floor(comp / base + 1e-6) + 1;
    fotos += l.fotos;
    const a = [l.cx, l.y1], b = [l.cx, l.y2];
    if (i) { const ant = caminho[caminho.length - 1]; dist += Math.hypot(a[0] - ant[0], a[1] - ant[1]); }
    caminho.push(a, b);
  });
  const desgirar = (q) => proj.de(girar(q, -ang));
  const tempoCurva = p.tempoCurva ?? 8;
  const tempoS = dist / vel + Math.max(0, linhas.length - 1) * tempoCurva;
  const bateriaMin = p.bateriaMin ?? cam.bateriaMin ?? 20;

  return {
    areaM2, areaHa: areaM2 / 10000,
    gsdCm: foto.gsdCm, pegada: { largura: foto.larguraM, altura: foto.alturaM },
    espacLinhas, base,
    nLinhas: linhas.length, fotos,
    distanciaM: dist, velocidade: vel, velocidadeMax: vMax,
    limitante: vMax === vIntervalo ? 'intervalo da câmera' : vMax === vArrasto ? 'arrasto da imagem' : 'limite de segurança',
    tempoMin: tempoS / 60, baterias: Math.max(1, Math.ceil(tempoS / 60 / bateriaMin)), bateriaMin,
    precisao: { horizontalCm: [1 * foto.gsdCm, 2 * foto.gsdCm], verticalCm: [1.5 * foto.gsdCm, 3 * foto.gsdCm] },
    linhasGeo: linhas.map((l) => [desgirar([l.cx, l.y1]), desgirar([l.cx, l.y2])]),
    caminhoGeo: caminho.map(desgirar),
  };
}

/** Sugere o azimute das linhas paralelo ao lado mais longo da área (menos curvas). */
export function direcaoSugerida(areaGeo) {
  const lat0 = areaGeo.reduce((s, q) => s + q[0], 0) / areaGeo.length;
  const lon0 = areaGeo.reduce((s, q) => s + q[1], 0) / areaGeo.length;
  const xy = areaGeo.map(projecao(lat0, lon0).para);
  let melhor = 0, maior = -1;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % xy.length];
    const d = Math.hypot(x2 - x1, y2 - y1);
    if (d > maior) { maior = d; melhor = Math.atan2(x2 - x1, y2 - y1) / RAD; }
  }
  return Math.round(((melhor % 180) + 180) % 180);
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** KML com a área e as linhas de voo (altitude relativa ao terreno). Abre no Google Earth. */
export function paraKML(plano, areaGeo, { nome = 'Plano de voo', altura = 100 } = {}) {
  const coord = (pts, h = 0) => pts.map(([la, lo]) => `${lo.toFixed(8)},${la.toFixed(8)},${h}`).join(' ');
  const anel = [...areaGeo, areaGeo[0]];
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(nome)}</name>
<Style id="area"><LineStyle><color>ff4ab3e0</color><width>2</width></LineStyle><PolyStyle><color>334ab3e0</color></PolyStyle></Style>
<Style id="voo"><LineStyle><color>ffa6b333</color><width>2</width></LineStyle></Style>
<Placemark><name>Área (${plano.areaHa.toFixed(2)} ha)</name><styleUrl>#area</styleUrl><Polygon><outerBoundaryIs><LinearRing><coordinates>${coord(anel)}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
<Placemark><name>Rota (${plano.nLinhas} linhas, ${plano.fotos} fotos, GSD ${plano.gsdCm.toFixed(2)} cm)</name><styleUrl>#voo</styleUrl><LineString><altitudeMode>relativeToGround</altitudeMode><coordinates>${coord(plano.caminhoGeo, altura)}</coordinates></LineString></Placemark>
</Document></kml>
`;
}

/** Área de exemplo (fictícia): um terreno de ~52 ha no interior da Bahia. */
export const EXEMPLO_AREA = [
  [-12.24180, -38.96950], [-12.24010, -38.96420], [-12.24390, -38.96160],
  [-12.24750, -38.96390], [-12.24690, -38.96940],
];
