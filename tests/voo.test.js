import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAMERAS, projecao, area, gsd, alturaParaGsd, planejar, direcaoSugerida, paraKML, EXEMPLO_AREA } from '../src/voo.js';

const perto = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} ≠ ${b} (tol ${tol})`);

// retângulo de L × A metros (L leste-oeste, A norte-sul) em torno de um ponto
function retangulo(L, A, lat0 = -12.5, lon0 = -38.5) {
  const p = projecao(lat0, lon0);
  return [[-L / 2, -A / 2], [L / 2, -A / 2], [L / 2, A / 2], [-L / 2, A / 2]].map(p.de);
}

test('GSD do Phantom 4 RTK a 100 m ≈ 2,74 cm/px (valor do fabricante)', () => {
  const g = gsd(CAMERAS.p4rtk, 100);
  perto(g.gsdCm, 2.74, 0.01);
  perto(g.larguraM, 2.74 / 100 * 5472, 0.5);
});

test('GSD do Mavic 3 Enterprise a 100 m ≈ 2,67 cm/px', () => {
  perto(gsd(CAMERAS.m3e, 100).gsdCm, 2.67, 0.02);
});

test('alturaParaGsd é a inversa do GSD', () => {
  for (const cam of Object.values(CAMERAS)) {
    perto(gsd(cam, alturaParaGsd(cam, 2.5)).gsdCm, 2.5, 1e-9, cam.nome);
  }
});

test('projeção local ida e volta e área de um retângulo', () => {
  const p = projecao(-12.5, -38.5);
  const [la, lo] = p.de(p.para([-12.51, -38.49]));
  perto(la, -12.51, 1e-12); perto(lo, -38.49, 1e-12);
  const r = retangulo(400, 250);
  perto(area(r.map(p.para)), 100000, 1);
});

test('plano de um retângulo: número de linhas, espaçamentos e fotos', () => {
  const pl = planejar({ area: retangulo(600, 400), camera: CAMERAS.p4rtk, altura: 100, frontal: 0.8, lateral: 0.7, direcao: 0 });
  perto(pl.areaHa, 24, 0.01);
  perto(pl.espacLinhas, 149.9 * 0.3, 0.2); // pegada ~149,9 m × 30 %
  perto(pl.base, 99.9 * 0.2, 0.2);
  // linhas norte-sul cobrindo 600 m de largura
  assert.equal(pl.nLinhas, Math.ceil(600 / pl.espacLinhas));
  // cada linha tem 400 m + 2 bases de extensão
  const fotosPorLinha = Math.floor((400 + 2 * pl.base) / pl.base + 1e-6) + 1;
  assert.equal(pl.fotos, fotosPorLinha * pl.nLinhas);
  assert.ok(pl.tempoMin > 0 && pl.baterias >= 1);
  assert.equal(pl.caminhoGeo.length, pl.nLinhas * 2);
});

test('voar no sentido do lado longo dá menos linhas', () => {
  const a = retangulo(800, 200);
  const ns = planejar({ area: a, camera: CAMERAS.m3e, altura: 80, frontal: 0.75, lateral: 0.7, direcao: 0 });
  const lo = planejar({ area: a, camera: CAMERAS.m3e, altura: 80, frontal: 0.75, lateral: 0.7, direcao: 90 });
  assert.ok(lo.nLinhas < ns.nLinhas, `${lo.nLinhas} vs ${ns.nLinhas}`);
  assert.equal(direcaoSugerida(a), 90);
});

test('velocidade respeita o intervalo da câmera e o arrasto', () => {
  const pl = planejar({ area: retangulo(300, 300), camera: CAMERAS.p4rtk, altura: 60, frontal: 0.8, lateral: 0.7 });
  assert.ok(pl.velocidade <= pl.base / CAMERAS.p4rtk.intervalo + 1e-9);
  assert.ok(pl.velocidade <= (0.5 * pl.gsdCm / 100) * 1000 + 1e-9);
  assert.equal(pl.limitante, 'intervalo da câmera');
});

test('área côncava (em L) gera mais de um trecho em algumas linhas', () => {
  const p = projecao(-12.5, -38.5);
  const L = [[0, 0], [400, 0], [400, 150], [150, 150], [150, 400], [0, 400]].map(p.de);
  const pl = planejar({ area: L, camera: CAMERAS.m3e, altura: 100, frontal: 0.75, lateral: 0.65, direcao: 90 });
  perto(pl.areaM2, 400 * 150 + 150 * 250, 5);
  assert.ok(pl.nLinhas > Math.ceil(400 / pl.espacLinhas) - 1);
});

test('validações', () => {
  assert.throws(() => planejar({ area: [[0, 0], [0, 1]], camera: CAMERAS.m3e, altura: 100, frontal: 0.8, lateral: 0.7 }), /3 vértices/);
  assert.throws(() => planejar({ area: retangulo(100, 100), camera: CAMERAS.m3e, altura: 0, frontal: 0.8, lateral: 0.7 }), /altura/);
  assert.throws(() => planejar({ area: retangulo(100, 100), camera: CAMERAS.m3e, altura: 100, frontal: 1, lateral: 0.7 }), /sobreposi/);
});

test('exemplo e KML', () => {
  const pl = planejar({ area: EXEMPLO_AREA, camera: CAMERAS.m3e, altura: 100, frontal: 0.8, lateral: 0.7, direcao: direcaoSugerida(EXEMPLO_AREA) });
  assert.ok(pl.areaHa > 45 && pl.areaHa < 60, `${pl.areaHa} ha`);
  const kml = paraKML(pl, EXEMPLO_AREA, { altura: 100 });
  assert.ok(kml.startsWith('<?xml') && kml.includes('<LineString>') && kml.trim().endsWith('</kml>'));
  assert.equal((kml.match(/<Placemark>/g) || []).length, 2);
});
