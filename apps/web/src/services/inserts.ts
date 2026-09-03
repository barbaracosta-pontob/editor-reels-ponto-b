/**
 * Motor de inserts — formatos "Tela dividida" e "Narrado".
 *
 * Dado o plano do Claude (blocos de assunto + termo de busca em inglês), monta
 * os assets de cada bloco. Melhorias desta versão:
 *
 *  - PACING: blocos de foto longos são fatiados em sub-inserts curtos, cada um
 *    com uma FOTO DIFERENTE — a imagem troca mais rápido em vez de ficar parada.
 *  - VARIEDADE: pega vários resultados do Pexels (não só o primeiro) e evita
 *    repetir o mesmo asset, matando o efeito "só foto de dinheiro".
 *  - VÍDEO: tenta b-roll em vídeo (Pexels Video API) antes da foto. Vídeo já tem
 *    movimento, então cobre o bloco inteiro sem precisar fatiar.
 *  - PARALELO: buscas/downloads rodam concorrentes (limite de 6), não em fila.
 *
 * Fontes CC (Openverse/Wikimedia) e overlay de dado recente entram na Etapa B.
 * Roda no servidor (tem rede). Sem PEXELS_API_KEY, os inserts ficam sem asset
 * (a base de vídeo do especialista aparece) e podem ser preenchidos no editor.
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Insert, InsertPlanoItem } from "@pontob/schema";

const PEXELS_PHOTO = "https://api.pexels.com/v1/search";
const PEXELS_VIDEO = "https://api.pexels.com/videos/search";
const OPENVERSE_ENDPOINT = "https://api.openverse.org/v1/images/";

// Pacing: alvo de duração por foto e teto acima do qual o bloco é fatiado.
const FOTO_ALVO_S = 3.5;
const FOTO_TETO_S = 5;
const CONCORRENCIA = 6;
const usarVideo = process.env.INSERTS_VIDEO !== "0"; // vídeo ligado por padrão
// Openverse (imagem real Creative Commons) para blocos "preferir_real". Sem key.
const usarOpenverse = process.env.INSERTS_OPENVERSE !== "0";
// Imagem de busca web/notícia (SerpAPI OU Google Custom Search). Precisa de chave;
// sem chave a fonte não roda. ATENÇÃO: imagem de busca web pode ter direitos
// autorais — decisão do Artur (2026-08-07) de usar mesmo assim, no opt-in por chave.
const SERPER_API_KEY = process.env.SERPER_API_KEY;
const SERPAPI_KEY = process.env.SERPAPI_KEY;
const GOOGLE_CSE_KEY = process.env.GOOGLE_CSE_KEY;
const GOOGLE_CSE_CX = process.env.GOOGLE_CSE_CX;
const usarWebImg = process.env.INSERTS_WEB_IMAGES !== "0" && Boolean(SERPER_API_KEY || SERPAPI_KEY || (GOOGLE_CSE_KEY && GOOGLE_CSE_CX));

type PexelsPhoto = { id?: number; src?: Record<string, string>; photographer?: string };
type PexelsPhotoResp = { photos?: PexelsPhoto[] };
type PexelsVideoFile = { link?: string; quality?: string; width?: number; height?: number; file_type?: string };
type PexelsVideo = { id?: number; duration?: number; user?: { name?: string }; video_files?: PexelsVideoFile[] };
type PexelsVideoResp = { videos?: PexelsVideo[] };

// Teto de tamanho do b-roll: meia-tela não precisa de arquivo enorme, e vídeo
// gigante trava o player (fica preto) e o export. ~28MB cobre bem 3-6s de HD.
const MAX_VIDEO_BYTES = 28 * 1024 * 1024;

/** Descobre o tamanho de um arquivo remoto via HEAD (Content-Length). null se desconhecido. */
async function tamanhoRemoto(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    if (!res.ok) return null;
    const len = res.headers.get("content-length");
    return len ? parseInt(len, 10) : null;
  } catch {
    return null;
  }
}

