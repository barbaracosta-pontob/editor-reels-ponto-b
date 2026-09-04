/**
 * Composição Reel para uso no @remotion/player no browser (Next.js).
 *
 * Diferença do apps/remotion: usa <Video> (client-side) em vez de
 * <OffthreadVideo> (server-side render only). Mesma lógica visual.
 */

import {
  AbsoluteFill,
  Sequence,
  Video,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
  Audio,
  staticFile,
  Img,
} from "remotion";
import { useEffect } from "react";
import type { ReelProps, Cena, LegendaConfig, LegendaPalavra, Regiao, CtaFinal as CtaFinalConfig, CaixinhaPergunta as CaixinhaConfig } from "@pontob/schema";
import { agruparEmFrases, posicaoEfetiva, cenaSuprimeLegenda } from "@pontob/schema";

const FPS = 30;

// ── Tema inline (espelho do apps/remotion/src/theme.ts) ──────────────────────

const colors = {
  navy: "#0A1628",
  navyDeep: "#050B14",
  red: "#E63946",
  white: "#FFFFFF",
  whiteSoft: "#F4F6F8",
  yellow: "#F4C430",
  textMuted: "#8B95A1",
} as const;

const typography = {
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  weightHero: 900,
  weightTitle: 800,
  weightBody: 600,
  weightCaption: 500,
  sizeHero: 96,
  sizeTitle: 72,
  sizeSubtitle: 48,
  sizeBody: 44,
  sizeCaption: 32,
  trackingTight: -1.5,
  trackingNormal: 0,
  trackingWide: 2,
  lineHeightTight: 1.0,
  lineHeightBody: 1.3,
} as const;

const spacing = {
  xs: 8, sm: 16, md: 32, lg: 64, xl: 96, xxl: 144,
} as const;

function makeCorDestaque(corPrimaria?: string, corSecundaria?: string) {
  return (cor: "primaria" | "secundaria" | "branco"): string => {
    switch (cor) {
      case "primaria": return corPrimaria ?? colors.red;
      case "secundaria": return corSecundaria ?? colors.yellow;
      case "branco": return colors.white;
    }
  };
}

const DEFAULT_FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

function resolveFontFamily(fonteFamilia?: string): string {
  return fonteFamilia && fonteFamilia.trim() ? fonteFamilia : DEFAULT_FONT_FAMILY;
}

/**
 * Constrói um mapa de cores por índice de token, suportando palavras compostas (ex: "20 MIL").
 * tokens: resultado de texto.split(/(\s+)/)
 * palavras: array de {palavra, cor}
 * resolver: makeCorDestaque(...)
 */
function resolveWordColor(cor: string, corPrimaria?: string, corSecundaria?: string): string {
  const lower = cor.toLowerCase().trim();
  if (lower === "primaria") return corPrimaria ?? colors.red;
  if (lower === "secundaria") return corSecundaria ?? colors.yellow;
  if (lower === "branco" || lower === "white") return colors.white;
  return cor;
}

function buildTokenCorMap(
  tokens: string[],
  palavras: Array<{ palavra: string; cor: string }>,
  corPrimaria?: string,
  corSecundaria?: string,
): (string | null)[] {
  const corMap: (string | null)[] = new Array(tokens.length).fill(null);
  for (const pw of palavras) {
    const corResolvida = resolveWordColor(pw.cor, corPrimaria, corSecundaria);
    const palavraLimpa = pw.palavra.toLowerCase().replace(/[.,!?;:]/g, "");
    const palavraTokens = palavraLimpa.split(/\s+/).filter(Boolean);
    let ti = 0;
    while (ti < tokens.length) {
      const candidates: number[] = [];
      let j = ti;
      while (j < tokens.length && candidates.length < palavraTokens.length) {
        if (tokens[j].trim()) candidates.push(j);
        j++;
      }
      if (candidates.length === palavraTokens.length) {
        const match = candidates.every((idx, k) =>
          tokens[idx].trim().replace(/[.,!?;:]/g, "").toLowerCase() === palavraTokens[k]
        );
        if (match) {
          candidates.forEach((idx) => { corMap[idx] = corResolvida; });
        }
      }
      ti++;
    }
  }
  return corMap;
}

// ── Reel (composição principal) ───────────────────────────────────────────────

