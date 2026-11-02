// Teste de ponta a ponta: abre a página num Chromium real, confere o plano do exemplo,
// muda a altura, desenha uma área clicando no mapa e baixa o KML. Uso: node tests/e2e.mjs [saida]
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const raiz = resolve(new URL('..', import.meta.url).pathname);
const tipos = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
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
  // KML
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnKML')]);
  const kml = await readFile(await dl.path(), 'utf8');
  if (!kml.includes('<LineString>') || !kml.trim().endsWith('</kml>')) falha('KML inválido');
  console.log('interação ok', JSON.stringify(tri), 'kml', kml.length, 'bytes');
} finally {
  await browser.close();
  srv.close();
}
if (erros.length) { console.error('ERROS NO CONSOLE:\n' + erros.join('\n')); process.exit(1); }
