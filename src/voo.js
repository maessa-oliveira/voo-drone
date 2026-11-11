// Planejamento de voo fotogramétrico (aerolevantamento com drone), sem dependência de navegador.
//
// Convenções:
//  - a área vem em graus (lat, lon) e é projetada num plano local em metros (equiretangular
//    centrado na área; erro desprezível para áreas de alguns km);
//  - as linhas de voo seguem o azimute `direcao` (0° = norte–sul);
//  - o lado maior da imagem fica atravessado à linha de voo (padrão dos drones DJI em mapeamento).

const R = 6371008.8; // raio médio da Terra (m)
const RAD = Math.PI / 180;

/**
 * Drones com voo por waypoints no app DJI Fly. Valores de catálogo (foto de 12 MP, 4:3),
 * conferir no manual. `droneEnum` é o código que o DJI Fly grava na missão: 68 é o do Mini 4 Pro
 * (lido de missões geradas pelo próprio app). O do Air 3 não é publicado pela DJI: o planejador
 * copia o código da missão-modelo que você salva no DJI Fly (ver `lerMissaoDJIFly`).
 */
export const DRONES = {
  mini4: { nome: 'DJI Mini 4 Pro', sensorL: 9.6, sensorA: 7.2, focal: 6.72, pxL: 4032, pxA: 3024, intervalo: 2.0, bateriaMin: 22, droneEnum: 68, droneSub: 0, enumConfirmado: true },
  air3: { nome: 'DJI Air 3 (câmera grande-angular)', sensorL: 9.6, sensorA: 7.2, focal: 6.72, pxL: 4032, pxA: 3024, intervalo: 2.0, bateriaMin: 30, droneEnum: 68, droneSub: 0, enumConfirmado: false },
};
/** Nome antigo, mantido por compatibilidade. */
export const CAMERAS = DRONES;

/** Limite de pontos por missão no DJI Fly. */
export const LIMITE_PONTOS_DJI_FLY = 200;

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

  let dist = 0;
  const caminho = [];
  const estacoes = []; // pontos de foto, na ordem de voo, espaçados de no máximo `base`
  linhas.forEach((l, i) => {
    const comp = Math.abs(l.y2 - l.y1);
    dist += comp;
    const n = Math.max(2, Math.ceil(comp / base - 1e-6) + 1);
    for (let k = 0; k < n; k++) estacoes.push({ q: [l.cx, l.y1 + ((l.y2 - l.y1) * k) / (n - 1)], linha: i });
    const a = [l.cx, l.y1], b = [l.cx, l.y2];
    if (i) { const ant = caminho[caminho.length - 1]; dist += Math.hypot(a[0] - ant[0], a[1] - ant[1]); }
    caminho.push(a, b);
  });
  const fotos = estacoes.length;
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
    estacoesGeo: estacoes.map((e) => { const [lat, lon] = desgirar(e.q); return { lat, lon, linha: e.linha }; }),
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

/**
 * Lê a área de um KML (texto): usa o primeiro Polygon (anel externo); sem polígono, o primeiro
 * LinearRing ou LineString com 3 ou mais pontos. Devolve [[lat, lon], ...] sem repetir o 1º ponto.
 */
export function lerKML(texto) {
  const s = String(texto);
  const blocos = [
    /<Polygon[\s\S]*?<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/i,
    /<LinearRing>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/i,
    /<LineString>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/i,
  ];
  for (const re of blocos) {
    const m = s.match(re);
    if (!m) continue;
    const pts = m[1].trim().split(/\s+/).map((t) => t.split(',').map(Number))
      .filter((c) => c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]))
      .map(([lon, lat]) => [lat, lon]);
    if (pts.length > 1) {
      const [a, b] = [pts[0], pts[pts.length - 1]];
      if (Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12) pts.pop();
    }
    if (pts.length >= 3) return pts;
  }
  throw new Error('não encontrei um polígono com 3 ou mais vértices no arquivo');
}


// ---------- ZIP (KMZ) ----------