export const ReelForPlayer: React.FC<ReelProps> = (props) => {
  const sequencias = (() => {
    let cursor = 0;
    return props.cenas.map((cena, index) => {
      const duracaoFrames = Math.max(1, Math.round(cena.duracao_segundos * FPS));
      // Se a cena de overlay tem inicio_overlay_segundos definido pelo usuário,
      // ele sobrescreve o cursor acumulado.
      const cenaComInicio = cena as Record<string, unknown>;
      const inicioOverride = typeof cenaComInicio["inicio_overlay_segundos"] === "number"
        ? (cenaComInicio["inicio_overlay_segundos"] as number)
        : null;
      const inicioSegundos = inicioOverride !== null ? inicioOverride : cursor;
      const inicioFrames = Math.round(inicioSegundos * FPS);
      cursor += cena.duracao_segundos;
      return { cena, inicioFrames, duracaoFrames, index };
    });
  })();

  const videoPath =
    props.video_original_path ??
    (props.cenas.find((c) => "video_path" in c) as { video_path: string } | undefined)?.video_path;

  const videoStartFrom = Math.round((props.video_start_segundos ?? 0) * FPS);
  const videoEndRaw = (props as Record<string, unknown>).video_end_segundos;
  const videoEndAt = typeof videoEndRaw === "number" && videoEndRaw > (props.video_start_segundos ?? 0)
    ? Math.round(videoEndRaw * FPS)
    : undefined;

  // Carrega a fonte do especialista no browser player
  useEffect(() => {
    if (!props.fonte_url) return;
    const existing = document.querySelector(`link[href="${props.fonte_url}"]`);
    if (existing) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = props.fonte_url;
    document.head.appendChild(link);
  }, [props.fonte_url]);

  // Caixinha de pergunta: overlay compartilhado por todos os formatos (espelho
  // do comCaixinha de Reel.tsx).
  //
  // A declaracao precisa vir ANTES do primeiro uso. Ela estava depois dos
  // returns de "tela_dividida" e "aula", e como `const` nao sobe (fica na
  // temporal dead zone ate a linha da declaracao), abrir o preview nesses dois
  // formatos estourava "ReferenceError: Cannot access 'comCaixinha' before
  // initialization". Os outros formatos funcionavam porque so alcancavam o
  // comCaixinha depois da linha que o define. So o player era afetado - o
  // render usa Reel.tsx, que tem a sua propria copia.
  const comCaixinha = (conteudo: React.ReactNode) => (
    <AbsoluteFill>
      {conteudo}
      <CaixinhaPerguntaSequencePlayer props={props} />
    </AbsoluteFill>
  );

  // Formato "tela dividida": layout próprio (espelho de TelaDividida do render).
  if (props.formato === "tela_dividida") {
    return comCaixinha(<SplitLayoutPlayer props={props} />);
  }
  if (props.formato === "aula") {
    return comCaixinha(<AulaLayoutPlayer props={props} />);
  }
  if (props.formato === "narrado") {
    return comCaixinha(<NarradoLayoutPlayer props={props} />);
  }
  if (props.formato === "caixinha_pergunta") {
    return comCaixinha(<CaixinhaLayoutPlayer props={props} />);
  }

  return comCaixinha(
    <AbsoluteFill style={{ backgroundColor: colors.navy }}>
      {videoPath ? (
        <Video
          src={videoPath}
          startFrom={videoStartFrom}
          {...(videoEndAt != null ? { endAt: videoEndAt } : {})}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : null}

      {videoPath ? (
        <AbsoluteFill style={{
          background: "linear-gradient(180deg, rgba(0,0,0,0.4) 0%, rgba(0,0,0,0.1) 45%, rgba(0,0,0,0.6) 100%)",
          pointerEvents: "none",
        }} />
      ) : null}

      {/* Música de fundo — toca durante todo o reel */}
      {props.musica_fundo ? (
        <Audio
          src={`/musica/${props.musica_fundo.path.replace(/^musica\//, "")}`}
          volume={Math.min(1, (props.musica_fundo.volume ?? 3) / 10)}
        />
      ) : null}

      {sequencias.map(({ cena, inicioFrames, duracaoFrames, index }) => (
        <Sequence
          key={`${cena.tipo}-${index}`}
          from={inicioFrames}
          durationInFrames={duracaoFrames}
          name={`${index + 1}_${cena.tipo}`}
        >
          <SceneRouter cena={cena} corPrimaria={props.cor_primaria} corSecundaria={props.cor_secundaria} fonteFamilia={props.fonte_familia} />
        </Sequence>
      ))}

      {/* Legenda contínua — espelho do apps/remotion (LegendaContinua). */}
      {props.legenda?.ativa && props.legenda_palavras && props.legenda_palavras.length > 0 ? (
        <LegendaOverlay
          palavras={props.legenda_palavras}
          config={props.legenda}
          corPrimaria={props.cor_primaria}
          corSecundaria={props.cor_secundaria}
          fonteFamilia={props.fonte_familia}
          videoStartSegundos={props.video_start_segundos ?? 0}
          janelasSuprimidas={sequencias
            .filter(({ cena }) => cenaSuprimeLegenda(cena.tipo))
            .map(({ inicioFrames, duracaoFrames }) => [inicioFrames, inicioFrames + duracaoFrames] as [number, number])}
        />
      ) : null}
    </AbsoluteFill>,
  );
};

// ── Legenda contínua (overlay) ────────────────────────────────────────────────
// Espelho de apps/remotion/src/scenes/LegendaContinua.tsx para o preview no
// @remotion/player. Mesma lógica; usa o tema inline deste arquivo.

const LEG_SOMBRA = "0 4px 20px rgba(0,0,0,0.55), 0 2px 4px rgba(0,0,0,0.65)";
const LEG_SOMBRA_FORTE = "0 0 3px rgba(0,0,0,0.95), 0 0 10px rgba(0,0,0,0.9), 0 3px 14px rgba(0,0,0,0.85)";
const LEG_SEGURA_SILENCIO_S = 1.0;

function legIndiceAtivo(palavras: { inicio: number }[], t: number): number {
  let idx = -1;
  for (let i = 0; i < palavras.length; i++) {
    if (palavras[i].inicio <= t) idx = i;
    else break;
  }
  return idx;
}

const LegendaOverlay: React.FC<{
  palavras: LegendaPalavra[];
  config: LegendaConfig;
  corPrimaria?: string;
  corSecundaria?: string;
  fonteFamilia?: string;
  videoStartSegundos: number;
  janelasSuprimidas: [number, number][];
  posicaoForcada?: "alto" | "centro" | "rodape";
  offsetSeamPct?: number;
}> = ({ palavras, config, corPrimaria, corSecundaria, fonteFamilia, videoStartSegundos, janelasSuprimidas, posicaoForcada, offsetSeamPct }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const scale = Math.min(width / 1080, height / 1920);
  const safeBottom = Math.round(height * 0.22);
  const safeTop = Math.round(height * 0.105);
  const fontFamily = resolveFontFamily(fonteFamilia);
  const posicao = posicaoForcada ?? posicaoEfetiva(config);
  const sombra = posicaoForcada != null ? LEG_SOMBRA_FORTE : LEG_SOMBRA;
  const padX = Math.round(64 * scale);

  if (janelasSuprimidas.some(([a, b]) => frame >= a && frame < b)) return null;
  if (!palavras.length) return null;

  const t = videoStartSegundos + frame / fps;
  const framesDe = (s: number) => Math.round((s - videoStartSegundos) * fps);
  const popDe = (inicioSeg: number) => {
    const s = spring({ frame: Math.max(0, frame - framesDe(inicioSeg)), fps, config: { damping: 16, stiffness: 120, mass: 0.5 } });
    return { opacity: interpolate(s, [0, 1], [0, 1]), scale: interpolate(s, [0, 1], [0.72, 1]) };
  };

  const container: React.CSSProperties = {
    alignItems: "center",
    padding: `0 ${padX}px`,
    textAlign: "center",
    pointerEvents: "none",
    ...(posicao === "alto"
      ? { justifyContent: "flex-start", paddingTop: Math.round(safeTop + height * 0.06) }
      : posicao === "rodape"
      ? { justifyContent: "flex-end", paddingBottom: safeBottom }
      : { justifyContent: "center" }),
  };
  const offsetY = Math.round((((config.deslocamento_y ?? 0) + (offsetSeamPct ?? 0)) / 100) * height);
  if (offsetY !== 0) container.transform = `translateY(${offsetY}px)`;
  const caixaStyle: React.CSSProperties = config.caixa
    ? { background: "rgba(0,0,0,0.55)", padding: `${Math.round(10 * scale)}px ${Math.round(22 * scale)}px`, borderRadius: Math.round(14 * scale) }
    : {};
  const envolver = (inner: React.ReactNode) => <AbsoluteFill style={container}>{inner}</AbsoluteFill>;

  if (config.estilo === "palavra_unica") {
    const idx = legIndiceAtivo(palavras, t);
    if (idx < 0) return null;
    const atual = palavras[idx];
    const proxInicio = palavras[idx + 1]?.inicio ?? Infinity;
    if (t > atual.fim + LEG_SEGURA_SILENCIO_S && t < proxInicio) return null;
    const pop = popDe(atual.inicio);
    return envolver(
      <div style={{ ...caixaStyle, fontFamily, fontWeight: 800, fontSize: Math.round(90 * scale), lineHeight: 1.05, letterSpacing: -1, color: colors.white, textShadow: sombra, opacity: pop.opacity, transform: `scale(${pop.scale})` }}>
        {atual.texto}
      </div>,
    );
  }

  const frases = agruparEmFrases(palavras, config.palavras_por_frase ?? 3);
  const fi = legIndiceAtivo(frases, t);
  if (fi < 0) return null;
  const frase = frases[fi];
  const proximaFrase = frases[fi + 1]?.inicio ?? Infinity;
  if (t > frase.fim + LEG_SEGURA_SILENCIO_S && t < proximaFrase) return null;

  if (config.estilo === "frase_limpa") {
    const s = spring({ frame: Math.max(0, frame - framesDe(frase.inicio)), fps, config: { damping: 200, stiffness: 100 } });
    return envolver(
      <div style={{ ...caixaStyle, fontFamily, fontWeight: 700, fontSize: Math.round(48 * scale), lineHeight: 1.22, color: colors.white, textShadow: sombra, maxWidth: "90%", opacity: interpolate(s, [0, 1], [0, 1]) }}>
        {frase.palavras.map((p) => p.texto).join(" ")}
      </div>,
    );
  }

  const corDestaque = resolveWordColor(config.cor_destaque ?? "primaria", corPrimaria, corSecundaria);
  return envolver(
    <div style={{ ...caixaStyle, fontFamily, fontWeight: 800, fontSize: Math.round(56 * scale), lineHeight: 1.15, letterSpacing: -0.5, textShadow: sombra, maxWidth: "92%", display: "flex", flexWrap: "wrap", justifyContent: "center", gap: `${Math.round(6 * scale)}px ${Math.round(16 * scale)}px` }}>
      {frase.palavras.map((p, i) => {
        const jaFalada = p.inicio <= t;
        const proxNaFrase = frase.palavras[i + 1]?.inicio ?? frase.fim + 0.001;
        const ativa = t >= p.inicio && t < proxNaFrase;
        const pop = popDe(p.inicio);
        return (
          <span key={i} style={{ color: ativa ? corDestaque : colors.white, opacity: jaFalada ? pop.opacity : 0.32, transform: ativa ? `scale(${pop.scale})` : "none", display: "inline-block" }}>
            {p.texto}
          </span>
        );
      })}
    </div>,
  );
};

// ── Tela dividida (espelho de apps/remotion/src/scenes/TelaDividida.tsx) ──────

const InsertKenBurnsPlayer: React.FC<{ src: string; durF: number }> = ({ src, durF }) => {
  const frame = useCurrentFrame();
  const k = interpolate(frame, [0, durF], [1.0, 1.1], { extrapolateRight: "clamp" });
  const px = interpolate(frame, [0, durF], [-2, 2], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${k}) translateX(${px}%)` }} />
    </AbsoluteFill>
  );
};

/** B-roll de vídeo (mudo) — espelho de InsertVideo/InsertFullVideo. Sem fade. */
const InsertVideoPlayer: React.FC<{ src: string }> = ({ src }) => {
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <Video src={src} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    </AbsoluteFill>
  );
};

/** Faixa de texto sobre o insert — espelho de OverlayTextoInsert. */
const OverlayTextoInsertPlayer: React.FC<{ texto: string }> = ({ texto }) => (
  <AbsoluteFill style={{ justifyContent: "flex-end", pointerEvents: "none" }}>
    <div style={{ margin: "0 5% 7%", background: "rgba(8,15,25,0.82)", borderLeft: "5px solid #f5a623", borderRadius: 8, padding: "12px 16px", color: "#fff", fontSize: 36, fontWeight: 600, lineHeight: 1.25, textShadow: "0 2px 8px rgba(0,0,0,0.6)" }}>{texto}</div>
  </AbsoluteFill>
);

// Espelho de resolverAssetsInsert: bloco sem asset herda o do vizinho (não fica preto).
type AssetLikeP = { tipo?: string; video_url?: string; image_url?: string };
function resolverAssetsPlayer<T extends AssetLikeP>(inserts: T[]): (T | null)[] {
  const tem = (x?: T | null) => !!x && ((x.tipo === "video" && !!x.video_url) || !!x.image_url);
  const out: (T | null)[] = new Array(inserts.length).fill(null);
  let ult: T | null = null;
  for (let i = 0; i < inserts.length; i++) { if (tem(inserts[i])) ult = inserts[i]; out[i] = tem(inserts[i]) ? inserts[i] : ult; }
  let prox: T | null = null;
  for (let i = inserts.length - 1; i >= 0; i--) { if (tem(inserts[i])) prox = inserts[i]; if (!out[i]) out[i] = prox; }
  return out;
}

const SplitLayoutPlayer: React.FC<{ props: ReelProps }> = ({ props }) => {
  const { width, height } = useVideoConfig();
  const vertical = height >= width;
  const cfg = props.tela_dividida;
  const splitPct = cfg?.split_pct ?? 55;
  const especialistaPrimeiro = (cfg?.especialista_posicao ?? "inicio") === "inicio";
  const inserts = cfg?.inserts ?? [];

  const videoStart = props.video_start_segundos ?? 0;
  const videoStartFrom = Math.round(videoStart * FPS);
  const videoEndRaw = (props as Record<string, unknown>).video_end_segundos;
  const videoEndAt = typeof videoEndRaw === "number" && videoEndRaw > videoStart ? Math.round(videoEndRaw * FPS) : undefined;
  const videoPath = props.video_original_path ?? undefined;

  const videoHalf = (
    <AbsoluteFill style={{ overflow: "hidden", background: "#000" }}>
      {videoPath ? (
        <>
          <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
            <defs>
              <filter id="esp-sharpen">
                <feConvolveMatrix order="3" preserveAlpha="true" kernelMatrix="0 -0.4 0  -0.4 2.6 -0.4  0 -0.4 0" />
              </filter>
            </defs>
          </svg>
          <Video src={videoPath} startFrom={videoStartFrom} {...(videoEndAt != null ? { endAt: videoEndAt } : {})} style={{ width: "100%", height: "100%", objectFit: "cover", filter: "url(#esp-sharpen)" }} />
        </>
      ) : null}
    </AbsoluteFill>
  );
  const fromsSplit = inserts.map((ins) => Math.max(0, Math.round((ins.inicio - videoStart) * FPS)));
  const endFrameRelSplit = videoEndAt != null
    ? videoEndAt - videoStartFrom
    : (inserts.length ? fromsSplit[fromsSplit.length - 1] + Math.max(1, Math.round((inserts[inserts.length - 1].fim - inserts[inserts.length - 1].inicio) * FPS)) : 0);
  const assetsSplit = resolverAssetsPlayer(inserts);
  const insertHalf = (
    <AbsoluteFill style={{ overflow: "hidden", background: "#000" }}>
      {inserts.map((ins, i) => {
        const asset = assetsSplit[i];
        if (!asset) return null;
        const ehVideo = asset.tipo === "video" && !!asset.video_url;
        const from = fromsSplit[i];
        const durF = Math.max(1, (i < inserts.length - 1 ? fromsSplit[i + 1] : endFrameRelSplit) - from);
        return (
          <Sequence key={i} from={from} durationInFrames={durF} name={`insert-${i}`}>
            {ehVideo ? <InsertVideoPlayer src={asset.video_url as string} /> : <InsertKenBurnsPlayer src={asset.image_url as string} durF={durF} />}
            {ins.overlay_texto ? <OverlayTextoInsertPlayer texto={ins.overlay_texto} /> : null}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );

  const a = especialistaPrimeiro ? videoHalf : insertHalf;
  const b = especialistaPrimeiro ? insertHalf : videoHalf;
  const primeiro: React.CSSProperties = vertical
    ? { position: "absolute", top: 0, left: 0, right: 0, height: `${splitPct}%`, overflow: "hidden" }
    : { position: "absolute", top: 0, bottom: 0, left: 0, width: `${splitPct}%`, overflow: "hidden" };
  const segundo: React.CSSProperties = vertical
    ? { position: "absolute", bottom: 0, left: 0, right: 0, height: `${100 - splitPct}%`, overflow: "hidden" }
    : { position: "absolute", top: 0, bottom: 0, right: 0, width: `${100 - splitPct}%`, overflow: "hidden" };

  const legenda = props.legenda;
  const offsetSeam = vertical ? splitPct - 50 : 0;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <div style={primeiro}>{a}</div>
      <div style={segundo}>{b}</div>
      {props.musica_fundo ? (
        <Audio src={`/musica/${props.musica_fundo.path.replace(/^musica\//, "")}`} volume={Math.min(1, (props.musica_fundo.volume ?? 3) / 10)} />
      ) : null}
      {legenda?.ativa && props.legenda_palavras && props.legenda_palavras.length > 0 ? (
        <LegendaOverlay
          palavras={props.legenda_palavras}
          config={legenda}
          corPrimaria={props.cor_primaria}
          corSecundaria={props.cor_secundaria}
          fonteFamilia={props.fonte_familia}
          videoStartSegundos={videoStart}
          janelasSuprimidas={[]}
          posicaoForcada="centro"
          offsetSeamPct={offsetSeam}
        />
      ) : null}
      <CtaFinalSequencePlayer props={props} />
    </AbsoluteFill>
  );
};