/** Executa fn sobre items com no máximo `limit` em paralelo, preservando ordem. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const ret = new Array<R>(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      ret[cur] = await fn(items[cur], cur);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return ret;
}

async function baixar(url: string, dest: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(dest, buf);
    return true;
  } catch {
    return false;
  }
}

/** Busca até `n` fotos distintas (ids não usados) para uma query. */
async function buscarFotos(query: string, key: string, n: number, usados: Set<number>): Promise<PexelsPhoto[]> {
  // Sem filtro de orientacao: acervo maior => mais relevancia. O enquadramento
  // fica por conta do objectFit:cover no render (a metade recorta o que sobra).
  const url = `${PEXELS_PHOTO}?query=${encodeURIComponent(query)}&per_page=20&size=large`;
  const res = await fetch(url, { headers: { Authorization: key } });
  if (!res.ok) {
    console.warn(`[inserts] Pexels foto HTTP ${res.status} query="${query}"`);
    return [];
  }
  const data = (await res.json()) as PexelsPhotoResp;
  const fotos = data.photos ?? [];
  const escolhidas: PexelsPhoto[] = [];
  // Primeiro as ainda não usadas (variedade); se faltar, completa com repetição.
  for (const f of fotos) {
    if (escolhidas.length >= n) break;
    if (f.id != null && usados.has(f.id)) continue;
    escolhidas.push(f);
    if (f.id != null) usados.add(f.id);
  }
  for (const f of fotos) {
    if (escolhidas.length >= n) break;
    if (escolhidas.includes(f)) continue;
    escolhidas.push(f);
  }
  return escolhidas;
}

/** Busca um b-roll de vídeo (não repetido) que CUBRA o bloco inteiro e seja LEVE.
 *  Exige clipe com duração >= minDur (senão o vídeo acaba antes do bloco e sobra
 *  preto — o OffthreadVideo dessa versão do Remotion não faz loop). Resolução
 *  moderada e descarta arquivos > MAX_VIDEO_BYTES (evita o 116MB que travava).
 *  Sem orientação: b-roll vertical em stock é raro; o cover recorta o paisagem. */
async function buscarVideo(query: string, key: string, usados: Set<number>, minDur: number): Promise<{ link: string; id: number; credito?: string } | null> {
  const url = `${PEXELS_VIDEO}?query=${encodeURIComponent(query)}&per_page=15&size=medium`;
  const res = await fetch(url, { headers: { Authorization: key } });
  if (!res.ok) {
    console.warn(`[inserts] Pexels vídeo HTTP ${res.status} query="${query}"`);
    return null;
  }
  const data = (await res.json()) as PexelsVideoResp;
  // Só clipes que cobrem o bloco (duração >= minDur, com pequena tolerância) e não
  // repetidos. Sem cobertura suficiente → cai pra foto (que preenche qualquer tempo).
  const candidatos = (data.videos ?? []).filter(
    (v) => (v.id == null || !usados.has(v.id)) && (v.duration ?? 0) >= minDur - 0.3,
  );

  for (const video of candidatos.slice(0, 8)) {
    // mp4 de resolução moderada (>=480, <=1080), MENOR primeiro (arquivo menor).
    const mp4s = (video.video_files ?? [])
      .filter((f) => (f.file_type ?? "").includes("mp4") && f.link && (f.height ?? 0) >= 480 && (f.height ?? 0) <= 1080)
      .sort((a, b) => (a.height ?? 0) - (b.height ?? 0));
    for (const f of mp4s.slice(0, 3)) {
      const tam = await tamanhoRemoto(f.link as string);
      if (tam != null && tam > MAX_VIDEO_BYTES) continue; // grande demais: tenta o próximo
      if (video.id != null) usados.add(video.id);
      return { link: f.link as string, id: video.id ?? -1, credito: video.user?.name ? `Vídeo: ${video.user.name} (Pexels)` : undefined };
    }
  }
  return null; // nada dentro do limite → cai pra foto
}