/** Lista os arquivos de um ZIP/KMZ: [{nome, metodo, comp, local}]. */
export function listarZip(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('arquivo KMZ inválido');
  const total = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entradas = [];
  for (let k = 0; k < total; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const metodo = dv.getUint16(p + 10, true), comp = dv.getUint32(p + 20, true);
    const nLen = dv.getUint16(p + 28, true), xLen = dv.getUint16(p + 30, true), cLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    entradas.push({ nome: dec.decode(u8.subarray(p + 46, p + 46 + nLen)), metodo, comp, local });
    p += 46 + nLen + xLen + cLen;
  }
  return { u8, dv, entradas };
}

/** Texto de um arquivo dentro do ZIP. `inflarRaw` descompacta "deflate" puro. */
async function textoDoZip({ u8, dv }, e, inflarRaw) {
  const ini = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
  const dados = u8.subarray(ini, ini + e.comp);
  const dec = new TextDecoder();
  if (e.metodo === 0) return dec.decode(dados);
  if (e.metodo === 8) return dec.decode(await inflarRaw(dados));
  throw new Error('compressão do KMZ não suportada');
}

/**
 * Extrai o primeiro .kml de um KMZ (arquivo ZIP). `inflarRaw(bytes)` descompacta "deflate" puro
 * (no navegador, DecompressionStream; no Node, zlib.inflateRawSync).
 */
export async function kmlDeKMZ(buffer, inflarRaw) {
  const z = listarZip(buffer);
  const e = z.entradas.find((x) => /\.kml$/i.test(x.nome));
  if (!e) throw new Error('o KMZ não tem arquivo .kml dentro');
  return textoDoZip(z, e, inflarRaw);
}

