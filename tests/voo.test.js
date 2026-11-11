import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  DRONES, projecao, area, gsd, alturaParaGsd, planejar, direcaoSugerida, paraKML, EXEMPLO_AREA,
  lerKML, kmlDeKMZ, listarZip, montarZip, missoesDJIFly, lerMissaoDJIFly, LIMITE_PONTOS_DJI_FLY,
} from '../src/voo.js';
import { kmzDe } from './kmz.mjs';

const perto = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} ≠ ${b} (tol ${tol})`);
const inflar = (b) => zlib.inflateRawSync(b);
const mini = DRONES.mini4;

// retângulo de L × A metros (L leste-oeste, A norte-sul) em torno de um ponto
function retangulo(L, A, lat0 = -12.5, lon0 = -38.5) {
  const p = projecao(lat0, lon0);
  return [[-L / 2, -A / 2], [L / 2, -A / 2], [L / 2, A / 2], [-L / 2, A / 2]].map(p.de);
}

// confere se o XML está bem formado (tags abertas e fechadas na ordem)
function xmlBemFormado(xml) {
  const pilha = [];
  for (const m of xml.replace(/<\?xml[^>]*\?>/, '').matchAll(/<(\/?)([\w:]+)[^>]*?(\/?)>/g)) {
    const [, fecha, nome, auto] = m;
    if (auto) continue;
    if (fecha) assert.equal(pilha.pop(), nome, `tag </${nome}> fora de ordem`);
    else pilha.push(nome);
  }
  assert.equal(pilha.length, 0, `tags sem fechar: ${pilha.join(', ')}`);
}

async function lerDoZip(kmz, nome) {
  const z = listarZip(kmz);
  const e = z.entradas.find((x) => x.nome === nome);
  assert.ok(e, `falta ${nome} no KMZ`);
  const ini = e.local + 30 + z.dv.getUint16(e.local + 26, true) + z.dv.getUint16(e.local + 28, true);
  const dados = z.u8.subarray(ini, ini + e.comp);
  return new TextDecoder().decode(e.metodo === 8 ? inflar(dados) : dados);
}

test('GSD do Mini 4 Pro a 100 m ≈ 3,54 cm/px', () => {
  const g = gsd(mini, 100);
  perto(g.gsdCm, 3.54, 0.01);
  perto(g.larguraM, 0.0354 * 4032, 0.5);
});

test('alturaParaGsd é a inversa do GSD', () => {
  for (const d of Object.values(DRONES)) perto(gsd(d, alturaParaGsd(d, 2.5)).gsdCm, 2.5, 1e-9, d.nome);
});

test('projeção local ida e volta e área de um retângulo', () => {
  const p = projecao(-12.5, -38.5);
  const [la, lo] = p.de(p.para([-12.51, -38.49]));
  perto(la, -12.51, 1e-12); perto(lo, -38.49, 1e-12);
  perto(area(retangulo(400, 250).map(p.para)), 100000, 1);
});

test('plano de um retângulo: linhas, espaçamentos e pontos de foto', () => {
  const pl = planejar({ area: retangulo(620, 400), camera: mini, altura: 100, frontal: 0.8, lateral: 0.7, direcao: 0 });
  perto(pl.areaHa, 24.8, 0.01);
  perto(pl.espacLinhas, gsd(mini, 100).larguraM * 0.3, 0.01);
  perto(pl.base, gsd(mini, 100).alturaM * 0.2, 0.01);
  assert.equal(pl.nLinhas, Math.ceil(620 / pl.espacLinhas));
  assert.equal(pl.caminhoGeo.length, pl.nLinhas * 2);
  assert.equal(pl.fotos, pl.estacoesGeo.length);
  // pontos da mesma linha nunca ficam mais longe que a base (a sobreposição não cai)
  const proj = projecao(-12.5, -38.5);
  for (let i = 1; i < pl.estacoesGeo.length; i++) {
    const a = pl.estacoesGeo[i - 1], b = pl.estacoesGeo[i];
    if (a.linha !== b.linha) continue;
    const [x1, y1] = proj.para([a.lat, a.lon]), [x2, y2] = proj.para([b.lat, b.lon]);
    assert.ok(Math.hypot(x2 - x1, y2 - y1) <= pl.base + 1e-6);
  }
});

test('voar no sentido do lado longo dá menos linhas', () => {
  const a = retangulo(800, 200);
  const ns = planejar({ area: a, camera: mini, altura: 80, frontal: 0.75, lateral: 0.7, direcao: 0 });
  const lo = planejar({ area: a, camera: mini, altura: 80, frontal: 0.75, lateral: 0.7, direcao: 90 });
  assert.ok(lo.nLinhas < ns.nLinhas, `${lo.nLinhas} vs ${ns.nLinhas}`);
  assert.equal(direcaoSugerida(a), 90);
});

test('velocidade respeita o intervalo da câmera e o arrasto', () => {
  const pl = planejar({ area: retangulo(300, 300), camera: mini, altura: 60, frontal: 0.8, lateral: 0.7 });
  assert.ok(pl.velocidade <= pl.base / mini.intervalo + 1e-9);
  assert.ok(pl.velocidade <= (0.5 * pl.gsdCm / 100) * 1000 + 1e-9);
});

test('área côncava (em L)', () => {
  const p = projecao(-12.5, -38.5);
  const L = [[0, 0], [400, 0], [400, 150], [150, 150], [150, 400], [0, 400]].map(p.de);
  const pl = planejar({ area: L, camera: mini, altura: 100, frontal: 0.75, lateral: 0.65, direcao: 90 });
  perto(pl.areaM2, 400 * 150 + 150 * 250, 5);
  assert.ok(pl.nLinhas > Math.ceil(400 / pl.espacLinhas) - 1);
});

test('validações', () => {
  assert.throws(() => planejar({ area: [[0, 0], [0, 1]], camera: mini, altura: 100, frontal: 0.8, lateral: 0.7 }), /3 vértices/);
  assert.throws(() => planejar({ area: retangulo(100, 100), camera: mini, altura: 0, frontal: 0.8, lateral: 0.7 }), /altura/);
  assert.throws(() => planejar({ area: retangulo(100, 100), camera: mini, altura: 100, frontal: 1, lateral: 0.7 }), /sobreposi/);
  const pl = planejar({ area: retangulo(100, 100), camera: mini, altura: 100, frontal: 0.8, lateral: 0.7 });
  assert.throws(() => missoesDJIFly(pl, { altura: 130, drone: mini }), /120 m/);
});

test('exemplo e KML da área', () => {
  const pl = planejar({ area: EXEMPLO_AREA, camera: mini, altura: 100, frontal: 0.8, lateral: 0.7, direcao: direcaoSugerida(EXEMPLO_AREA) });
  assert.ok(pl.areaHa > 45 && pl.areaHa < 60, `${pl.areaHa} ha`);
  const kml = paraKML(pl, EXEMPLO_AREA, { altura: 100 });
  xmlBemFormado(kml);
  assert.deepEqual(lerKML(kml).length, EXEMPLO_AREA.length);
});

test('lê área de KML (Polygon, LineString) e de KMZ comprimido', async () => {
  const kml = `<?xml version="1.0"?><kml><Document><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>
    -38.50,-12.50,0 -38.49,-12.50,0 -38.49,-12.49,0 -38.50,-12.49,0 -38.50,-12.50,0
  </coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>`;
  const a = lerKML(kml);
  assert.equal(a.length, 4);
  assert.deepEqual(a[0], [-12.5, -38.5]);
  assert.equal(lerKML('<LineString><coordinates>1,2 3,4 5,6</coordinates></LineString>').length, 3);
  assert.throws(() => lerKML('<Point><coordinates>1,2</coordinates></Point>'), /polígono/);
  assert.deepEqual(lerKML(await kmlDeKMZ(kmzDe('doc.kml', Buffer.from(kml)), inflar)), a);
});

test('ZIP montado aqui abre no unzip do Node (ida e volta)', async () => {
  const z = montarZip([['wpmz/template.kml', '<a>olá</a>'], ['wpmz/waylines.wpml', '<b/>']]);
  assert.equal(await lerDoZip(z, 'wpmz/template.kml'), '<a>olá</a>');
  assert.equal(await lerDoZip(z, 'wpmz/waylines.wpml'), '<b/>');
});

test('missão DJI Fly (parar em cada ponto): até 200 pontos e uma bateria por parte', async () => {
  const pl = planejar({ area: EXEMPLO_AREA, camera: mini, altura: 80, frontal: 0.8, lateral: 0.7, direcao: direcaoSugerida(EXEMPLO_AREA) });
  const ms = missoesDJIFly(pl, { altura: 80, drone: mini, agora: 0 });
  assert.ok(ms.length > 1);
  assert.equal(ms.reduce((s, m) => s + m.pontos, 0), pl.estacoesGeo.length, 'nenhum ponto de foto perdido');
  for (const m of ms) {
    assert.ok(m.pontos <= LIMITE_PONTOS_DJI_FLY);
    assert.ok(m.tempoMin <= mini.bateriaMin - 3 + 1e-9, `${m.tempoMin} min`);
    const tpl = await lerDoZip(m.kmz, 'wpmz/template.kml');
    const way = await lerDoZip(m.kmz, 'wpmz/waylines.wpml');
    xmlBemFormado(tpl); xmlBemFormado(way);
    assert.match(way, /xmlns:wpml="http:\/\/www\.uav\.com\/wpmz\/1\.0\.2"/);
    assert.match(way, /<wpml:droneEnumValue>68<\/wpml:droneEnumValue>/);
    assert.match(way, /<wpml:executeHeightMode>relativeToStartPoint<\/wpml:executeHeightMode>/);
    assert.equal((way.match(/<Placemark>/g) || []).length, m.pontos);
    assert.equal((way.match(/<wpml:actionActuatorFunc>takePhoto/g) || []).length, m.pontos);
    assert.equal((way.match(/<wpml:waypointGimbalPitchAngle>-90</g) || []).length, m.pontos);
    // índices em sequência a partir de 0
    const idx = [...way.matchAll(/<wpml:index>(\d+)<\/wpml:index>/g)].map((x) => +x[1]);
    assert.deepEqual(idx, idx.map((_, k) => k));
    assert.ok([...way.matchAll(/<wpml:executeHeight>([\d.]+)</g)].every((x) => x[1] === '80'));
  }
});

test('missão DJI Fly (foto por distância): só as pontas das linhas e gatilho a cada base', async () => {
  const pl = planejar({ area: EXEMPLO_AREA, camera: mini, altura: 100, frontal: 0.8, lateral: 0.7, direcao: direcaoSugerida(EXEMPLO_AREA) });
  const ms = missoesDJIFly(pl, { altura: 100, drone: mini, modo: 'distancia', agora: 0 });
  const way = await lerDoZip(ms[0].kmz, 'wpmz/waylines.wpml');
  xmlBemFormado(way);
  assert.match(way, /<wpml:actionTriggerType>multipleDistance<\/wpml:actionTriggerType><wpml:actionTriggerParam>([\d.]+)</);
  perto(+way.match(/<wpml:actionTriggerParam>([\d.]+)</)[1], pl.base, 0.06);
  assert.ok(ms.reduce((s, m) => s + m.pontos, 0) < pl.estacoesGeo.length / 5, 'muito menos pontos que o modo parar');
});

test('missão de teste com 5 pontos e código do drone vindo da missão-modelo', async () => {
  const pl = planejar({ area: retangulo(300, 300), camera: DRONES.air3, altura: 50, frontal: 0.8, lateral: 0.7 });
  // missão-modelo como o DJI Fly salva: KMZ comprimido com wpmz/waylines.wpml
  const modeloXml = '<kml><Document><wpml:missionConfig><wpml:droneInfo><wpml:droneEnumValue>77</wpml:droneEnumValue>'
    + '<wpml:droneSubEnumValue>1</wpml:droneSubEnumValue></wpml:droneInfo></wpml:missionConfig><Folder><Placemark/><Placemark></Placemark></Folder></Document></kml>';
  const info = await lerMissaoDJIFly(kmzDe('wpmz/waylines.wpml', Buffer.from(modeloXml)), inflar);
  assert.deepEqual(info, { droneEnum: 77, droneSub: 1, pontos: 1 });
  const [t] = missoesDJIFly(pl, { altura: 50, drone: DRONES.air3, maxPontos: 5, droneEnum: info.droneEnum, droneSub: info.droneSub, agora: 0 });
  assert.equal(t.pontos, 5);
  const way = await lerDoZip(t.kmz, 'wpmz/waylines.wpml');
  assert.match(way, /<wpml:droneEnumValue>77</);
  assert.match(way, /<wpml:droneSubEnumValue>1</);
  await assert.rejects(lerMissaoDJIFly(kmzDe('doc.kml', Buffer.from('<kml/>')), inflar), /DJI Fly/);
});

test('KMZ de AS: lê áreas e eixos com nome e ignora os marcos (pontos)', async () => {
  const { lerGeometriasKML } = await import('../src/voo.js');
  const kml = `<kml><Document><Folder><name>AS</name>
    <Placemark><name><![CDATA[Eixo do duto]]></name><LineString><coordinates>-38.50,-12.50,0 -38.49,-12.505,0 -38.48,-12.50,0</coordinates></LineString></Placemark>
    <Placemark><name>Marco BG-01</name><Point><coordinates>-38.5,-12.5,0</coordinates></Point></Placemark>
    <Placemark><name>Área solicitada</name><MultiGeometry><Polygon><outerBoundaryIs><LinearRing><coordinates>
      -38.50,-12.50 -38.49,-12.50 -38.49,-12.49 -38.50,-12.50</coordinates></LinearRing></outerBoundaryIs>
      <innerBoundaryIs><LinearRing><coordinates>1,1 2,2 3,1 1,1</coordinates></LinearRing></innerBoundaryIs></Polygon></MultiGeometry></Placemark>
  </Folder></Document></kml>`;
  const g = lerGeometriasKML(kml);
  assert.deepEqual(g.map((x) => [x.tipo, x.nome, x.pts.length]), [['eixo', 'Eixo do duto', 3], ['area', 'Área solicitada', 3]]);
});

test('faixa ao longo do eixo: linhas paralelas cobrindo a largura e missão DJI Fly', async () => {
  const { planejarCorredor, comprimento } = await import('../src/voo.js');
  const p = projecao(-12.5, -38.5);
  // eixo em "L": 1.000 m para leste e 600 m para norte
  const eixo = [[0, 0], [1000, 0], [1000, 600]].map(p.de);
  const pl = planejarCorredor({ eixo, largura: 100, camera: mini, altura: 80, frontal: 0.8, lateral: 0.7 });
  perto(pl.comprimentoM, 1600, 1);
  perto(comprimento(eixo), 1600, 1);
  perto(pl.areaHa, 16, 0.1);
  assert.equal(pl.nLinhas, Math.ceil(100 / pl.espacLinhas));
  assert.ok(pl.fotos > 0 && pl.estacoesGeo.length === pl.fotos);
  // toda foto fica dentro da faixa + meia pegada (perto do eixo)
  const meia = 50 + pl.espacLinhas;
  for (const e of pl.estacoesGeo) {
    const [x, y] = p.para([e.lat, e.lon]);
    const d = Math.min(x <= 1000 ? Math.abs(y) : Math.hypot(x - 1000, y), y >= 0 ? Math.abs(x - 1000) : Infinity);
    assert.ok(d <= meia + pl.base, `foto a ${d.toFixed(1)} m do eixo`);
  }
  const ms = missoesDJIFly(pl, { altura: 80, drone: mini });
  assert.equal(ms.reduce((s, m) => s + m.pontos, 0), pl.fotos);
  assert.throws(() => planejarCorredor({ eixo: [eixo[0]], largura: 100, camera: mini, altura: 80, frontal: 0.8, lateral: 0.7 }), /2 pontos/);
});

test('lê GPS e hora do EXIF da foto (JPEG little e big endian)', async () => {
  const { lerExifJPEG } = await import('../src/voo.js');
  const { jpegComGPS } = await import('./jpeg.mjs');
  for (const bigEndian of [false, true]) {
    const e = lerExifJPEG(jpegComGPS({ lat: -12.2418, lon: -38.9695, alt: 81.5, data: '2026:11:11 10:05:07', bigEndian }));
    perto(e.lat, -12.2418, 1e-7); perto(e.lon, -38.9695, 1e-7); perto(e.alt, 81.5, 1e-9);
    assert.equal(e.data, '2026:11:11 10:05:07');
  }
  assert.equal(lerExifJPEG(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2])), null);
  assert.equal(lerExifJPEG(new Uint8Array([1, 2, 3])), null);
});

test('conferir fotos: acha os pontos que faltam, a parte e a ordem do voo', async () => {
  const { conferirFotos, fotosParaCSV } = await import('../src/voo.js');
  const pl = planejar({ area: retangulo(300, 200), camera: mini, altura: 60, frontal: 0.8, lateral: 0.7, direcao: 0 });
  const ms = missoesDJIFly(pl, { altura: 60, drone: mini, limitePontos: 40 });
  const est = pl.estacoesGeo;
  // fotos em todos os pontos menos 3, com 2 m de erro de GPS, fora de ordem, e uma foto fora do plano
  const pular = new Set([5, 6, 50]);
  const fotos = est.map((e, i) => ({ nome: `DJI_${String(i + 1).padStart(4, '0')}.JPG`, lat: e.lat + 2 / 111320, lon: e.lon, data: `2026:11:11 10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}` }))
    .filter((_, i) => !pular.has(i)).reverse();
  fotos.push({ nome: 'DJI_9999.JPG', lat: est[0].lat + 0.01, lon: est[0].lon, data: '2026:11:11 09:00:00' });
  const c = conferirFotos(pl, fotos, { missoes: ms });
  assert.equal(c.total, est.length);
  assert.equal(c.faltando, 3);
  assert.deepEqual(c.pontos.filter((p) => !p.foto).map((p) => p.indice), [5, 6, 50]);
  assert.equal(c.foraDoPlano, 1);
  // partes de 40 pontos: 5 e 6 na parte 1, 50 na parte 2
  assert.deepEqual(c.partesComFalta, { 1: 2, 2: 1 });
  assert.equal(c.fotos[0].nome, 'DJI_9999.JPG'); // a mais cedo
  assert.equal(c.fotos[1].nome, 'DJI_0001.JPG');
  assert.equal(c.fotos[1].parte, 1);
  assert.equal(c.fotos[1].ponto, 1);
  const csv = fotosParaCSV(c).trim().split('\r\n');
  assert.equal(csv.length, fotos.length + 1);
  assert.match(csv[1], /^﻿?1;DJI_9999\.JPG;.*fora do plano/);
});