type OpenverseResult = { id?: string; url?: string; thumbnail?: string; title?: string; creator?: string; source?: string; license?: string };
type OpenverseResp = { results?: OpenverseResult[] };

/**
 * Busca imagens REAIS licenciadas (Creative Commons/domínio público) no Openverse
 * — usado em blocos que citam algo nomeável (pessoa, empresa, lugar, evento) onde
 * stock genérico não serve. Usa o thumbnail proxied da própria Openverse (evita
 * bloqueio de hotlink da fonte original). Requer atribuição (guardada em credito).
 */
async function buscarOpenverse(query: string, n: number, usados: Set<string>): Promise<{ url: string; credito?: string }[]> {
  const url = `${OPENVERSE_ENDPOINT}?q=${encodeURIComponent(query)}&license_type=commercial&mature=false&page_size=20`;
  const res = await fetch(url, { headers: { "User-Agent": "PontoB-Editor/1.0 (+editor-reels)" } });
  if (!res.ok) {
    console.warn(`[inserts] Openverse HTTP ${res.status} query="${query}"`);
    return [];
  }
  const data = (await res.json()) as OpenverseResp;
  const results = data.results ?? [];
  const out: { url: string; credito?: string }[] = [];
  for (const r of results) {
    if (out.length >= n) break;
    const src = r.thumbnail || r.url; // thumbnail = proxy da Openverse (confiável)
    if (!src) continue;
    if (r.id && usados.has(r.id)) continue;
    if (r.id) usados.add(r.id);
    const autor = r.creator || r.title || r.source || "";
    const lic = (r.license || "").toUpperCase();
    const fonte = r.source ?? "Openverse";
    out.push({ url: src, credito: autor ? `Imagem: ${autor}${lic ? ` (${fonte}, ${lic})` : ""}` : undefined });
  }
  return out;
}

type SerperImage = { imageUrl?: string; source?: string; domain?: string; title?: string };
type SerperResp = { images?: SerperImage[] };
type SerpImage = { original?: string; source?: string; link?: string };
type SerpResp = { images_results?: SerpImage[] };
type GcseItem = { link?: string; displayLink?: string; image?: { contextLink?: string } };
type GcseResp = { items?: GcseItem[] };

/**
 * Busca imagens na web (notícia/tópico real) via Serper.dev, SerpAPI (Google
 * Imagens) OU Google Custom Search — o primeiro que estiver configurado por
 * chave. Retorna URLs de imagem diretas. NÃO é fonte licenciada: pode ter
 * direitos autorais (opt-in por chave, decisão do Artur).
 */