function crc32(u8) {
  let crc = 0xffffffff;
  for (let i = 0; i < u8.length; i++) {
    let c = (crc ^ u8[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Monta um ZIP sem compressão (store), como os KMZ do DJI Fly. arquivos: [[nome, texto]]. */
export function montarZip(arquivos) {
  const enc = new TextEncoder();
  const partes = [], central = [];
  let off = 0;
  for (const [nome, texto] of arquivos) {
    const n = enc.encode(nome), d = enc.encode(texto), crc = crc32(d);
    const loc = new Uint8Array(30 + n.length), lv = new DataView(loc.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, d.length, true); lv.setUint32(22, d.length, true); lv.setUint16(26, n.length, true);
    loc.set(n, 30);
    const cen = new Uint8Array(46 + n.length), cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, d.length, true); cv.setUint32(24, d.length, true); cv.setUint16(28, n.length, true);
    cv.setUint32(42, off, true);
    cen.set(n, 46);
    partes.push(loc, d); central.push(cen);
    off += loc.length + d.length;
  }
  const tamCentral = central.reduce((s, c) => s + c.length, 0);
  const fim = new Uint8Array(22), fv = new DataView(fim.buffer);
  fv.setUint32(0, 0x06054b50, true); fv.setUint16(8, arquivos.length, true); fv.setUint16(10, arquivos.length, true);
  fv.setUint32(12, tamCentral, true); fv.setUint32(16, off, true);
  const tudo = [...partes, ...central, fim];
  const saida = new Uint8Array(tudo.reduce((s, x) => s + x.length, 0));
  let p = 0;
  for (const x of tudo) { saida.set(x, p); p += x.length; }
  return saida;
}

// ---------- missão DJI Fly (KMZ de waypoints, formato WPML) ----------
// O DJI Fly não tem botão de importar: você salva uma missão qualquer no app (a "missão-modelo")
// e troca o arquivo .kmz dela pelo gerado aqui, com o mesmo nome. O KMZ tem duas peças:
//   wpmz/template.kml  (o DJI Fly não usa, mas recusa o arquivo sem ela)
//   wpmz/waylines.wpml (a rota que o drone executa)
// Alturas relativas ao ponto de decolagem (o DJI Fly não segue o relevo). Até 200 pontos por missão.

const NS_WPML = 'http://www.uav.com/wpmz/1.0.2';
const f8 = (v) => v.toFixed(8);
const n1 = (v) => (Math.round(v * 10) / 10).toString();

function distM(a, b) {
  const k = Math.cos(((a.lat + b.lat) / 2) * RAD);
  return Math.hypot((b.lon - a.lon) * RAD * R * k, (b.lat - a.lat) * RAD * R);
}

/**
 * Lê a missão-modelo salva pelo DJI Fly: devolve o código do drone e quantos pontos ela tem.
 * Aceita o .kmz inteiro (usa wpmz/waylines.wpml ou wpmz/template.kml).
 */
export async function lerMissaoDJIFly(buffer, inflarRaw) {
  const z = listarZip(buffer);
  const e = z.entradas.find((x) => /waylines\.wpml$/i.test(x.nome)) || z.entradas.find((x) => /template\.kml$/i.test(x.nome));
  if (!e) throw new Error('este KMZ não é uma missão do DJI Fly (não tem a pasta wpmz)');
  const t = await textoDoZip(z, e, inflarRaw);
  const num = (tag) => { const m = t.match(new RegExp(`<wpml:${tag}>\\s*(-?\\d+)\\s*</wpml:${tag}>`)); return m ? +m[1] : null; };
  const droneEnum = num('droneEnumValue');
  if (droneEnum == null) throw new Error('não achei o código do drone na missão do DJI Fly');
  return { droneEnum, droneSub: num('droneSubEnumValue') ?? 0, pontos: (t.match(/<Placemark>/g) || []).length };
}

/**
 * Divide a rota em missões para o DJI Fly.
 * @param {object} plano  resultado de `planejar`
 * @param {object} o
 * @param {number} o.altura  altura de voo (m) sobre a decolagem
 * @param {object} o.drone   item de DRONES
 * @param {'ponto'|'distancia'} [o.modo]  'ponto': para e fotografa em cada ponto (mais garantido);
 *   'distancia': pontos só nas pontas das linhas e foto a cada `base` metros (menos pontos, nem toda
 *   versão do DJI Fly respeita)
 * @param {number} [o.droneEnum]  código do drone lido da missão-modelo (prevalece sobre o do catálogo)
 * @param {number} [o.droneSub]
 * @param {number} [o.limitePontos]  padrão 200
 * @param {number} [o.parada]  segundos parado em cada foto no modo 'ponto' (padrão 2,5)
 * @param {number} [o.maxPontos]  usa só os primeiros N pontos (missão de teste)
 * @param {number} [o.agora]  carimbo de data (ms), para testes
 */
export function missoesDJIFly(plano, o) {
  const { altura, drone } = o;
  if (!(altura > 0 && altura <= 120)) throw new Error('a altura deve ficar entre 1 e 120 m');
  const modo = o.modo === 'distancia' ? 'distancia' : 'ponto';
  const limite = Math.min(o.limitePontos ?? LIMITE_PONTOS_DJI_FLY, LIMITE_PONTOS_DJI_FLY);
  const parada = o.parada ?? 2.5;
  const droneEnum = o.droneEnum ?? drone.droneEnum;
  const droneSub = o.droneSub ?? drone.droneSub ?? 0;
  const agora = o.agora ?? Date.now();
  // orçamento de tempo por bateria: minutos úteis menos ~3 min para ir, voltar e pousar
  const orcamentoS = Math.max(120, (drone.bateriaMin ?? 20) * 60 - 180);

  // velocidade: no modo ponto o drone para em cada foto; entre pontos usa a do plano (máx. 10 m/s)
  const vel = Math.max(1, Math.min(modo === 'ponto' ? 10 : 12, plano.velocidade));
  let pts = modo === 'ponto'
    ? plano.estacoesGeo.map((e) => ({ lat: e.lat, lon: e.lon, foto: true }))
    : plano.caminhoGeo.map(([lat, lon], i) => ({ lat, lon, foto: i % 2 === 0 }));
  if (o.maxPontos) pts = pts.slice(0, Math.max(2, o.maxPontos));

  // divide em partes: no máximo `limite` pontos e o tempo de uma bateria
  const partes = [];
  let atual = [], tempo = 0;
  const custo = (a, b) => (a ? distM(a, b) / vel : 0) + (modo === 'ponto' ? parada : 0);
  for (const p of pts) {
    const c = custo(atual[atual.length - 1], p);
    if (atual.length && (atual.length >= limite || tempo + c > orcamentoS)) {
      partes.push({ pontos: atual, tempoS: tempo });
      // no modo distância a parte seguinte recomeça no fim da anterior para não perder trecho
      atual = modo === 'distancia' ? [{ ...atual[atual.length - 1] }] : [];
      tempo = 0;
    }
    tempo += custo(atual[atual.length - 1], p);
    atual.push(p);
  }
  if (atual.length >= 2 || (atual.length && !partes.length)) partes.push({ pontos: atual, tempoS: tempo });

  return partes.map((parte, i) => {
    const nome = `Voo Drone ${i + 1} de ${partes.length}`;
    let distancia = 0;
    parte.pontos.forEach((p, k) => { if (k) distancia += distM(parte.pontos[k - 1], p); });
    const xml = gerarWPML(parte.pontos, { altura, vel, modo, base: plano.base, droneEnum, droneSub, agora, distancia, duracao: parte.tempoS });
    return {
      nome, arquivo: `voo-drone-parte-${i + 1}-de-${partes.length}.kmz`,
      pontos: parte.pontos.length, fotos: modo === 'ponto' ? parte.pontos.length : Math.round(distancia / plano.base),
      tempoMin: parte.tempoS / 60, distanciaM: distancia,
      inicio: parte.pontos[0],
      template: xml.template, waylines: xml.waylines,
      kmz: montarZip([['wpmz/template.kml', xml.template], ['wpmz/waylines.wpml', xml.waylines]]),
    };
  });
}

function gerarWPML(pontos, { altura, vel, modo, base, droneEnum, droneSub, agora, distancia, duracao }) {
  const h = n1(altura), v = n1(vel);
  const config = `<wpml:missionConfig>
      <wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode>
      <wpml:finishAction>goHome</wpml:finishAction>
      <wpml:exitOnRCLost>executeLostAction</wpml:exitOnRCLost>
      <wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>
      <wpml:globalTransitionalSpeed>${v}</wpml:globalTransitionalSpeed>
      <wpml:droneInfo>
        <wpml:droneEnumValue>${droneEnum}</wpml:droneEnumValue>
        <wpml:droneSubEnumValue>${droneSub}</wpml:droneSubEnumValue>
      </wpml:droneInfo>
    </wpml:missionConfig>`;
  const parar = modo === 'ponto';
  const giro = `<wpml:waypointTurnParam>
          <wpml:waypointTurnMode>toPointAndStopWithDiscontinuityCurvature</wpml:waypointTurnMode>
          <wpml:waypointTurnDampingDist>0</wpml:waypointTurnDampingDist>
        </wpml:waypointTurnParam>`;
  const rumo = `<wpml:waypointHeadingParam>
          <wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode>
          <wpml:waypointHeadingAngle>0</wpml:waypointHeadingAngle>
          <wpml:waypointPoiPoint>0.000000,0.000000,0.000000</wpml:waypointPoiPoint>
          <wpml:waypointHeadingAngleEnable>0</wpml:waypointHeadingAngleEnable>
          <wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode>
        </wpml:waypointHeadingParam>`;
  let grupo = 0, acao = 0;
  const acoesFoto = (i) => {
    const id = grupo++;
    const disparo = parar
      ? '<wpml:actionTrigger><wpml:actionTriggerType>reachPoint</wpml:actionTriggerType></wpml:actionTrigger>'
      : `<wpml:actionTrigger><wpml:actionTriggerType>multipleDistance</wpml:actionTriggerType><wpml:actionTriggerParam>${n1(base)}</wpml:actionTriggerParam></wpml:actionTrigger>`;
    const fim = parar ? i : i + 1;
    return `<wpml:actionGroup>
          <wpml:actionGroupId>${id}</wpml:actionGroupId>
          <wpml:actionGroupStartIndex>${i}</wpml:actionGroupStartIndex>
          <wpml:actionGroupEndIndex>${fim}</wpml:actionGroupEndIndex>
          <wpml:actionGroupMode>sequence</wpml:actionGroupMode>
          ${disparo}
          <wpml:action>
            <wpml:actionId>${acao++}</wpml:actionId>
            <wpml:actionActuatorFunc>takePhoto</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
            </wpml:actionActuatorFuncParam>
          </wpml:action>
        </wpml:actionGroup>`;
  };
  const ultimo = pontos.length - 1;
  const marcas = pontos.map((p, i) => {
    // no modo distância a foto liga no início de cada linha e vale até o ponto seguinte (fim da linha)
    const comFoto = parar ? p.foto : p.foto && i < ultimo;
    return `      <Placemark>
        <Point><coordinates>${f8(p.lon)},${f8(p.lat)}</coordinates></Point>
        <wpml:index>${i}</wpml:index>
        <wpml:executeHeight>${h}</wpml:executeHeight>
        <wpml:waypointSpeed>${v}</wpml:waypointSpeed>
        ${rumo}
        ${giro}
        <wpml:useStraightLine>1</wpml:useStraightLine>
        <wpml:waypointGimbalHeadingParam>
          <wpml:waypointGimbalPitchAngle>-90</wpml:waypointGimbalPitchAngle>
          <wpml:waypointGimbalYawAngle>0</wpml:waypointGimbalYawAngle>
        </wpml:waypointGimbalHeadingParam>
        ${comFoto ? acoesFoto(i) : ''}
      </Placemark>`;
  }).join('\n');

  const waylines = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${NS_WPML}">
  <Document>
    ${config}
    <Folder>
      <wpml:templateId>0</wpml:templateId>
      <wpml:executeHeightMode>relativeToStartPoint</wpml:executeHeightMode>
      <wpml:waylineId>0</wpml:waylineId>
      <wpml:distance>${Math.round(distancia)}</wpml:distance>
      <wpml:duration>${Math.round(duracao)}</wpml:duration>
      <wpml:autoFlightSpeed>${v}</wpml:autoFlightSpeed>
${marcas}
    </Folder>
  </Document>
</kml>
`;

  const marcasTemplate = pontos.map((p, i) => `      <Placemark>
        <Point><coordinates>${f8(p.lon)},${f8(p.lat)}</coordinates></Point>
        <wpml:index>${i}</wpml:index>
        <wpml:height>${h}</wpml:height>
        <wpml:useGlobalHeight>1</wpml:useGlobalHeight>
        <wpml:useGlobalSpeed>1</wpml:useGlobalSpeed>
        <wpml:useGlobalHeadingParam>1</wpml:useGlobalHeadingParam>
        <wpml:useGlobalTurnParam>1</wpml:useGlobalTurnParam>
        <wpml:gimbalPitchAngle>-90</wpml:gimbalPitchAngle>
      </Placemark>`).join('\n');
  const template = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="${NS_WPML}">
  <Document>
    <wpml:author>fly</wpml:author>
    <wpml:createTime>${agora}</wpml:createTime>
    <wpml:updateTime>${agora}</wpml:updateTime>
    ${config}
    <Folder>
      <wpml:templateType>waypoint</wpml:templateType>
      <wpml:templateId>0</wpml:templateId>
      <wpml:waylineCoordinateSysParam>
        <wpml:coordinateMode>WGS84</wpml:coordinateMode>
        <wpml:heightMode>relativeToStartPoint</wpml:heightMode>
      </wpml:waylineCoordinateSysParam>
      <wpml:autoFlightSpeed>${v}</wpml:autoFlightSpeed>
      <wpml:globalHeight>${h}</wpml:globalHeight>
      <wpml:gimbalPitchMode>usePointSetting</wpml:gimbalPitchMode>
      <wpml:globalWaypointHeadingParam>
        <wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode>
        <wpml:waypointHeadingPathMode>followBadArc</wpml:waypointHeadingPathMode>
      </wpml:globalWaypointHeadingParam>
      <wpml:globalWaypointTurnMode>toPointAndStopWithDiscontinuityCurvature</wpml:globalWaypointTurnMode>
      <wpml:globalUseStraightLine>1</wpml:globalUseStraightLine>
${marcasTemplate}
    </Folder>
  </Document>
</kml>
`;
  return { template, waylines };
}
