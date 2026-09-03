import { AbsoluteFill, Img, Sequence, useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import type { CtaFinal as CtaFinalConfig, ReelProps } from "@pontob/schema";
import { colors, resolveFontFamily } from "../theme";
import { useScaleFactor } from "../hooks/useScaleFactor";

/**
 * Escurece um hex (#rrggbb) multiplicando os canais por `f` (0–1). Usado para
 * gerar a base escura do gradiente a partir da cor primária da marca. Se o valor
 * não for um hex de 6 dígitos, devolve o próprio input (aceita nomes/rgb CSS).
 */
function escurecerHex(hex: string, f: number): string {
  const h = hex.replace("#", "");
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return hex;
  const n = parseInt(h, 16);
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Tela de CTA no encerramento dos formatos novos. FUNDO = gradiente da identidade
 * visual da marca (cor primária → tom escurecido dela), com um scrim radial leve
 * para leitura, LOGO do evento + copy grande em caixa alta + seta. Sem cor da
 * marca definida, cai no gradiente navy. Copy e logo editáveis no editor.
 */
export const CtaFinal: React.FC<{
  config: CtaFinalConfig;
  corPrimaria?: string;
  corSecundaria?: string;
  fonteFamilia?: string;
}> = ({ config, corPrimaria, corSecundaria, fonteFamilia }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scale = useScaleFactor();
  const fontFamily = resolveFontFamily(fonteFamilia);

  const entrada = spring({ frame, fps, config: { damping: 14, stiffness: 90 } });
  const opacity = interpolate(entrada, [0, 1], [0, 1]);
  const ty = interpolate(entrada, [0, 1], [40, 0]);
  const accent = corSecundaria ?? colors.yellow;
  const setaY = 16 * Math.sin((frame / fps) * 2 * Math.PI * 1.4);

  // Gradiente na identidade da marca: cor primária no topo → versão escura dela
  // embaixo. Sem cor primária, usa o navy do tema.
  const gradTopo = corPrimaria ?? colors.navy;
  const gradBase = corPrimaria ? escurecerHex(corPrimaria, 0.24) : colors.navyDeep;

  return (
    <AbsoluteFill>
      {/* Fundo: gradiente da identidade visual da marca. */}
      <AbsoluteFill style={{ background: `linear-gradient(150deg, ${gradTopo} 0%, ${gradBase} 100%)` }} />
      {/* Scrim radial leve: escurece o centro para a copy sem matar a cor da marca. */}
      <AbsoluteFill style={{ background: "radial-gradient(ellipse at center, rgba(0,0,0,0.52) 0%, rgba(0,0,0,0.18) 72%)" }} />

      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", padding: `0 ${Math.round(64 * scale)}px`, textAlign: "center" }}>
        {config.logo_url ? (
          <Img
            src={config.logo_url}
            style={{ maxWidth: "58%", maxHeight: "20%", objectFit: "contain", marginBottom: Math.round(44 * scale), opacity, transform: `translateY(${ty}px)` }}
          />
        ) : null}

        {config.copy ? (
          <div
            style={{ opacity, transform: `translateY(${ty}px)`, fontFamily, fontWeight: 800, fontSize: Math.round(84 * scale), lineHeight: 1.06, letterSpacing: `${-0.5 * scale}px`, textTransform: "uppercase", color: colors.white, maxWidth: "92%", textShadow: "0 2px 16px rgba(0,0,0,0.5)" }}
          >
            {config.copy}
          </div>
        ) : null}

        {/* Seta só acompanha conteúdo — nunca aparece sozinha. */}
        {config.copy || config.logo_url ? (
          <div style={{ marginTop: Math.round(40 * scale), fontSize: Math.round(96 * scale), lineHeight: 1, color: accent, opacity, transform: `translateY(${setaY}px)` }}>
            ↓
          </div>
        ) : null}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/**
 * Anexa a tela de CTA no fim do reel (após o vídeo). Usado pelos layouts de
 * aula / tela dividida / narrado. Só renderiza quando `cta_final.ativo`.
 */
export const CtaFinalSequence: React.FC<{ props: ReelProps }> = ({ props }) => {
  const { fps } = useVideoConfig();
  const cta = props.cta_final;
  if (!cta?.ativo) return null;
  const videoStart = props.video_start_segundos ?? 0;
  const videoEndRaw = (props as Record<string, unknown>).video_end_segundos;
  const videoEndSeg = typeof videoEndRaw === "number" && videoEndRaw > videoStart ? videoEndRaw : null;
  if (videoEndSeg == null) return null;
  const from = Math.round((videoEndSeg - videoStart) * fps);
  const dur = Math.round(cta.duracao_segundos * fps);
  return (
    <Sequence from={from} durationInFrames={dur} name="cta-final">
      <CtaFinal config={cta} corPrimaria={props.cor_primaria} corSecundaria={props.cor_secundaria} fonteFamilia={props.fonte_familia} />
    </Sequence>
  );
};
