import { AbsoluteFill, useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { useMemo } from "react";
import type { LegendaConfig, LegendaPalavra } from "@pontob/schema";
import { agruparEmFrases, posicaoEfetiva } from "@pontob/schema";
import { colors, resolveFontFamily, resolveWordColor } from "../theme";
import { useScaleFactor, useSafeZoneBottom, useSafeZoneTop } from "../hooks/useScaleFactor";

/** Janela de frames [inicio, fim) em que a legenda fica escondida (cena com texto próprio). */
export type JanelaSuprimida = [number, number];

type Base = {
  config: LegendaConfig;
  corPrimaria?: string;
  corSecundaria?: string;
  fonteFamilia?: string;
};

const SOMBRA = "0 4px 20px rgba(0,0,0,0.55), 0 2px 4px rgba(0,0,0,0.65)";
// Sombra reforçada (halo) para a legenda na junção das telas, onde o fundo é
// imprevisível — garante leitura sobre qualquer imagem.
const SOMBRA_FORTE = "0 0 3px rgba(0,0,0,0.95), 0 0 10px rgba(0,0,0,0.9), 0 3px 14px rgba(0,0,0,0.85)";
// Depois que uma palavra/frase termina, mantém na tela por até este tempo de
// silêncio antes de apagar (evita piscar em micro-pausas, sem "segurar" texto
// morto durante um silêncio longo).
const SEGURA_SILENCIO_S = 1.0;

/** Índice da última palavra cujo início já passou de `t` (−1 se nenhuma). */
function indiceAtivo(palavras: { inicio: number }[], t: number): number {
  let idx = -1;
  for (let i = 0; i < palavras.length; i++) {
    if (palavras[i].inicio <= t) idx = i;
    else break;
  }
  return idx;
}

function estiloPosicao(
  posicao: "alto" | "centro" | "rodape",
  safeTop: number,
  safeBottom: number,
  height: number,
  padX: number,
): React.CSSProperties {
  const base: React.CSSProperties = {
    alignItems: "center",
    padding: `0 ${padX}px`,
    textAlign: "center",
  };
  if (posicao === "alto") {
    return { ...base, justifyContent: "flex-start", paddingTop: Math.round(safeTop + height * 0.06) };
  }
  if (posicao === "rodape") {
    return { ...base, justifyContent: "flex-end", paddingBottom: safeBottom };
  }
  return { ...base, justifyContent: "center" }; // centro
}

export const LegendaContinua: React.FC<
  Base & {
    palavras: LegendaPalavra[];
    videoStartSegundos: number;
    janelasSuprimidas: JanelaSuprimida[];
    // Força uma posição (usado no formato tela dividida, para sentar na junção).
    posicaoForcada?: "alto" | "centro" | "rodape";
    // Deslocamento vertical adicional (% da altura) além do da config — para a
    // legenda cair exatamente na divisão das telas.
    offsetSeamPct?: number;
  }
> = ({ palavras, config, corPrimaria, corSecundaria, fonteFamilia, videoStartSegundos, janelasSuprimidas, posicaoForcada, offsetSeamPct }) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const scale = useScaleFactor();
  const safeBottom = useSafeZoneBottom();
  const safeTop = useSafeZoneTop();

  const fontFamily = resolveFontFamily(fonteFamilia);
  const posicao = posicaoForcada ?? posicaoEfetiva(config);
  const sombra = posicaoForcada != null ? SOMBRA_FORTE : SOMBRA;
  const padX = Math.round(64 * scale);

  const frases = useMemo(
    () => agruparEmFrases(palavras, config.palavras_por_frase ?? 3),
    [palavras, config.palavras_por_frase],
  );

  // Escondida durante cena com texto próprio.
  if (janelasSuprimidas.some(([a, b]) => frame >= a && frame < b)) return null;
  if (!palavras.length) return null;

  // Tempo no vídeo bruto correspondente a este frame global.
  const t = videoStartSegundos + frame / fps;
  const container = estiloPosicao(posicao, safeTop, safeBottom, height, padX);
  // Ajuste fino vertical (% da altura) + deslocamento da junção (tela dividida).
  const offsetY = Math.round((((config.deslocamento_y ?? 0) + (offsetSeamPct ?? 0)) / 100) * height);
  if (offsetY !== 0) container.transform = `translateY(${offsetY}px)`;
  const framesDe = (segundos: number) => Math.round((segundos - videoStartSegundos) * fps);

  // Animação de entrada (pop) a partir de um instante em segundos.
  const popDe = (inicioSeg: number) => {
    const s = spring({ frame: Math.max(0, frame - framesDe(inicioSeg)), fps, config: { damping: 16, stiffness: 120, mass: 0.5 } });
    return { opacity: interpolate(s, [0, 1], [0, 1]), scale: interpolate(s, [0, 1], [0.72, 1]) };
  };

  const envolver = (inner: React.ReactNode) => (
    <AbsoluteFill style={{ ...container, pointerEvents: "none" }}>{inner}</AbsoluteFill>
  );

  const caixaStyle: React.CSSProperties = config.caixa
    ? { background: "rgba(0,0,0,0.55)", padding: `${Math.round(10 * scale)}px ${Math.round(22 * scale)}px`, borderRadius: Math.round(14 * scale) }
    : {};

  // ── Preset: palavra única ─────────────────────────────────────────────────
  if (config.estilo === "palavra_unica") {
    const idx = indiceAtivo(palavras, t);
    if (idx < 0) return null;
    const atual = palavras[idx];
    const proxInicio = palavras[idx + 1]?.inicio ?? Infinity;
    // Apaga em silêncio longo depois da palavra.
    if (t > atual.fim + SEGURA_SILENCIO_S && t < proxInicio) return null;

    const pop = popDe(atual.inicio);
    return envolver(
      <div
        style={{
          ...caixaStyle,
          fontFamily,
          fontWeight: 800,
          fontSize: Math.round(90 * scale),
          lineHeight: 1.05,
          letterSpacing: -1,
          color: colors.white,
          textShadow: sombra,
          opacity: pop.opacity,
          transform: `scale(${pop.scale})`,
        }}
      >
        {atual.texto}
      </div>,
    );
  }

  // Presets baseados em frase (frase_limpa e dinamica).
  const fi = indiceAtivo(frases, t);
  if (fi < 0) return null;
  const frase = frases[fi];
  const proximaFrase = frases[fi + 1]?.inicio ?? Infinity;
  if (t > frase.fim + SEGURA_SILENCIO_S && t < proximaFrase) return null;

  // ── Preset: frase limpa ───────────────────────────────────────────────────
  if (config.estilo === "frase_limpa") {
    const s = spring({ frame: Math.max(0, frame - framesDe(frase.inicio)), fps, config: { damping: 200, stiffness: 100 } });
    const opacity = interpolate(s, [0, 1], [0, 1]);
    return envolver(
      <div
        style={{
          ...caixaStyle,
          fontFamily,
          fontWeight: 700,
          fontSize: Math.round(48 * scale),
          lineHeight: 1.22,
          color: colors.white,
          textShadow: sombra,
          maxWidth: "90%",
          opacity,
        }}
      >
        {frase.palavras.map((p) => p.texto).join(" ")}
      </div>,
    );
  }

  // ── Preset: dinâmica (palavra ativa destacada) ────────────────────────────
  const corDestaque = resolveWordColor(config.cor_destaque ?? "primaria", corPrimaria, corSecundaria);
  return envolver(
    <div
      style={{
        ...caixaStyle,
        fontFamily,
        fontWeight: 800,
        fontSize: Math.round(56 * scale),
        lineHeight: 1.15,
        letterSpacing: -0.5,
        textShadow: sombra,
        maxWidth: "92%",
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "center",
        gap: `${Math.round(6 * scale)}px ${Math.round(16 * scale)}px`,
      }}
    >
      {frase.palavras.map((p, i) => {
        const jaFalada = p.inicio <= t;
        const proxNaFrase = frase.palavras[i + 1]?.inicio ?? frase.fim + 0.001;
        const ativa = t >= p.inicio && t < proxNaFrase;
        const pop = popDe(p.inicio);
        return (
          <span
            key={i}
            style={{
              color: ativa ? corDestaque : colors.white,
              opacity: jaFalada ? pop.opacity : 0.32,
              transform: ativa ? `scale(${pop.scale})` : "none",
              display: "inline-block",
            }}
          >
            {p.texto}
          </span>
        );
      })}
    </div>,
  );
};