// ── CTA final (espelho de apps/remotion/src/scenes/CtaFinal.tsx) ──────────────

function escurecerHexPlayer(hex: string, f: number): string {
  const h = hex.replace("#", "");
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return hex;
  const n = parseInt(h, 16);
  return `rgb(${Math.round(((n >> 16) & 255) * f)}, ${Math.round(((n >> 8) & 255) * f)}, ${Math.round((n & 255) * f)})`;
}

const CtaFinalPlayer: React.FC<{ config: CtaFinalConfig; corPrimaria?: string; corSecundaria?: string; fonteFamilia?: string }> = ({ config, corPrimaria, corSecundaria, fonteFamilia }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const scale = Math.min(width / 1080, height / 1920);
  const fontFamily = resolveFontFamily(fonteFamilia);
  const entrada = spring({ frame, fps, config: { damping: 14, stiffness: 90 } });
  const opacity = interpolate(entrada, [0, 1], [0, 1]);
  const ty = interpolate(entrada, [0, 1], [40, 0]);
  const accent = corSecundaria ?? colors.yellow;
  const setaY = 16 * Math.sin((frame / fps) * 2 * Math.PI * 1.4);
  const gradTopo = corPrimaria ?? colors.navy;
  const gradBase = corPrimaria ? escurecerHexPlayer(corPrimaria, 0.24) : colors.navyDeep;
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ background: `linear-gradient(150deg, ${gradTopo} 0%, ${gradBase} 100%)` }} />
      <AbsoluteFill style={{ background: "radial-gradient(ellipse at center, rgba(0,0,0,0.52) 0%, rgba(0,0,0,0.18) 72%)" }} />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: `0 ${Math.round(64 * scale)}px`, textAlign: "center" }}>
        {config.logo_url ? <Img src={config.logo_url} style={{ maxWidth: "58%", maxHeight: "20%", objectFit: "contain", marginBottom: Math.round(44 * scale), opacity, transform: `translateY(${ty}px)` }} /> : null}
        {config.copy ? <div style={{ opacity, transform: `translateY(${ty}px)`, fontFamily, fontWeight: 800, fontSize: Math.round(84 * scale), lineHeight: 1.06, letterSpacing: `${-0.5 * scale}px`, textTransform: "uppercase", color: colors.white, maxWidth: "92%", textShadow: "0 2px 16px rgba(0,0,0,0.5)" }}>{config.copy}</div> : null}
        {config.copy || config.logo_url ? <div style={{ marginTop: Math.round(40 * scale), fontSize: Math.round(96 * scale), lineHeight: 1, color: accent, opacity, transform: `translateY(${setaY}px)` }}>↓</div> : null}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const CtaFinalSequencePlayer: React.FC<{ props: ReelProps }> = ({ props }) => {
  const cta = props.cta_final;
  if (!cta?.ativo) return null;
  const videoStart = props.video_start_segundos ?? 0;
  const videoEndRaw = (props as Record<string, unknown>).video_end_segundos;
  const videoEndSeg = typeof videoEndRaw === "number" && videoEndRaw > videoStart ? videoEndRaw : null;
  if (videoEndSeg == null) return null;
  const from = Math.round((videoEndSeg - videoStart) * FPS);
  const dur = Math.round(cta.duracao_segundos * FPS);
  return (
    <Sequence from={from} durationInFrames={dur} name="cta-final">
      <CtaFinalPlayer config={cta} corPrimaria={props.cor_primaria} corSecundaria={props.cor_secundaria} fonteFamilia={props.fonte_familia} />
    </Sequence>
  );
};

// ── Narrado (espelho de apps/remotion/src/scenes/NarradoLayout.tsx) ───────────

