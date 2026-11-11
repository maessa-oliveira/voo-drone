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
  console.log('missões ok');
} finally {
  await browser.close();
  srv.close();
}
if (erros.length) { console.error('ERROS NO CONSOLE:\n' + erros.join('\n')); process.exit(1); }
