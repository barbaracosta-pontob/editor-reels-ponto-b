import {
  AbsoluteFill,
  OffthreadVideo,
  Audio,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
} from "remotion";
import type { CaixinhaPergunta as CaixinhaConfig, ReelProps } from "@pontob/schema";
import { colors, resolveAudioSrc } from "../theme";
import { useScaleFactor } from "../hooks/useScaleFactor";
import { LegendaContinua } from "./LegendaContinua";
import { CtaFinalSequence } from "./CtaFinal";

/**
 * Caixinha de pergunta — réplica do sticker de pergunta do Instagram.
 *
 * Estrutura visual (de cima para baixo): pill escuro com o texto do header
 * ("Faça uma pergunta") + cartão branco com a pergunta, ambos centrados e com
 * sombra. Fonte do SISTEMA de propósito: o efeito depende de o elemento ler
 * como print de rede social, não como peça da marca.
 *
 * A copy é digitada no editor (não vem do transcript nem do LLM).
 */

// Tipografia do sticker — a do Instagram, não a do especialista.
const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export const CaixinhaPerguntaCard: React.FC<{ config: CaixinhaConfig }> = ({ config }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const scale = useScaleFactor();

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
          fontFamily: FONT_STACK,
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

/**
 * Coloca a caixinha na linha do tempo. O intervalo do config está na linha do
 * VÍDEO BRUTO (igual aos inserts), então desconta video_start_segundos.
 * Renderiza em qualquer formato — é o overlay compartilhado.
 */
export const CaixinhaPerguntaSequence: React.FC<{ props: ReelProps }> = ({ props }) => {
  const { fps } = useVideoConfig();
  const cfg = props.caixinha;
  if (!cfg?.ativo) return null;
  if (!cfg.pergunta && !cfg.header) return null;

  const videoStart = props.video_start_segundos ?? 0;
  const from = Math.max(0, Math.round((cfg.inicio_segundos - videoStart) * fps));
  const dur = Math.max(1, Math.round((cfg.fim_segundos - cfg.inicio_segundos) * fps));

  return (
    <Sequence from={from} durationInFrames={dur} name="caixinha-pergunta">
      <CaixinhaPerguntaCard config={cfg} />
    </Sequence>
  );
};

/**
 * Formato "caixinha_pergunta" (preset): especialista em TELA CHEIA + legenda
 * contínua + a caixinha. Sem inserts e sem timeline de cenas — reproduz o post
 * de rede social em que o especialista responde a uma pergunta recebida.
 * A caixinha aqui é o elemento central, mas continua no mesmo config/overlay.
 */
export const CaixinhaLayout: React.FC<{ props: ReelProps }> = ({ props }) => {
  const { fps } = useVideoConfig();
  const videoPath = props.video_original_path ?? "";
  const videoStart = props.video_start_segundos ?? 0;
  const videoStartFrom = Math.round(videoStart * fps);
  const videoEndRaw = (props as Record<string, unknown>).video_end_segundos;
  const videoEndAt =
    typeof videoEndRaw === "number" && videoEndRaw > videoStart ? Math.round(videoEndRaw * fps) : undefined;
  const legenda = props.legenda;

  return (
    <AbsoluteFill style={{ backgroundColor: colors.navy }}>
      {videoPath ? (
        <OffthreadVideo
          src={videoPath}
          startFrom={videoStartFrom}
          {...(videoEndAt != null ? { endAt: videoEndAt } : {})}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : null}

      {props.musica_fundo ? (
        <Audio
          src={resolveAudioSrc(props.musica_fundo.path, staticFile)}
          volume={Math.min(1, (props.musica_fundo.volume ?? 3) / 10)}
        />
      ) : null}

      {legenda?.ativa && props.legenda_palavras && props.legenda_palavras.length > 0 ? (
        <LegendaContinua
          palavras={props.legenda_palavras}
          config={legenda}
          corPrimaria={props.cor_primaria}
          corSecundaria={props.cor_secundaria}
          fonteFamilia={props.fonte_familia}
          videoStartSegundos={videoStart}
          janelasSuprimidas={[]}
        />
      ) : null}

      <CtaFinalSequence props={props} />
    </AbsoluteFill>
  );
};