const InsertFullPlayer: React.FC<{ src: string; durF: number }> = ({ src, durF }) => {
  const frame = useCurrentFrame();
  const k = interpolate(frame, [0, durF], [1.0, 1.08], { extrapolateRight: "clamp" });
  const px = interpolate(frame, [0, durF], [-1.5, 1.5], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${k}) translateX(${px}%)` }} />
    </AbsoluteFill>
  );
};

const NarradoLayoutPlayer: React.FC<{ props: ReelProps }> = ({ props }) => {
  const inserts = props.narrado?.inserts ?? [];
  const videoPath = props.video_original_path ?? undefined;
  const videoStart = props.video_start_segundos ?? 0;
  const videoStartFrom = Math.round(videoStart * FPS);
  const videoEndRaw = (props as Record<string, unknown>).video_end_segundos;
  const videoEndAt = typeof videoEndRaw === "number" && videoEndRaw > videoStart ? Math.round(videoEndRaw * FPS) : undefined;
  const legenda = props.legenda;
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {videoPath ? (
        <>
          <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
            <defs>
              <filter id="esp-sharpen">
                <feConvolveMatrix order="3" preserveAlpha="true" kernelMatrix="0 -0.4 0  -0.4 2.6 -0.4  0 -0.4 0" />
              </filter>
            </defs>
          </svg>
          <Video src={videoPath} startFrom={videoStartFrom} {...(videoEndAt != null ? { endAt: videoEndAt } : {})} style={{ width: "100%", height: "100%", objectFit: "cover", filter: "url(#esp-sharpen)" }} />
        </>
      ) : null}
      {(() => {
        const fr = inserts.map((x) => Math.max(0, Math.round((x.inicio - videoStart) * FPS)));
        const endRel = videoEndAt != null
          ? videoEndAt - videoStartFrom
          : (inserts.length ? fr[fr.length - 1] + Math.max(1, Math.round((inserts[inserts.length - 1].fim - inserts[inserts.length - 1].inicio) * FPS)) : 0);
        const assetsN = resolverAssetsPlayer(inserts);
        return inserts.map((ins, i) => {
          const asset = assetsN[i];
          const from = fr[i];
          const durF = Math.max(1, (i < inserts.length - 1 ? fr[i + 1] : endRel) - from);
          const ehVideo = !!asset && asset.tipo === "video" && !!asset.video_url;
          return (
            <Sequence key={i} from={from} durationInFrames={durF} name={`insert-${i}`}>
              {asset ? (ehVideo ? <InsertVideoPlayer src={asset.video_url as string} /> : <InsertFullPlayer src={asset.image_url as string} durF={durF} />) : null}
              {ins.overlay_texto ? <OverlayTextoInsertPlayer texto={ins.overlay_texto} /> : null}
            </Sequence>
          );
        });
      })()}
      {legenda?.ativa && props.legenda_palavras && props.legenda_palavras.length > 0 ? (
        <LegendaOverlay palavras={props.legenda_palavras} config={legenda} corPrimaria={props.cor_primaria} corSecundaria={props.cor_secundaria} fonteFamilia={props.fonte_familia} videoStartSegundos={videoStart} janelasSuprimidas={[]} />
      ) : null}
      <CtaFinalSequencePlayer props={props} />
    </AbsoluteFill>
  );
};

// ── Aula (espelho de apps/remotion/src/scenes/AulaLayout.tsx) ─────────────────

// ── Caixinha de pergunta (espelho de apps/remotion/src/scenes/CaixinhaPergunta) ──

const CAIXINHA_FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const CaixinhaPerguntaCardPlayer: React.FC<{ config: CaixinhaConfig }> = ({ config }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const scale = Math.min(width / 1080, height / 1920);

  const entrada =
    config.animacao === "nenhuma"
      ? 1
      : config.animacao === "fade"
      ? interpolate(frame, [0, Math.round(fps * 0.35)], [0, 1], { extrapolateRight: "clamp" })
      : spring({ frame, fps, config: { damping: 13, stiffness: 110 } });

  const opacity = interpolate(entrada, [0, 1], [0, 1], { extrapolateRight: "clamp" });
  const pop = config.animacao === "spring" ? interpolate(entrada, [0, 1], [0.82, 1]) : 1;

  const larguraCard = Math.round((width * (config.largura_pct ?? 76)) / 100);
  const radius = Math.round(28 * scale);
  const sombra = `0 ${Math.round(10 * scale)}px ${Math.round(28 * scale)}px rgba(0,0,0,0.28)`;

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: `${config.posicao_y ?? 62}%`,
          transform: `translate(-50%, -50%) scale(${pop})`,
          opacity,
          width: larguraCard,
          // Header e pergunta são UM bloco só (como no sticker do Instagram):
          // sem gap, cantos arredondados só no perímetro externo. O overflow
          // hidden é o que recorta os cantos internos das duas faixas.
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
          borderRadius: radius,
          overflow: "hidden",
          boxShadow: sombra,
          fontFamily: CAIXINHA_FONT,
        }}
      >
        {config.header ? (
          <div
            style={{
              background: "#1E1E1E",
              color: "#FFFFFF",
              padding: `${Math.round(18 * scale)}px ${Math.round(34 * scale)}px`,
              fontSize: Math.round(40 * scale),
              fontWeight: 700,
              letterSpacing: -0.2,
              width: "100%",
              textAlign: "center",
              boxSizing: "border-box",
              wordBreak: "break-word",
            }}
          >
            {config.header}
          </div>
        ) : null}

        <div
          style={{
            background: "#F2F2F2",
            color: "#1E1E1E",
            padding: `${Math.round(30 * scale)}px ${Math.round(34 * scale)}px`,
            fontSize: Math.round(46 * scale),
            fontWeight: 600,
            lineHeight: 1.28,
            textAlign: "center",
            width: "100%",
            boxSizing: "border-box",
            wordBreak: "break-word",
          }}
        >
          {config.pergunta || "Escreva a pergunta no editor"}
        </div>
      </div>
    </AbsoluteFill>
  );
};

const CaixinhaPerguntaSequencePlayer: React.FC<{ props: ReelProps }> = ({ props }) => {
  const cfg = props.caixinha;
  if (!cfg?.ativo) return null;
  if (!cfg.pergunta && !cfg.header) return null;
  const videoStart = props.video_start_segundos ?? 0;
  const from = Math.max(0, Math.round((cfg.inicio_segundos - videoStart) * FPS));
  const dur = Math.max(1, Math.round((cfg.fim_segundos - cfg.inicio_segundos) * FPS));
  return (
    <Sequence from={from} durationInFrames={dur} name="caixinha-pergunta">
      <CaixinhaPerguntaCardPlayer config={cfg} />
    </Sequence>
  );
};

/** Formato "caixinha_pergunta": especialista em tela cheia + legenda. */
const CaixinhaLayoutPlayer: React.FC<{ props: ReelProps }> = ({ props }) => {
  const videoPath = props.video_original_path ?? "";
  const videoStart = props.video_start_segundos ?? 0;
  const videoStartFrom = Math.round(videoStart * FPS);
  const videoEndRaw = (props as Record<string, unknown>).video_end_segundos;
  const videoEndAt =
    typeof videoEndRaw === "number" && videoEndRaw > videoStart ? Math.round(videoEndRaw * FPS) : undefined;
  const legenda = props.legenda;

  return (
    <AbsoluteFill style={{ backgroundColor: colors.navy }}>
      {videoPath ? (
        <Video
          src={videoPath}
          startFrom={videoStartFrom}
          {...(videoEndAt != null ? { endAt: videoEndAt } : {})}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : null}

      {props.musica_fundo ? (
        <Audio
          src={`/musica/${props.musica_fundo.path.replace(/^musica\//, "")}`}
          volume={Math.min(1, (props.musica_fundo.volume ?? 3) / 10)}
        />
      ) : null}

      {legenda?.ativa && props.legenda_palavras && props.legenda_palavras.length > 0 ? (
        <LegendaOverlay
          palavras={props.legenda_palavras}
          config={legenda}
          corPrimaria={props.cor_primaria}
          corSecundaria={props.cor_secundaria}
          fonteFamilia={props.fonte_familia}
          videoStartSegundos={videoStart}
          janelasSuprimidas={[]}
        />
      ) : null}

      <CtaFinalSequencePlayer props={props} />
    </AbsoluteFill>
  );
};

const CropViewPlayer: React.FC<{
  src: string; regiao: Regiao; fit: "cover" | "contain";
  containerW: number; containerH: number; sourceAspect: number;
  startFrom: number; endAt?: number; bg?: string; sharpen?: boolean;
}> = ({ src, regiao, fit, containerW, containerH, sourceAspect, startFrom, endAt, bg = "#0a1420", sharpen = false }) => {
  const { x, y, w, h } = regiao;
  const D = fit === "cover"
    ? Math.max(containerW / w, (containerH * sourceAspect) / h)
    : Math.min(containerW / w, (containerH * sourceAspect) / h);
  const videoW = D;
  const videoH = D / sourceAspect;
  const left = (containerW - w * videoW) / 2 - x * videoW;
  const top = (containerH - h * videoH) / 2 - y * videoH;
  return (
    <AbsoluteFill style={{ overflow: "hidden", background: bg }}>
      {sharpen ? (
        <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
          <defs>
            <filter id="aula-sharpen">
              <feConvolveMatrix order="3" preserveAlpha="true" kernelMatrix="0 -0.4 0  -0.4 2.6 -0.4  0 -0.4 0" />
            </filter>
          </defs>
        </svg>
      ) : null}
      <Video src={src} muted startFrom={startFrom} {...(endAt != null ? { endAt } : {})} style={{ position: "absolute", width: videoW, height: videoH, left, top, objectFit: "fill", filter: sharpen ? "url(#aula-sharpen)" : undefined }} />
    </AbsoluteFill>
  );
};

const AulaLayoutPlayer: React.FC<{ props: ReelProps }> = ({ props }) => {
  const { width, height } = useVideoConfig();
  const vertical = height >= width;
  const cfg = props.aula;
  const splitPct = cfg?.split_pct ?? 60;
  const cameraRegiao: Regiao = cfg?.camera_regiao ?? { x: 0.008, y: 0.319, w: 0.175, h: 0.333 };
  const slideRegiao: Regiao = cfg?.slide_regiao ?? { x: 0.1875, y: 0, w: 0.8125, h: 1 };
  const sourceAspect = cfg?.source_aspect ?? 16 / 9;
  const slideInicio = cfg?.slide_inicio_segundos ?? 0;

  const videoPath = props.video_original_path ?? "";
  const videoStart = props.video_start_segundos ?? 0;
  const videoStartFrom = Math.round(videoStart * FPS);
  const videoEndRaw = (props as Record<string, unknown>).video_end_segundos;
  const videoEndAt = typeof videoEndRaw === "number" && videoEndRaw > videoStart ? Math.round(videoEndRaw * FPS) : undefined;

  const slideW = vertical ? width : Math.round(width * (splitPct / 100));
  const slideH = vertical ? Math.round(height * (splitPct / 100)) : height;
  const specW = vertical ? width : width - slideW;
  const specH = vertical ? height - slideH : height;

  const slidePane: React.CSSProperties = vertical
    ? { position: "absolute", top: 0, left: 0, right: 0, height: `${splitPct}%`, overflow: "hidden" }
    : { position: "absolute", top: 0, bottom: 0, left: 0, width: `${splitPct}%`, overflow: "hidden" };
  const specPane: React.CSSProperties = vertical
    ? { position: "absolute", bottom: 0, left: 0, right: 0, height: `${100 - splitPct}%`, overflow: "hidden" }
    : { position: "absolute", top: 0, bottom: 0, right: 0, width: `${100 - splitPct}%`, overflow: "hidden" };

  const slideInicioFrame = Math.round((slideInicio - videoStart) * FPS);
  const legenda = props.legenda;
  const offsetSeam = vertical ? splitPct - 50 : 0;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {videoPath ? (
        <Audio src={videoPath} startFrom={videoStartFrom} {...(videoEndAt != null ? { endAt: videoEndAt } : {})} />
      ) : null}
      <AbsoluteFill>
        <div style={slidePane}>
          {videoPath ? <CropViewPlayer src={videoPath} regiao={slideRegiao} fit="contain" containerW={slideW} containerH={slideH} sourceAspect={sourceAspect} startFrom={videoStartFrom} endAt={videoEndAt} /> : null}
        </div>
        <div style={specPane}>
          {videoPath ? <CropViewPlayer src={videoPath} regiao={cameraRegiao} fit="cover" containerW={specW} containerH={specH} sourceAspect={sourceAspect} startFrom={videoStartFrom} endAt={videoEndAt} bg="#000" sharpen /> : null}
        </div>
      </AbsoluteFill>
      {slideInicioFrame > 0 && videoPath ? (
        <Sequence from={0} durationInFrames={slideInicioFrame} name="intro">
          <AbsoluteFill style={{ overflow: "hidden", background: "#000" }}>
            <Video src={videoPath} muted startFrom={videoStartFrom} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          </AbsoluteFill>
        </Sequence>
      ) : null}
      {legenda?.ativa && props.legenda_palavras && props.legenda_palavras.length > 0 ? (
        <LegendaOverlay palavras={props.legenda_palavras} config={legenda} corPrimaria={props.cor_primaria} corSecundaria={props.cor_secundaria} fonteFamilia={props.fonte_familia} videoStartSegundos={videoStart} janelasSuprimidas={[]} posicaoForcada="centro" offsetSeamPct={offsetSeam} />
      ) : null}
      <CtaFinalSequencePlayer props={props} />
    </AbsoluteFill>
  );
};

