// Teste de ponta a ponta: abre a página num Chromium real, confere o plano do exemplo,
// muda a altura, desenha uma área, abre KML/KMZ e baixa as missões do DJI Fly. Uso: node tests/e2e.mjs [saida]
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const raiz = resolve(new URL('..', import.meta.url).pathname);
const tipos = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const srv = createServer(async (req, res) => {
  try {
    const p = join(raiz, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
    const corpo = await readFile(p);
    res.writeHead(200, { 'content-type': tipos[extname(p)] || 'application/octet-stream' });
    res.end(corpo);
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const url = `http://localhost:${srv.address().port}/`;
const saida = process.argv[2] || '.';
const browser = await chromium.launch();
const erros = [];
const falha = (m) => { throw new Error(m); };
const vigiar = (page, nome) => {
  page.on('pageerror', (e) => erros.push(`${nome}: ${e.message}`));
  // os ladrilhos do mapa vêm da internet; falha deles não é erro da aplicação
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|ERR_/.test(m.text()) && erros.push(`${nome}: ${m.text()}`));
};
try {
  for (const [nome, vp] of [['desktop', { width: 1366, height: 800 }], ['celular', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport: vp });
    vigiar(page, nome);
    await page.goto(url);
    await page.waitForFunction(() => window.__voo?.fotos > 0);
    const r = await page.evaluate(() => ({ ha: __voo.areaHa, fotos: __voo.fotos, linhas: __voo.nLinhas, gsd: __voo.gsdCm }));
    if (r.ha < 45 || r.ha > 60 || r.fotos < 100) falha(`${nome}: plano inesperado ${JSON.stringify(r)}`);
    if (await page.locator('#rFotos').textContent() === '—') falha('resultado não exibido');
    await page.screenshot({ path: join(saida, `captura-${nome}.png`) });
    console.log(nome, 'ok', JSON.stringify(r));
    await page.close();
  }
  const page = await browser.newPage({ viewport: { width: 1366, height: 800 } });
  vigiar(page, 'interação');
  await page.goto(url);
  await page.waitForFunction(() => window.__voo);
  const antes = await page.evaluate(() => __voo.fotos);
  await page.locator('#altura').fill('60');
  await page.waitForFunction((n) => window.__voo.fotos > n, antes);
  // desenha um triângulo clicando no mapa
  await page.click('#btnDesenhar');
  for (const [x, y] of [[700, 250], [1000, 300], [850, 550]]) await page.mouse.click(x, y);
  await page.click('#btnDesenhar');
  await page.waitForFunction(() => window.__voo && window.__voo.areaHa > 0);
  const tri = await page.evaluate(() => ({ ha: __voo.areaHa, fotos: __voo.fotos }));
  // KML da área, montado aqui, aberto pelo botão
  const { paraKML } = await import('../src/voo.js');
  const kml = paraKML({ areaHa: 1, nLinhas: 1, fotos: 1, gsdCm: 1, caminhoGeo: [[-12.5, -38.5], [-12.5, -38.49]] },
    [[-12.50, -38.50], [-12.50, -38.49], [-12.49, -38.49], [-12.49, -38.50]], { altura: 80 });
  await page.setInputFiles('#arquivo', { name: 'area.kml', mimeType: 'application/vnd.google-earth.kml+xml', buffer: Buffer.from(kml) });
  await page.waitForFunction(() => window.__voo && Math.abs(window.__voo.areaHa - 119.6) < 2);
  const haKml = await page.evaluate(() => __voo.areaHa);
  const { kmzDe } = await import('./kmz.mjs');
  await page.click('#btnExemplo');
  await page.waitForFunction(() => window.__voo.areaHa > 40);
  await page.setInputFiles('#arquivo', { name: 'area.kmz', mimeType: 'application/vnd.google-earth.kmz', buffer: kmzDe('doc.kml', Buffer.from(kml)) });
  await page.waitForFunction((ha) => window.__voo && Math.abs(window.__voo.areaHa - ha) < 0.01, haKml);
  console.log('interação ok', JSON.stringify(tri), 'área do KML', haKml.toFixed(1), 'ha');
  console.log('KML e KMZ ok');
  // KMZ de AS com eixo do duto, marco e área: lista para escolher; o eixo vira faixa
  const as = `<kml><Document><Placemark><name>Eixo do duto</name><LineString><coordinates>-38.500,-12.500,0 -38.490,-12.505,0 -38.480,-12.500,0</coordinates></LineString></Placemark>
    <Placemark><name>Marco BG-01</name><Point><coordinates>-38.5,-12.5,0</coordinates></Point></Placemark>
    <Placemark><name>Área solicitada</name><Polygon><outerBoundaryIs><LinearRing><coordinates>-38.500,-12.500 -38.495,-12.500 -38.495,-12.496 -38.500,-12.500</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>`;
  await page.setInputFiles('#arquivo', { name: 'AS-999.kmz', mimeType: 'application/vnd.google-earth.kmz', buffer: kmzDe('doc.kml', Buffer.from(as)) });
  await page.waitForFunction(() => !document.querySelector('#escolha').hidden && document.querySelector('#fonte').options.length === 2);
  const opcoes = await page.locator('#fonte option').allTextContents();
  if (!opcoes[0].startsWith('Eixo: Eixo do duto') || !opcoes[1].startsWith('Área: Área solicitada')) falha('lista ' + opcoes.join(' | '));
  await page.selectOption('#fonte', '0');
  await page.waitForFunction(() => window.__voo && window.__voo.comprimentoM > 2000 && !document.querySelector('#blocoLargura').hidden);
  const ha100 = await page.evaluate(() => __voo.areaHa);
  await page.locator('#largura').fill('200');
  await page.waitForFunction((h) => window.__voo.areaHa > h * 1.9, ha100);
  await page.screenshot({ path: join(saida, 'captura-eixo.png') });
  console.log('eixo ok', ha100.toFixed(1), 'ha com 100 m');
  await page.click('#btnExemplo');
  await page.waitForFunction(() => window.__voo.areaHa > 40 && document.querySelector('#blocoLargura').hidden);
  // missões do DJI Fly: um botão por parte, cada KMZ com wpmz/template.kml e wpmz/waylines.wpml
  const { listarZip } = await import('../src/voo.js');
  const nPartes = await page.locator('#partes button').count();
  if (nPartes < 1) falha('nenhuma parte de missão');
  const conferir = async (d, nome) => {
    const buf = await readFile(await d.path());
    const nomes = listarZip(buf).entradas.map((e) => e.nome).sort().join(',');
    if (nomes !== 'wpmz/template.kml,wpmz/waylines.wpml') falha(`${nome}: KMZ com ${nomes}`);
  };
  const [d1] = await Promise.all([page.waitForEvent('download'), page.locator('#partes button').first().click()]);
  if (!/^voo-drone-parte-1-de-\d+\.kmz$/.test(d1.suggestedFilename())) falha('nome ' + d1.suggestedFilename());
  await conferir(d1, 'parte 1');
  const [dt] = await Promise.all([page.waitForEvent('download'), page.click('#btnTeste')]);
  await conferir(dt, 'teste');
  // com a missão-modelo aberta, o arquivo sai com o nome dela e o código do drone dela
  const modelo = kmzDe('wpmz/waylines.wpml', Buffer.from('<kml><wpml:droneEnumValue>77</wpml:droneEnumValue><Placemark/></kml>'));
  await page.setInputFiles('#modelo', { name: '1A2B3C4D-AAAA-BBBB-CCCC-123456789ABC.kmz', mimeType: 'application/vnd.google-earth.kmz', buffer: modelo });
  await page.waitForFunction(() => /código 77/.test(document.querySelector('#modeloInfo').textContent));
  const [dm] = await Promise.all([page.waitForEvent('download'), page.click('#btnTeste')]);
  if (dm.suggestedFilename() !== '1A2B3C4D-AAAA-BBBB-CCCC-123456789ABC.kmz') falha('nome da missão-modelo ' + dm.suggestedFilename());
  const way = new TextDecoder().decode(await readFile(await dm.path()));
  if (!way.includes('<wpml:droneEnumValue>77</wpml:droneEnumValue>')) falha('código do drone não copiado');
  console.log('partes', nPartes);
  // conferir fotos: fotos com GPS em todos os pontos menos 2
  const { jpegComGPS } = await import('./jpeg.mjs');
  const est = await page.evaluate(() => window.__voo.estacoesGeo.map((e) => [e.lat, e.lon]));
  const arquivos = est.filter((_, i) => i !== 3 && i !== 4).map(([lat, lon], i) => ({
    name: `DJI_${String(i + 1).padStart(4, '0')}.JPG`, mimeType: 'image/jpeg',
    buffer: Buffer.from(jpegComGPS({ lat, lon, data: `2026:11:11 10:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}` })),
  }));
  arquivos.push({ name: 'sem-gps.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]) });
  await page.setInputFiles('#fotos', arquivos);
  await page.waitForFunction(() => window.__conferencia && !document.querySelector('#fotosResultado').hidden);
  const conf = await page.evaluate(() => ({ falta: __conferencia.faltando, total: __conferencia.total, ok: document.querySelector('#cOk').textContent }));
  if (conf.falta !== 2) falha('conferência ' + JSON.stringify(conf));
  if (!/sem localização/.test(await page.locator('#fotosInfo').textContent())) falha('aviso de foto sem GPS');
  const [dc] = await Promise.all([page.waitForEvent('download'), page.click('#btnCSV')]);
  const csv = (await readFile(await dc.path(), 'utf8')).trim().split(/\r?\n/);
  if (csv.length !== arquivos.length) falha('CSV com ' + csv.length + ' linhas');
  await page.screenshot({ path: join(saida, 'captura-fotos.png') });
  console.log('conferir fotos ok', JSON.stringify(conf));
  console.log('missões ok');
} finally {
  await browser.close();
  srv.close();
}
if (erros.length) { console.error('ERROS NO CONSOLE:\n' + erros.join('\n')); process.exit(1); }
