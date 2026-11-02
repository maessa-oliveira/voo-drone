# Voo Drone

[![CI](https://github.com/maessa-oliveira/voo-drone/actions/workflows/ci.yml/badge.svg)](https://github.com/maessa-oliveira/voo-drone/actions/workflows/ci.yml)
[![Demo](https://img.shields.io/badge/demo-online-33a39a)](https://maessa-oliveira.github.io/voo-drone/)
[![Licença: MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-green)](LICENSE)

**Planejador de voo fotogramétrico para drones, no navegador.** Desenhe a área no mapa, escolha o
drone, a altura e as sobreposições, e veja na hora o **GSD**, as **linhas de voo**, o **número de
fotos**, o **tempo de voo**, as **baterias** e a **precisão esperada**. Exporta o plano em **KML**.

👉 **[Abrir o planejador](https://maessa-oliveira.github.io/voo-drone/)**: já abre com uma área de exemplo.

> 🇬🇧 *Browser-based photogrammetric flight planner for drone mapping: GSD, flight lines, photo count,
> flight time, batteries and expected accuracy, with KML export.*

## O que calcula

| Grandeza | Fórmula |
|---|---|
| GSD (cm/px) | sensor × altura ÷ (focal × pixels) |
| Pegada da foto | GSD × pixels (largura e altura) |
| Espaçamento entre linhas | largura da pegada × (1 − sobreposição lateral) |
| Espaçamento entre fotos | altura da pegada × (1 − sobreposição frontal) |
| Velocidade máxima | menor entre: base ÷ intervalo da câmera, arrasto ≤ 0,5 px a 1/1000 s, 12 m/s |
| Tempo | percurso ÷ velocidade + curvas |
| Precisão esperada | H ≈ 1–2 × GSD, V ≈ 1,5–3 × GSD (com RTK/PPK ou pontos de controle) |

- Linhas em **zigue-zague** recortadas no polígono (funciona em áreas côncavas), com extensão nas
  pontas para cobrir as bordas e direção **automática pelo lado mais longo** (menos curvas).
- Câmeras de mapeamento comuns (Mavic 3 Enterprise, Matrice 4E, Phantom 4 RTK, Zenmuse P1, Mini 4 Pro).
- Mapa de satélite ou de ruas; vértices arrastáveis.

- `src/voo.js`: todo o cálculo, **sem dependência de navegador** (testado em Node).
- `src/app.js`: interface com Leaflet.

## Testes

```bash
npm install
npm test          # cálculo: GSD conferido com o fabricante, linhas, fotos, velocidade, KML
npm run test:e2e  # abre a página num Chromium real, desenha uma área e baixa o KML
```

> Planejamento de referência. Antes de voar, confira as regras da ANAC/DECEA (SARPAS) e o manual
> do equipamento.

## Licença

MIT.