// ── SceneRouter ───────────────────────────────────────────────────────────────

const SceneRouter: React.FC<{ cena: Cena; corPrimaria?: string; corSecundaria?: string; fonteFamilia?: string }> = ({
  cena,
  corPrimaria,
  corSecundaria,
  fonteFamilia,
}) => {
  const p = { corPrimaria, corSecundaria, fonteFamilia };
  switch (cena.tipo) {
    case "Hook": return <HookOverlay cena={cena} {...p} />;
    case "CTA": return <CtaOverlay cena={cena} {...p} />;
    case "FraseImpacto": return <FraseImpactoOverlay cena={cena} {...p} />;
    case "ComparativoNumerico": return <ComparativoOverlay cena={cena} corPrimaria={corPrimaria} corSecundaria={corSecundaria} fonteFamilia={fonteFamilia} />;
    case "VideoCitacao": return <VideoCitacaoOverlay cena={cena} corPrimaria={corPrimaria} fonteFamilia={fonteFamilia} />;
    case "ListaPontos": return <ListaPontosOverlay cena={cena} corPrimaria={corPrimaria} fonteFamilia={fonteFamilia} />;
    case "MiniCaso": return <MiniCasoOverlay cena={cena} {...p} />;
    case "TransicaoTexto": return <TransicaoOverlay cena={cena} fonteFamilia={fonteFamilia} />;
    case "ConviteEvento": return <ConviteEventoOverlay cena={cena} corPrimaria={corPrimaria} fonteFamilia={fonteFamilia} />;
    case "GraficoBarra": return <GraficoBarraOverlay cena={cena} corPrimaria={corPrimaria} corSecundaria={corSecundaria} fonteFamilia={fonteFamilia} />;
    case "GraficoLinha": return <GraficoLinhaOverlay cena={cena} corPrimaria={corPrimaria} corSecundaria={corSecundaria} fonteFamilia={fonteFamilia} />;
    case "VideoSimples": return null; // Só o vídeo de fundo, sem overlay
    default: return null;
  }
};

// ── Gradiente de legibilidade reutilizável ────────────────────────────────────

const GradienteInferior: React.FC<{ opacity?: number }> = ({ opacity = 0.80 }) => (
  <AbsoluteFill style={{
    background: `linear-gradient(180deg, transparent 30%, rgba(0,0,0,${opacity}) 100%)`,
    pointerEvents: "none",
  }} />
);

// ── Hook ──────────────────────────────────────────────────────────────────────

const HookOverlay: React.FC<{ cena: Extract<Cena, { tipo: "Hook" }>; corPrimaria?: string; corSecundaria?: string; fonteFamilia?: string }> = ({ cena, corPrimaria, corSecundaria, fonteFamilia }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 12, stiffness: 100, mass: 0.5 } });
  const opacity = interpolate(s, [0, 1], [0, 1]);
  const y = interpolate(s, [0, 1], [40, 0]);
  const scale = interpolate(s, [0, 1], [0.92, 1]);
  const tokens = cena.titulo.split(/(\s+)/);
  const fontFamily = resolveFontFamily(fonteFamilia);

  const hookCorMap = buildTokenCorMap(tokens, cena.palavras_destacadas, corPrimaria, corSecundaria);

  return (
    <AbsoluteFill>
      {cena.sfx ? (
        <Sequence from={Math.round((cena.sfx.inicio_segundos ?? 0) * fps)}>
          <Audio
            src={staticFile(cena.sfx.path)}
            volume={Math.min(1, (cena.sfx.volume ?? 5) / 10)}
            endAt={cena.sfx.fim_segundos != null ? Math.round(cena.sfx.fim_segundos * fps) : undefined}
          />
        </Sequence>
      ) : null}

      <GradienteInferior />
      <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", padding: "0 64px 420px", textAlign: "center" }}>
        <div style={{ opacity, transform: `translateY(${y}px) scale(${scale})`, fontFamily, fontWeight: typography.weightHero, fontSize: typography.sizeHero, lineHeight: typography.lineHeightTight, letterSpacing: typography.trackingTight, textTransform: "uppercase", color: colors.white, textShadow: "0 4px 24px rgba(0,0,0,0.8)" }}>
          {tokens.map((token, i) => (
            <span key={i} style={{ color: hookCorMap[i] ?? colors.white }}>{token}</span>
          ))}
        </div>
        {cena.subtitulo && (
          <div style={{ marginTop: spacing.md, opacity: opacity * 0.9, transform: `translateY(${y * 0.8}px)`, fontFamily, fontWeight: typography.weightBody, fontSize: typography.sizeSubtitle, color: colors.whiteSoft, textShadow: "0 2px 12px rgba(0,0,0,0.8)" }}>
            {cena.subtitulo}
          </div>
        )}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ── VideoCitacao ──────────────────────────────────────────────────────────────

const VideoCitacaoOverlay: React.FC<{ cena: Extract<Cena, { tipo: "VideoCitacao" }>; corPrimaria?: string; fonteFamilia?: string }> = ({ cena, corPrimaria, fonteFamilia }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 14, stiffness: 80 } });
  const opacity = interpolate(s, [0, 1], [0, 1]);
  const y = interpolate(s, [0, 1], [20, 0]);
  const accentColor = corPrimaria ?? colors.red;
  const fontFamily = resolveFontFamily(fonteFamilia);

  return (
    <AbsoluteFill>
      {cena.sfx ? (
        <Sequence from={Math.round((cena.sfx.inicio_segundos ?? 0) * fps)}>
          <Audio
            src={staticFile(cena.sfx.path)}
            volume={Math.min(1, (cena.sfx.volume ?? 5) / 10)}
            endAt={cena.sfx.fim_segundos != null ? Math.round(cena.sfx.fim_segundos * fps) : undefined}
          />
        </Sequence>
      ) : null}

      <AbsoluteFill style={{ background: "linear-gradient(180deg, transparent 45%, rgba(0,0,0,0.88) 100%)" }} />
      <AbsoluteFill style={{ justifyContent: "flex-end", padding: "0 64px 420px" }}>
        <div style={{ opacity, transform: `translateY(${y}px)`, borderLeft: `6px solid ${accentColor}`, paddingLeft: spacing.md }}>
          <div style={{ fontFamily, fontWeight: typography.weightTitle, fontSize: typography.sizeBody, color: colors.white, letterSpacing: typography.trackingNormal }}>{cena.nome_mentor}</div>
          <div style={{ fontFamily, fontWeight: typography.weightCaption, fontSize: typography.sizeCaption, color: accentColor, marginBottom: spacing.md, opacity: 0.9 }}>{cena.cargo_mentor}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: spacing.xs }}>
            {cena.frases.map((frase, i) => {
              const fraseDelay = i * 8;
              const fe = spring({ frame: Math.max(0, frame - fraseDelay), fps, config: { damping: 14, stiffness: 80 } });
              return (
                <div key={i} style={{ opacity: interpolate(fe, [0, 1], [0, 1]), transform: `translateX(${interpolate(fe, [0, 1], [20, 0])}px)`, fontFamily, fontWeight: typography.weightBody, fontSize: typography.sizeSubtitle, color: colors.white, lineHeight: typography.lineHeightBody }}>{frase}</div>
              );
            })}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ── FraseImpacto ──────────────────────────────────────────────────────────────

const FraseImpactoOverlay: React.FC<{ cena: Extract<Cena, { tipo: "FraseImpacto" }>; corPrimaria?: string; corSecundaria?: string; fonteFamilia?: string }> = ({ cena, corPrimaria, corSecundaria, fonteFamilia }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 14, stiffness: 80 } });
  const opacity = interpolate(s, [0, 1], [0, 1]);
  const y = interpolate(s, [0, 1], [30, 0]);
  const tokens = cena.texto.split(/(\s+)/);
  const fontFamily = resolveFontFamily(fonteFamilia);
  const fraseCorMap = buildTokenCorMap(tokens, cena.palavras_destacadas ?? [], corPrimaria, corSecundaria);

  return (
    <AbsoluteFill>
      {cena.sfx ? (
        <Sequence from={Math.round((cena.sfx.inicio_segundos ?? 0) * fps)}>
          <Audio
            src={staticFile(cena.sfx.path)}
            volume={Math.min(1, (cena.sfx.volume ?? 5) / 10)}
            endAt={cena.sfx.fim_segundos != null ? Math.round(cena.sfx.fim_segundos * fps) : undefined}
          />
        </Sequence>
      ) : null}

      <AbsoluteFill style={{ background: "linear-gradient(180deg, transparent 35%, rgba(0,0,0,0.80) 100%)", pointerEvents: "none" }} />
      <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: cena.alinhamento === "esquerda" ? "flex-start" : "center", padding: "0 64px 420px" }}>
        <div style={{ opacity, transform: `translateY(${y}px)`, fontFamily, fontWeight: typography.weightTitle, fontSize: typography.sizeTitle, lineHeight: typography.lineHeightBody, letterSpacing: typography.trackingTight, color: colors.white, textAlign: cena.alinhamento === "esquerda" ? "left" : "center", maxWidth: 900, textShadow: "0 3px 20px rgba(0,0,0,0.85)" }}>
          {tokens.map((token, i) => (
            <span key={i} style={{ color: fraseCorMap[i] ?? colors.white }}>{token}</span>
          ))}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ── ListaPontos ───────────────────────────────────────────────────────────────