async function buscarWebImagens(query: string, n: number, usados: Set<string>): Promise<{ url: string; credito?: string }[]> {
  const out: { url: string; credito?: string }[] = [];
  try {
    if (SERPER_API_KEY) {
      const res = await fetch("https://google.serper.dev/images", {
        method: "POST",
        headers: { "X-API-KEY": SERPER_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ q: query, num: 20 }),
      });
      if (!res.ok) { console.warn(`[inserts] Serper HTTP ${res.status} query="${query}"`); return []; }
      const data = (await res.json()) as SerperResp;
      for (const r of data.images ?? []) {
        if (out.length >= n) break;
        const src = r.imageUrl;
        if (!src || usados.has(src)) continue;
        usados.add(src);
        const dom = r.source || r.domain;
        out.push({ url: src, credito: dom ? `Imagem: ${dom} (web)` : "Imagem: web" });
      }
    } else if (SERPAPI_KEY) {
      const url = `https://serpapi.com/search.json?engine=google_images&q=${encodeURIComponent(query)}&num=20&api_key=${SERPAPI_KEY}`;
      const res = await fetch(url);
      if (!res.ok) { console.warn(`[inserts] SerpAPI HTTP ${res.status} query="${query}"`); return []; }
      const data = (await res.json()) as SerpResp;
      for (const r of data.images_results ?? []) {
        if (out.length >= n) break;
        const src = r.original;
        if (!src || usados.has(src)) continue;
        usados.add(src);
        out.push({ url: src, credito: r.source ? `Imagem: ${r.source} (web)` : "Imagem: web" });
      }
    } else if (GOOGLE_CSE_KEY && GOOGLE_CSE_CX) {
      const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_CSE_KEY}&cx=${GOOGLE_CSE_CX}&searchType=image&num=10&q=${encodeURIComponent(query)}`;
      const res = await fetch(url);
      if (!res.ok) { console.warn(`[inserts] Google CSE HTTP ${res.status} query="${query}"`); return []; }
      const data = (await res.json()) as GcseResp;
      for (const r of data.items ?? []) {
        if (out.length >= n) break;
        const src = r.link;
        if (!src || usados.has(src)) continue;
        usados.add(src);
        out.push({ url: src, credito: r.displayLink ? `Imagem: ${r.displayLink} (web)` : "Imagem: web" });
      }
    }
  } catch (e) {
    console.warn(`[inserts] falha na busca de imagem web (query="${query}"):`, e);
    return out;
  }
  return out;
}

/**
 * Monta os inserts de um bloco a partir de uma lista de imagens (web, Openverse
 * ou Pexels), fatiando blocos longos em sub-inserts curtos (pacing). overlay só
 * na primeira fatia. Fonte/crédito preservados.
 */
async function montarFatiasImagem(
  base: Insert,
  item: InsertPlanoItem,
  dur: number,
  bi: number,
  nFatias: number,
  imgs: { url: string; credito?: string }[],
  fonte: NonNullable<Insert["fonte"]>,
  insertsDir: string,
  jobId: string,
): Promise<Insert[]> {
  const passo = dur / nFatias;
  const saidas: Insert[] = [];
  for (let s = 0; s < nFatias; s++) {
    const img = imgs[Math.min(s, imgs.length - 1)];
    const ini = item.inicio + passo * s;
    const fim = s === nFatias - 1 ? item.fim : item.inicio + passo * (s + 1);
    const parcial: Insert = {
      ...base,
      inicio: Math.round(ini * 100) / 100,
      fim: Math.round(fim * 100) / 100,
      overlay_texto: s === 0 ? item.overlay_texto : undefined,
    };
    if (!img?.url) { saidas.push(parcial); continue; }
    const filename = `insert_${bi}_${s}.jpg`;
    if (await baixar(img.url, path.join(insertsDir, filename))) {
      saidas.push({ ...parcial, image_url: `/api/jobs/${jobId}/inserts/${filename}`, fonte, credito: img.credito });
    } else {
      saidas.push(parcial);
    }
  }
  return saidas;
}

export async function buscarInserts(
  jobDir: string,
  jobId: string,
  plano: InsertPlanoItem[],
): Promise<Insert[]> {
  const key = process.env.PEXELS_API_KEY;
  const insertsDir = path.join(jobDir, "inserts");
  await mkdir(insertsDir, { recursive: true });

  // Sem chave: devolve os blocos como inserts "vazios" (sem asset).
  if (!key) {
    return plano.map((item) => ({
      inicio: item.inicio,
      fim: item.fim,
      query: item.query,
      descricao: item.descricao,
      tipo: "imagem" as const,
      overlay_texto: item.overlay_texto,
    }));
  }

  const usadosFoto = new Set<number>();
  const usadosVideo = new Set<number>();
  const usadosOpenverse = new Set<string>();
  const usadosWeb = new Set<string>();

  // Cada bloco do plano vira 1+ inserts. Processados em paralelo (limite),
  // resultado remontado em ordem de timeline.
  const porBloco = await mapLimit(plano, CONCORRENCIA, async (item, bi): Promise<Insert[]> => {
    const dur = Math.max(0, item.fim - item.inicio);
    const base: Insert = {
      inicio: item.inicio,
      fim: item.fim,
      query: item.query,
      descricao: item.descricao,
      tipo: "imagem",
      overlay_texto: item.overlay_texto,
    };
    const nFatias = dur > FOTO_TETO_S ? Math.max(2, Math.round(dur / FOTO_ALVO_S)) : 1;

    // 0) preferir_real → imagem REAL do tema (pessoa/empresa/lugar/evento nomeado).
    //    Stock genérico não serve aqui. Não usa vídeo nesses blocos.
    if (item.preferir_real) {
      // 0a) imagem de busca web/notícia (se provedor com chave configurado).
      if (usarWebImg) {
        try {
          const imgs = await buscarWebImagens(item.query, nFatias, usadosWeb);
          if (imgs.length) return await montarFatiasImagem(base, item, dur, bi, nFatias, imgs, "web", insertsDir, jobId);
        } catch (e) {
          console.warn(`[inserts] falha na imagem web do bloco ${bi} (query="${item.query}"):`, e);
        }
      }
      // 0b) Openverse (imagem real licenciada CC).
      if (usarOpenverse) {
        try {
          const imgs = await buscarOpenverse(item.query, nFatias, usadosOpenverse);
          if (imgs.length) return await montarFatiasImagem(base, item, dur, bi, nFatias, imgs, "openverse", insertsDir, jobId);
        } catch (e) {
          console.warn(`[inserts] falha no Openverse do bloco ${bi} (query="${item.query}"):`, e);
        }
      }
      // sem resultado real: cai para o fluxo normal (vídeo/foto) abaixo.
    }

    // 1) Tenta vídeo (b-roll cobre o bloco inteiro; movimento dá o pacing).
    if (usarVideo) {
      try {
        const v = await buscarVideo(item.query, key, usadosVideo, dur);
        if (v) {
          const filename = `insert_${bi}.mp4`;
          if (await baixar(v.link, path.join(insertsDir, filename))) {
            return [{
              ...base,
              tipo: "video",
              video_url: `/api/jobs/${jobId}/inserts/${filename}`,
              fonte: "pexels_video",
              credito: v.credito,
            }];
          }
        }
      } catch (e) {
        console.warn(`[inserts] falha no vídeo do bloco ${bi} (query="${item.query}"):`, e);
      }
    }

    // 2) Foto do Pexels — fatia blocos longos em sub-inserts curtos, foto distinta.
    let fotos: PexelsPhoto[] = [];
    try {
      fotos = await buscarFotos(item.query, key, nFatias, usadosFoto);
    } catch (e) {
      console.warn(`[inserts] falha na busca de foto do bloco ${bi} (query="${item.query}"):`, e);
    }
    if (!fotos.length) return [base]; // sem resultado: bloco fica sem asset

    const imgsFoto = fotos.map((f) => ({
      url: (f.src?.large2x ?? f.src?.large ?? f.src?.original ?? ""),
      credito: f.photographer ? `Foto: ${f.photographer} (Pexels)` : undefined,
    }));
    return await montarFatiasImagem(base, item, dur, bi, nFatias, imgsFoto, "pexels", insertsDir, jobId);
  });

  return porBloco.flat();
}

/**
 * Busca UMA foto do tema (nicho/mercado) para servir de fundo do CTA final.
 * Salva como cta_fundo.jpg no job e devolve a URL relativa. Sem chave/resultado,
 * retorna undefined (o CTA cai no gradiente navy).
 */
export async function buscarFotoCta(jobDir: string, jobId: string, query: string): Promise<string | undefined> {
  const key = process.env.PEXELS_API_KEY;
  if (!key || !query.trim()) return undefined;
  try {
    const fotos = await buscarFotos(query, key, 1, new Set<number>());
    const src = fotos[0]?.src?.large2x ?? fotos[0]?.src?.large ?? fotos[0]?.src?.original;
    if (!src) return undefined;
    const insertsDir = path.join(jobDir, "inserts");
    await mkdir(insertsDir, { recursive: true });
    if (await baixar(src, path.join(insertsDir, "cta_fundo.jpg"))) {
      return `/api/jobs/${jobId}/inserts/cta_fundo.jpg`;
    }
  } catch (e) {
    console.warn(`[inserts] falha no fundo do CTA (query="${query}"):`, e);
  }
  return undefined;
}
