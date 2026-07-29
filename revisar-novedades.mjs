// revisar-novedades.mjs
// Revisa las páginas listadas en sitios.json, detecta títulos nuevos desde la
// última corrida, y actualiza novedades.json. Pensado para correr solo, cada
// tantas horas, vía GitHub Actions (Node 20+, sin dependencias del navegador).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as cheerio from "cheerio";

const MAX_NUEVAS_POR_SITIO = 5;   // no inundar con demasiadas de un solo sitio
const MAX_ITEMS_EN_ARCHIVO = 60;  // el archivo que lee Vale se mantiene liviano
const SNAP_DIR = "snapshots";     // "foto" de la última corrida, por sitio

function limpiar(t) {
  return (t || "").replace(/\s+/g, " ").trim();
}

function absoluta(base, href) {
  try { return new URL(href, base).toString(); } catch (e) { return href; }
}

// Heurística de extracción: prueba selectores de más específico a más genérico,
// se queda con el primero que devuelve una cantidad razonable de resultados.
// Sirve bien para sitios WordPress (la mayoría de estos blogs lo son) y,
// como respaldo, para cualquier página que use h2/h3/h4 para sus títulos.
function extraerTitulos($, urlBase) {
  const selectores = [
    "article h2 a, article h3 a, article h4 a",
    ".entry-title a, .post-title a, .td-module-title a, .elementor-post__title a",
    "h2 a, h3 a, h4 a",
  ];
  for (const sel of selectores) {
    const vistos = new Set();
    const items = [];
    $(sel).each((_, el) => {
      const $el = $(el);
      const titulo = limpiar($el.text());
      const href = $el.attr("href") || "";
      if (!titulo || titulo.length < 18 || titulo.length > 170) return;
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
      const url = absoluta(urlBase, href);
      if (vistos.has(url)) return;
      vistos.add(url);
      items.push({ titulo, url });
    });
    if (items.length >= 3) return items.slice(0, 12);
  }
  return [];
}

async function revisarSitio(sitio) {
  const resp = await fetch(sitio.url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; ValeBot/1.0; revisor de novedades personal, uso no comercial)",
    },
  });
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  const html = await resp.text();
  const $ = cheerio.load(html);
  const actuales = extraerTitulos($, sitio.url);

  await mkdir(SNAP_DIR, { recursive: true });
  const snapPath = `${SNAP_DIR}/${sitio.id}.json`;
  let anteriores = [];
  if (existsSync(snapPath)) {
    try { anteriores = JSON.parse(await readFile(snapPath, "utf8")); } catch (e) { anteriores = []; }
  }
  const esPrimeraVez = anteriores.length === 0;
  const urlsAnteriores = new Set(anteriores.map((i) => i.url));

  // En la primera corrida solo establecemos la base: no reportamos como
  // "novedad" todo lo que ya estaba publicado antes de empezar a mirar.
  const nuevas = esPrimeraVez
    ? []
    : actuales.filter((i) => !urlsAnteriores.has(i.url)).slice(0, MAX_NUEVAS_POR_SITIO);

  await writeFile(snapPath, JSON.stringify(actuales, null, 2), "utf8");

  return nuevas.map((i) => ({
    id: sitio.id + "|" + i.url,
    sitio: sitio.nombre,
    titulo: i.titulo,
    url: i.url,
    detectado: new Date().toISOString(),
  }));
}

async function main() {
  const sitios = JSON.parse(await readFile("sitios.json", "utf8"));

  let novedadesPrevias = [];
  if (existsSync("novedades.json")) {
    try {
      novedadesPrevias = JSON.parse(await readFile("novedades.json", "utf8")).items || [];
    } catch (e) { /* archivo corrupto o primera vez: arrancamos de cero */ }
  }

  const nuevasTotales = [];
  for (const sitio of sitios) {
    try {
      const nuevas = await revisarSitio(sitio);
      nuevasTotales.push(...nuevas);
      console.log(sitio.nombre + ": " + nuevas.length + " novedades nuevas");
    } catch (e) {
      console.log(sitio.nombre + ": no se pudo revisar (" + e.message + ")");
    }
  }

  const idsVistos = new Set();
  const items = [...nuevasTotales, ...novedadesPrevias]
    .filter((i) => {
      if (idsVistos.has(i.id)) return false;
      idsVistos.add(i.id);
      return true;
    })
    .slice(0, MAX_ITEMS_EN_ARCHIVO);

  const salida = { actualizado: new Date().toISOString(), items };
  await writeFile("novedades.json", JSON.stringify(salida, null, 2), "utf8");
  console.log("Total de novedades en el archivo: " + items.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