const ListaPontosOverlay: React.FC<{ cena: Extract<Cena, { tipo: "ListaPontos" }>; corPrimaria?: string; fonteFamilia?: string }> = ({ cena, corPrimaria, fonteFamilia }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const accentColor = corPrimaria ?? colors.red;
  const fontFamily = resolveFontFamily(fonteFamilia);

  const tituloEntrada = spring({ frame, fps, config: { damping: 14, stiffness: 90 } });
  const tituloOpacity = interpolate(tituloEntrada, [0, 1], [0, 1]);
  const tituloY = interpolate(tituloEntrada, [0, 1], [20, 0]);

  const ITEM_DELAY = 12;

  return (
    <AbsoluteFill>
      {cena.sfx ? cena.pontos.map((_, i) => (
        <Sequence key={i} from={Math.round(((cena.sfx!.inicio_segundos ?? 0) * fps) + i * ITEM_DELAY)}>
          <Audio
            src={staticFile(cena.sfx!.path)}
            volume={Math.min(1, (cena.sfx!.volume ?? 5) / 10)}
          />
        </Sequence>
      )) : null}

      <AbsoluteFill style={{ background: "linear-gradient(180deg, transparent 15%, rgba(0,0,0,0.88) 100%)", pointerEvents: "none" }} />
      <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "flex-start", padding: "0 64px 420px", flexDirection: "column" }}>
        {cena.titulo && (
          <>
            <div style={{ opacity: tituloOpacity, width: 48, height: 4, backgroundColor: accentColor, borderRadius: 2, marginBottom: spacing.sm }} />
            <div style={{ opacity: tituloOpacity, transform: `translateY(${tituloY}px)`, fontFamily, fontWeight: typography.weightHero, fontSize: typography.sizeTitle, color: colors.white, letterSpacing: typography.trackingTight, textTransform: "uppercase", marginBottom: spacing.lg, textShadow: "0 3px 20px rgba(0,0,0,0.85)", lineHeight: typography.lineHeightTight }}>{cena.titulo}</div>
          </>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: spacing.md, width: "100%" }}>
          {cena.pontos.map((ponto, i) => {
            const delay = i * ITEM_DELAY;
            const pe = spring({ frame: Math.max(0, frame - delay), fps, config: { damping: 16, stiffness: 100 } });
            const pontoOpacity = interpolate(pe, [0, 1], [0, 1]);
            const pontoX = interpolate(pe, [0, 1], [-60, 0]);
            const pontoScale = interpolate(pe, [0, 1], [0.95, 1]);
            return (
              <div key={i} style={{ opacity: pontoOpacity, transform: `translateX(${pontoX}px) scale(${pontoScale})`, display: "flex", flexDirection: "row", alignItems: "center", gap: spacing.md, background: "rgba(255,255,255,0.06)", borderRadius: 16, padding: `${spacing.sm}px ${spacing.md}px`, borderLeft: `4px solid ${accentColor}` }}>
                {cena.numerado
                  ? <div style={{ fontFamily, fontWeight: typography.weightHero, fontSize: 80, color: accentColor, minWidth: 68, lineHeight: 1, textAlign: "center", flexShrink: 0 }}>{i + 1}</div>
                  : <div style={{ width: 14, height: 14, borderRadius: "50%", backgroundColor: accentColor, flexShrink: 0 }} />}
                <div style={{ fontFamily, fontWeight: typography.weightBody, fontSize: typography.sizeBody, color: colors.white, lineHeight: typography.lineHeightBody }}>{ponto}</div>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ── ComparativoNumerico ───────────────────────────────────────────────────────

const ComparativoOverlay: React.FC<{ cena: Extract<Cena, { tipo: "ComparativoNumerico" }>; corPrimaria?: string; corSecundaria?: string; fonteFamilia?: string }> = ({ cena, corPrimaria, corSecundaria, fonteFamilia }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 12, stiffness: 80 } });
  const opacity = interpolate(s, [0, 1], [0, 1]);
  const y = interpolate(s, [0, 1], [40, 0]);
  const accentColor = cena.cor_destaque ?? corPrimaria ?? colors.red;
  const fontFamily = resolveFontFamily(fonteFamilia);

  return (
    <AbsoluteFill>
      {cena.sfx ? (
        <Sequence from={Math.round((cena.sfx.inicio_segundos ?? 0) * fps)}>
          <Audio
            src={staticFile(cena.sfx.path)}
            volume={Math.min(1, (cena.sfx.volume ?? 5) / 10)}
            endAt={cena.sfx.fim_segundos != null ? Math.round(cena.sfx.fim_segundos * fps) : undefined}
          />
        </Sequence>
      ) : null}

      <GradienteInferior opacity={0.78} />
      <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", padding: "0 64px 420px", flexDirection: "column", gap: spacing.lg }}>
        <div style={{ opacity, transform: `translateY(${y}px)`, fontFamily, fontWeight: typography.weightBody, fontSize: typography.sizeCaption, color: colors.textMuted, textAlign: "center", textTransform: "uppercase", letterSpacing: typography.trackingWide }}>{cena.metrica_nome}</div>
        <div style={{ display: "flex", flexDirection: "row", justifyContent: "center", alignItems: "stretch", gap: spacing.md, width: "100%" }}>
          {cena.lados.map((lado, i) => {
            const delay = i * 4;
            const le = spring({ frame: Math.max(0, frame - delay), fps, config: { damping: 12, stiffness: 80 } });
            return (
              <div key={i} style={{ opacity: interpolate(le, [0, 1], [0, 1]), transform: `translateY(${interpolate(le, [0, 1], [30, 0])}px)`, flex: 1, minWidth: 0, maxWidth: 420, backgroundColor: lado.eh_destaque ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.04)", border: lado.eh_destaque ? `3px solid ${accentColor}` : "2px solid rgba(255,255,255,0.1)", borderRadius: 24, padding: `${spacing.lg}px ${spacing.md}px`, display: "flex", flexDirection: "column", alignItems: "center", gap: spacing.sm, overflow: "hidden" }}>
                <div style={{ fontFamily, fontWeight: typography.weightHero, fontSize: (() => { const l = String(lado.valor).length; if (l <= 4) return 120; if (l <= 7) return 96; if (l <= 10) return 72; if (l <= 14) return 56; return 44; })(), lineHeight: 1.05, color: lado.eh_destaque ? accentColor : colors.whiteSoft, letterSpacing: typography.trackingTight, textAlign: "center", wordBreak: "break-word", overflowWrap: "break-word", width: "100%" }}>{lado.valor}</div>
                <div style={{ fontFamily, fontWeight: typography.weightBody, fontSize: typography.sizeCaption, color: colors.textMuted, textTransform: "uppercase", letterSpacing: typography.trackingWide, textAlign: "center", wordBreak: "break-word", width: "100%" }}>{lado.rotulo}</div>
              </div>
            );
          })}
        </div>
        <div style={{ opacity: opacity * 0.6, fontFamily, fontWeight: typography.weightCaption, fontSize: typography.sizeCaption, color: colors.textMuted, textAlign: "center" }}>
          em {cena.metrica_unidade}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ── MiniCaso ──────────────────────────────────────────────────────────────────

const MiniCasoOverlay: React.FC<{ cena: Extract<Cena, { tipo: "MiniCaso" }>; corPrimaria?: string; corSecundaria?: string; fonteFamilia?: string }> = ({ cena, corPrimaria, corSecundaria, fonteFamilia }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 14, stiffness: 80 } });
  const opacity = interpolate(s, [0, 1], [0, 1]);
  const y = interpolate(s, [0, 1], [30, 0]);
  const tokens = cena.resultado_texto.split(/(\s+)/);
  const accentColor = corPrimaria ?? colors.red;
  const fontFamily = resolveFontFamily(fonteFamilia);
  const casoCorMap = buildTokenCorMap(tokens, cena.palavras_destacadas ?? [], corPrimaria, corSecundaria);

  return (
    <AbsoluteFill>
      {cena.sfx ? (
        <Sequence from={Math.round((cena.sfx.inicio_segundos ?? 0) * fps)}>
          <Audio
            src={staticFile(cena.sfx.path)}
            volume={Math.min(1, (cena.sfx.volume ?? 5) / 10)}
            endAt={cena.sfx.fim_segundos != null ? Math.round(cena.sfx.fim_segundos * fps) : undefined}
          />
        </Sequence>
      ) : null}

      <AbsoluteFill style={{ background: "linear-gradient(180deg, rgba(0,0,0,0.75) 0%, transparent 40%)" }} />
      <AbsoluteFill style={{ backgroundColor: "rgba(0,0,0,0.35)" }} />
      <AbsoluteFill style={{ justifyContent: "flex-start", alignItems: "flex-start", padding: `${spacing.xl}px ${spacing.lg}px 0` }}>
        <div style={{ opacity, transform: `translateY(${y}px)`, backgroundColor: "rgba(0,0,0,0.70)", border: `3px solid ${accentColor}`, borderRadius: 20, padding: `${spacing.md}px ${spacing.lg}px`, maxWidth: 900 }}>
          {cena.contexto_texto && (
            <div style={{ fontFamily, fontWeight: typography.weightCaption, fontSize: typography.sizeCaption, color: colors.textMuted, textTransform: "uppercase", letterSpacing: typography.trackingWide, marginBottom: spacing.xs }}>{cena.contexto_texto}</div>
          )}
          <div style={{ fontFamily, fontWeight: typography.weightTitle, fontSize: typography.sizeSubtitle, lineHeight: typography.lineHeightBody, color: colors.white }}>
            {tokens.map((token, i) => (
              <span key={i} style={{ color: casoCorMap[i] ?? colors.white }}>{token}</span>
            ))}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ── TransicaoTexto ────────────────────────────────────────────────────────────

const TransicaoOverlay: React.FC<{ cena: Extract<Cena, { tipo: "TransicaoTexto" }>; fonteFamilia?: string }> = ({ cena, fonteFamilia }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const fontFamily = resolveFontFamily(fonteFamilia);
  const s = spring({ frame, fps, config: { damping: 18, stiffness: 120 } });
  const opacity = interpolate(s, [0, 1], [0, 1]);
  const scale = interpolate(s, [0, 1], [0.96, 1]);

  return (
    <AbsoluteFill>
      {cena.sfx ? (
        <Sequence from={Math.round((cena.sfx.inicio_segundos ?? 0) * fps)}>
          <Audio
            src={staticFile(cena.sfx.path)}
            volume={Math.min(1, (cena.sfx.volume ?? 5) / 10)}
            endAt={cena.sfx.fim_segundos != null ? Math.round(cena.sfx.fim_segundos * fps) : undefined}
          />
        </Sequence>
      ) : null}

      <AbsoluteFill style={{ background: "linear-gradient(180deg, transparent 40%, rgba(0,0,0,0.72) 100%)", pointerEvents: "none" }} />
      <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", padding: `0 ${spacing.lg}px ${spacing.xxl}px` }}>
        <div style={{ opacity, transform: `scale(${scale})`, fontFamily, fontWeight: typography.weightTitle, fontSize: typography.sizeSubtitle, color: colors.whiteSoft, textAlign: "center", letterSpacing: typography.trackingNormal, lineHeight: typography.lineHeightBody, textShadow: "0 2px 16px rgba(0,0,0,0.9)" }}>{cena.texto}</div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ── ConviteEvento ─────────────────────────────────────────────────────────────

const ConviteEventoOverlay: React.FC<{ cena: Extract<Cena, { tipo: "ConviteEvento" }>; corPrimaria?: string; fonteFamilia?: string }> = ({ cena, corPrimaria, fonteFamilia }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 14, stiffness: 90 } });
  const opacity = interpolate(s, [0, 1], [0, 1]);
  const y = interpolate(s, [0, 1], [30, 0]);
  const accentColor = corPrimaria ?? colors.red;
  const fontFamily = resolveFontFamily(fonteFamilia);

  return (
    <AbsoluteFill>
      {cena.sfx ? (
        <Sequence from={Math.round((cena.sfx.inicio_segundos ?? 0) * fps)}>
          <Audio
            src={staticFile(cena.sfx.path)}
            volume={Math.min(1, (cena.sfx.volume ?? 5) / 10)}
            endAt={cena.sfx.fim_segundos != null ? Math.round(cena.sfx.fim_segundos * fps) : undefined}
          />
        </Sequence>
      ) : null}

      <AbsoluteFill style={{ backgroundColor: "rgba(8, 10, 18, 0.82)" }} />
      <AbsoluteFill style={{ justifyContent: "flex-start", alignItems: "flex-start", padding: "200px 64px 420px", flexDirection: "column" }}>
        {cena.logo_url ? (
          <div style={{ opacity, transform: `translateY(${y}px)`, marginBottom: spacing.lg, alignSelf: cena.logo_posicao === "centro" ? "center" : cena.logo_posicao === "rodape" ? "flex-end" : "flex-start" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={cena.logo_url} alt={cena.nome_evento} style={{ height: cena.logo_altura ?? 72, width: "auto" }} />
          </div>
        ) : (
          <div style={{ opacity, transform: `translateY(${y}px)`, width: 64, height: 4, backgroundColor: accentColor, borderRadius: 2, marginBottom: spacing.md }} />
        )}
        <div style={{ opacity, transform: `translateY(${y}px)`, fontFamily, fontWeight: typography.weightHero, fontSize: typography.sizeTitle, lineHeight: typography.lineHeightTight, letterSpacing: typography.trackingTight, textTransform: "uppercase", color: colors.white, marginBottom: cena.descricao ? spacing.sm : spacing.lg }}>{cena.nome_evento}
        </div>
        {cena.descricao ? (
          <div style={{ opacity: opacity * 0.85, transform: `translateY(${y}px)`, fontFamily, fontWeight: typography.weightBody, fontSize: typography.sizeBody, color: colors.textMuted, marginBottom: spacing.lg, lineHeight: typography.lineHeightBody }}>{cena.descricao}</div>
        ) : null}
        <div style={{ display: "flex", flexDirection: "column", gap: spacing.sm }}>
          {cena.bullets.map((bullet, i) => {
            const delay = i * 6;
            const be = spring({ frame: Math.max(0, frame - delay), fps, config: { damping: 14, stiffness: 90 } });
            const bulletOpacity = interpolate(be, [0, 1], [0, 1]);
            const bulletX = interpolate(be, [0, 1], [-30, 0]);
            return (
              <div key={i} style={{ opacity: bulletOpacity, transform: `translateX(${bulletX}px)`, display: "flex", alignItems: "center", gap: spacing.sm }}>
                <div style={{ width: 22, height: 22, borderRadius: "50%", backgroundColor: accentColor, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 12, color: colors.white, fontWeight: 900 }}>✓</div>
                <div style={{ fontFamily, fontWeight: typography.weightBody, fontSize: typography.sizeBody, color: colors.whiteSoft, lineHeight: typography.lineHeightBody }}>{bullet}</div>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ── GraficoLinha ──────────────────────────────────────────────────────────────

const GraficoLinhaOverlay: React.FC<{ cena: Extract<Cena, { tipo: "GraficoLinha" }>; corPrimaria?: string; corSecundaria?: string; fonteFamilia?: string }> = ({ cena, corPrimaria, corSecundaria, fonteFamilia }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const fontFamily = resolveFontFamily(fonteFamilia);
  const accentColor = cena.cor_primaria ?? corPrimaria ?? colors.red;
  const accentSecundaria = cena.cor_secundaria ?? corSecundaria ?? colors.yellow;

  const entrada = spring({ frame, fps, config: { damping: 14, stiffness: 80 } });
  const opacity = interpolate(entrada, [0, 1], [0, 1]);
  const translateY = interpolate(entrada, [0, 1], [30, 0]);

  const totalFrames = Math.round(cena.duracao_segundos * fps);
  const drawDelay = fps * 0.5;
  const drawProgress = Math.min(1, Math.max(0, (frame - drawDelay) / (totalFrames - drawDelay)));

  const pontos = cena.pontos;
  const valores = pontos.map((p) => p.valor);
  const minVal = Math.min(...valores);
  const maxVal = Math.max(...valores);
  const range = maxVal - minVal || 1;

  const W = 960;
  const H = 480;
  const PAD_LEFT = 80;
  const PAD_RIGHT = 40;
  const PAD_TOP = 40;
  const PAD_BOTTOM = 60;
  const innerW = W - PAD_LEFT - PAD_RIGHT;
  const innerH = H - PAD_TOP - PAD_BOTTOM;

  const coords = pontos.map((p, i) => ({
    x: PAD_LEFT + (i / (pontos.length - 1)) * innerW,
    y: PAD_TOP + innerH - ((p.valor - minVal) / range) * innerH,
    ...p,
  }));

  const visibleCount = Math.max(2, Math.round(drawProgress * (pontos.length - 1)) + 1);
  const visibleCoords = coords.slice(0, visibleCount);
  const lastFull = visibleCoords[visibleCoords.length - 1];
  const nextFull = coords[visibleCount] ?? null;
  let pathCoords = visibleCoords;
  if (nextFull && visibleCount < pontos.length) {
    const segmentProgress = (drawProgress * (pontos.length - 1)) % 1;
    const interpX = lastFull.x + (nextFull.x - lastFull.x) * segmentProgress;
    const interpY = lastFull.y + (nextFull.y - lastFull.y) * segmentProgress;
    pathCoords = [...visibleCoords, { ...nextFull, x: interpX, y: interpY }];
  }

  const linePath = pathCoords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x} ${c.y}`).join(" ");
  const areaPath = `M ${pathCoords[0].x} ${PAD_TOP + innerH} ` + pathCoords.map((c) => `L ${c.x} ${c.y}`).join(" ") + ` L ${pathCoords[pathCoords.length - 1].x} ${PAD_TOP + innerH} Z`;

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
    y: PAD_TOP + innerH * (1 - t),
    valor: minVal + range * t,
  }));

  const formatVal = (v: number) => {
    const u = cena.unidade ?? "";
    if (Math.abs(v) >= 1_000_000) return `${u}${(v / 1_000_000).toFixed(1)}M`;
    if (Math.abs(v) >= 1_000) return `${u}${(v / 1_000).toFixed(0)}k`;
    return `${u}${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}`;
  };

  return (
    <AbsoluteFill>
      {cena.sfx ? (
        <Sequence from={Math.round((cena.sfx.inicio_segundos ?? 0) * fps)}>
          <Audio
            src={staticFile(cena.sfx.path)}
            volume={Math.min(1, (cena.sfx.volume ?? 5) / 10)}
            endAt={cena.sfx.fim_segundos != null ? Math.round(cena.sfx.fim_segundos * fps) : undefined}
          />
        </Sequence>
      ) : null}

      <AbsoluteFill style={{ backgroundColor: "rgba(5, 8, 20, 0.90)" }} />
      <AbsoluteFill style={{ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", padding: `${spacing.xl}px ${spacing.lg}px`, gap: spacing.md }}>
        <div style={{ opacity, transform: `translateY(${translateY}px)`, fontFamily, fontWeight: typography.weightTitle, fontSize: typography.sizeSubtitle, color: colors.white, letterSpacing: typography.trackingTight, textAlign: "center", lineHeight: typography.lineHeightTight }}>{cena.titulo}</div>
        {cena.subtitulo ? <div style={{ opacity: opacity * 0.7, fontFamily, fontWeight: typography.weightCaption, fontSize: typography.sizeCaption, color: colors.textMuted, textAlign: "center" }}>{cena.subtitulo}</div> : null}
        <div style={{ opacity, width: W, flexShrink: 0 }}>
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ overflow: "visible" }}>
            <defs>
              <linearGradient id="lgAreaGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={accentColor} stopOpacity="0.22" />
                <stop offset="100%" stopColor={accentColor} stopOpacity="0.02" />
              </linearGradient>
            </defs>
            {gridLines.map((g, i) => (
              <g key={i}>
                <line x1={PAD_LEFT} y1={g.y} x2={PAD_LEFT + innerW} y2={g.y} stroke="rgba(255,255,255,0.08)" strokeWidth={1} />
                <text x={PAD_LEFT - 10} y={g.y + 6} textAnchor="end" fill="rgba(255,255,255,0.35)" fontSize={24} fontFamily={fontFamily}>{formatVal(g.valor)}</text>
              </g>
            ))}
            {cena.mostrar_area !== false ? <path d={areaPath} fill="url(#lgAreaGrad)" /> : null}
            <path d={linePath} fill="none" stroke={accentColor} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" />
            {coords.map((c, i) => {
              const visible = i < pathCoords.length;
              const isLast = visible && i === pathCoords.length - 1;
              return (
                <g key={i} opacity={visible ? 1 : 0}>
                  <text x={c.x} y={PAD_TOP + innerH + 40} textAnchor="middle" fill="rgba(255,255,255,0.45)" fontSize={22} fontFamily={fontFamily}>{c.rotulo}</text>
                  {isLast ? (
                    <>
                      <circle cx={c.x} cy={c.y} r={10} fill={accentColor} opacity={0.3} />
                      <circle cx={c.x} cy={c.y} r={5} fill={accentColor} />
                      <text x={c.x} y={c.y - 18} textAnchor="middle" fill={accentSecundaria} fontSize={28} fontWeight={700} fontFamily={fontFamily}>{formatVal(c.valor)}</text>
                    </>
                  ) : visible ? <circle cx={c.x} cy={c.y} r={4} fill={accentColor} opacity={0.6} /> : null}
                </g>
              );
            })}
          </svg>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ── GraficoBarra ──────────────────────────────────────────────────────────────

const GraficoBarraOverlay: React.FC<{ cena: Extract<Cena, { tipo: "GraficoBarra" }>; corPrimaria?: string; corSecundaria?: string; fonteFamilia?: string }> = ({ cena, corPrimaria, corSecundaria, fonteFamilia }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const fontFamily = resolveFontFamily(fonteFamilia);
  const accentColor = cena.cor_primaria ?? corPrimaria ?? colors.red;
  const accentSecundaria = cena.cor_secundaria ?? corSecundaria ?? colors.yellow;

  const entrada = spring({ frame, fps, config: { damping: 14, stiffness: 80 } });
  const opacity = interpolate(entrada, [0, 1], [0, 1]);
  const translateY = interpolate(entrada, [0, 1], [30, 0]);

  const barras = cena.barras;
  const maxVal = Math.max(...barras.map((b) => b.valor));

  const W = 952;
  const H = 480;
  const PAD_TOP = 32;
  const PAD_BOTTOM = 72;
  const innerH = H - PAD_TOP - PAD_BOTTOM;
  const barSpacing = Math.floor(W / barras.length);
  const barWidth = Math.floor(barSpacing * 0.6);

  const barAnimations = barras.map((_, i) => {
    const delay = i * 5;
    const bs = spring({ frame: Math.max(0, frame - delay), fps, config: { damping: 14, stiffness: 90 } });
    return interpolate(bs, [0, 1], [0, 1]);
  });

  const formatVal = (b: typeof barras[0]) => {
    if ("valor_display" in b && (b as { valor_display?: string }).valor_display) {
      return (b as { valor_display: string }).valor_display;
    }
    const u = cena.unidade ?? "";
    const v = b.valor;
    return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}${u}`;
  };

  return (
    <AbsoluteFill>
      {cena.sfx ? (
        <Sequence from={Math.round((cena.sfx.inicio_segundos ?? 0) * fps)}>
          <Audio
            src={staticFile(cena.sfx.path)}
            volume={Math.min(1, (cena.sfx.volume ?? 5) / 10)}
            endAt={cena.sfx.fim_segundos != null ? Math.round(cena.sfx.fim_segundos * fps) : undefined}
          />
        </Sequence>
      ) : null}

      <AbsoluteFill style={{ backgroundColor: "rgba(5, 8, 20, 0.90)" }} />
      <AbsoluteFill style={{ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", padding: `0 64px`, gap: spacing.md }}>
        <div style={{ opacity, transform: `translateY(${translateY}px)`, fontFamily, fontWeight: typography.weightTitle, fontSize: typography.sizeSubtitle, color: colors.white, letterSpacing: typography.trackingTight, textAlign: "center", lineHeight: typography.lineHeightTight }}>
          {cena.titulo}
        </div>
        {cena.subtitulo ? (
          <div style={{ opacity: opacity * 0.7, fontFamily, fontWeight: typography.weightCaption, fontSize: typography.sizeCaption, color: colors.textMuted, textAlign: "center" }}>{cena.subtitulo}</div>
        ) : null}
        <div style={{ opacity, width: W, flexShrink: 0 }}>
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ overflow: "visible" }}>
            <line x1={0} y1={PAD_TOP + innerH} x2={W} y2={PAD_TOP + innerH} stroke="rgba(255,255,255,0.12)" strokeWidth={1} />
            {barras.map((barra, i) => {
              const progress = barAnimations[i];
              const barH = ((barra.valor / maxVal) * innerH) * progress;
              const x = i * barSpacing + (barSpacing - barWidth) / 2;
              const y = PAD_TOP + innerH - barH;
              const isDestaque = barra.eh_destaque;
              const fillColor = isDestaque ? accentSecundaria : accentColor;
              const fillOpacity = isDestaque ? 1 : 0.6;
              return (
                <g key={i}>
                  <rect x={x} y={y} width={barWidth} height={barH} rx={8} ry={8} fill={fillColor} opacity={fillOpacity} />
                  {progress > 0.7 ? (
                    <text x={x + barWidth / 2} y={y - 14} textAnchor="middle" fill={isDestaque ? accentSecundaria : colors.white} fontSize={isDestaque ? 30 : 24} fontWeight={isDestaque ? 700 : 500} fontFamily={fontFamily} opacity={interpolate(progress, [0.7, 1], [0, 1])}>
                      {formatVal(barra)}
                    </text>
                  ) : null}
                  <text x={x + barWidth / 2} y={PAD_TOP + innerH + 44} textAnchor="middle" fill={isDestaque ? accentSecundaria : "rgba(255,255,255,0.55)"} fontSize={20} fontWeight={isDestaque ? 600 : 400} fontFamily={fontFamily}>
                    {barra.rotulo}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ── CTA ───────────────────────────────────────────────────────────────────────

const CtaOverlay: React.FC<{ cena: Extract<Cena, { tipo: "CTA" }>; corPrimaria?: string; corSecundaria?: string; fonteFamilia?: string }> = ({ cena, corPrimaria, corSecundaria, fonteFamilia }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const fontFamily = resolveFontFamily(fonteFamilia);
  const s = spring({ frame, fps, config: { damping: 14, stiffness: 90 } });
  const opacity = interpolate(s, [0, 1], [0, 1]);
  const y = interpolate(s, [0, 1], [60, 0]);
  const setaY = 16 * Math.sin((frame / fps) * 2 * Math.PI * 1.4);
  const setaCor = (cena.palavras_destacadas && cena.palavras_destacadas.length > 0)
    ? resolveWordColor(cena.palavras_destacadas[0].cor, corPrimaria, corSecundaria)
    : (corPrimaria ?? colors.red);

  const tokens = cena.texto_principal.split(/(\s+)/);
  const ctaCorMap = buildTokenCorMap(tokens, cena.palavras_destacadas ?? [], corPrimaria, corSecundaria);

  return (
    <AbsoluteFill>
      {cena.sfx ? (
        <Sequence from={Math.round((cena.sfx.inicio_segundos ?? 0) * fps)}>
          <Audio
            src={staticFile(cena.sfx.path)}
            volume={Math.min(1, (cena.sfx.volume ?? 5) / 10)}
            endAt={cena.sfx.fim_segundos != null ? Math.round(cena.sfx.fim_segundos * fps) : undefined}
          />
        </Sequence>
      ) : null}

      <AbsoluteFill style={{ backgroundColor: "rgba(8, 10, 18, 0.75)" }} />
      <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", padding: "0 64px 96px", flexDirection: "column" }}>
        <div style={{ opacity, transform: `translateY(${y}px)`, fontFamily, fontWeight: typography.weightHero, fontSize: 108, lineHeight: typography.lineHeightTight, letterSpacing: typography.trackingTight, textTransform: "uppercase", color: colors.white, textAlign: "center" }}>
          {cena.palavras_destacadas && cena.palavras_destacadas.length > 0
            ? tokens.map((token, i) => (
                <span key={i} style={{ color: ctaCorMap[i] ?? colors.white }}>{token}</span>
              ))
            : cena.texto_principal}
        </div>
        {cena.texto_secundario ? (
          <div style={{ marginTop: spacing.lg, opacity: opacity * 0.9, transform: `translateY(${y}px)`, fontFamily, fontWeight: typography.weightCaption, fontSize: typography.sizeBody, color: colors.textMuted, textAlign: "center", maxWidth: 800 }}>{cena.texto_secundario}</div>
        ) : null}
        {cena.mostrar_seta !== false ? (
          <div style={{ marginTop: spacing.xl, fontSize: 120, lineHeight: 1, color: setaCor, opacity, transform: `translateY(${setaY}px)` }}>↓</div>
        ) : null}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
