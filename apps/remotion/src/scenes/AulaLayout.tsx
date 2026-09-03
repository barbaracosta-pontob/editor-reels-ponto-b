import {
  AbsoluteFill,
  OffthreadVideo,
  Audio,
  Sequence,
  useVideoConfig,
} from "remotion";
import type { ReelProps, Regiao } from "@pontob/schema";
import { LegendaContinua } from "./LegendaContinua";
import { CtaFinalSequence } from "./CtaFinal";

/**
 * Formato "Aula": a gravação já traz slide (tela cheia) + câmera do especialista
 * num PiP. Recortamos as duas regiões do MESMO vídeo e montamos um split — slide
 * dominante + especialista ampliado. Sem linha de divisão. Legenda na junção.
 * Antes de `slide_inicio_segundos`, mostra o vídeo inteiro (intro em tela cheia).
 */

/**
 * Mostra uma sub-região (frações 0–1) de um vídeo dentro de um container de
 * tamanho conhecido (px), sem distorção. `fit` = "cover" (preenche, corta) ou
 * "contain" (mostra inteiro, com folga). Assume o aspect da fonte (16:9).
 */
const CropView: React.FC<{
  src: string;
  regiao: Regiao;
  fit: "cover" | "contain";
  containerW: number;
  containerH: number;
  sourceAspect: number;
  startFrom: number;
  endAt?: number;
  bg?: string;
  // Aplica realce de nitidez (unsharp mask). Usado no recorte da câmera, que é
  // muito ampliado (~3x) e fica borrado. Paliativo: melhora a percepção, não cria
  // pixel novo — o limite real é a resolução da câmera na gravação.
  sharpen?: boolean;
}> = ({ src, regiao, fit, containerW, containerH, sourceAspect, startFrom, endAt, bg = "#0a1420", sharpen = false }) => {
  const { x, y, w, h } = regiao;
  // D = largura de exibição do vídeo inteiro (px). Escolhida para a região
  // cobrir (max) ou caber (min) no container.
  const D =
    fit === "cover"
      ? Math.max(containerW / w, (containerH * sourceAspect) / h)
      : Math.min(containerW / w, (containerH * sourceAspect) / h);
  const videoW = D;
  const videoH = D / sourceAspect;
  const regiaoW = w * videoW;
  const regiaoH = h * videoH;
  // Centraliza a região no container (folga simétrica no contain, corte no cover).
  const left = (containerW - regiaoW) / 2 - x * videoW;
  const top = (containerH - regiaoH) / 2 - y * videoH;

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
      <OffthreadVideo
        src={src}
        muted
        startFrom={startFrom}
        {...(endAt != null ? { endAt } : {})}
        style={{ position: "absolute", width: videoW, height: videoH, left, top, objectFit: "fill", filter: sharpen ? "url(#aula-sharpen)" : undefined }}
      />
    </AbsoluteFill>
  );
};

export const AulaLayout: React.FC<{ props: ReelProps }> = ({ props }) => {
  const { fps, width, height } = useVideoConfig();
  const vertical = height >= width;

  const cfg = props.aula;
  const splitPct = cfg?.split_pct ?? 60; // slide dominante
  const cameraRegiao: Regiao = cfg?.camera_regiao ?? { x: 0.008, y: 0.319, w: 0.175, h: 0.333 };
  const slideRegiao: Regiao = cfg?.slide_regiao ?? { x: 0.1875, y: 0, w: 0.8125, h: 1 };
  const sourceAspect = cfg?.source_aspect ?? 16 / 9;
  const slideInicio = cfg?.slide_inicio_segundos ?? 0;

  const videoPath = props.video_original_path ?? "";
  const videoStart = props.video_start_segundos ?? 0;
  const videoStartFrom = Math.round(videoStart * fps);
  const videoEndRaw = (props as Record<string, unknown>).video_end_segundos;
  const videoEndAt =
    typeof videoEndRaw === "number" && videoEndRaw > videoStart ? Math.round(videoEndRaw * fps) : undefined;

  // Tamanhos (px) das duas metades.
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

  const slideCrop = (
    <CropView src={videoPath} regiao={slideRegiao} fit="contain" containerW={slideW} containerH={slideH} sourceAspect={sourceAspect} startFrom={videoStartFrom} endAt={videoEndAt} />
  );
  const specCrop = (
    <CropView src={videoPath} regiao={cameraRegiao} fit="cover" containerW={specW} containerH={specH} sourceAspect={sourceAspect} startFrom={videoStartFrom} endAt={videoEndAt} bg="#000" sharpen />
  );

  const slideInicioFrame = Math.round((slideInicio - videoStart) * fps);
  const legenda = props.legenda;
  const offsetSeam = vertical ? splitPct - 50 : 0;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {/* Áudio contínuo do especialista (as camadas de vídeo são mudas). */}
      {videoPath ? (
        <Audio src={videoPath} startFrom={videoStartFrom} {...(videoEndAt != null ? { endAt: videoEndAt } : {})} />
      ) : null}

      {/* Split slide + especialista — sempre presente, alinhado ao tempo global. */}
      <AbsoluteFill>
        <div style={slidePane}>{slideCrop}</div>
        <div style={specPane}>{specCrop}</div>
      </AbsoluteFill>

      {/* Intro em tela cheia por cima, só até o slide começar. */}
      {slideInicioFrame > 0 && videoPath ? (
        <Sequence from={0} durationInFrames={slideInicioFrame} name="intro">
          <AbsoluteFill style={{ overflow: "hidden", background: "#000" }}>
            <OffthreadVideo src={videoPath} muted startFrom={videoStartFrom} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          </AbsoluteFill>
        </Sequence>
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
          posicaoForcada="centro"
          offsetSeamPct={offsetSeam}
        />
      ) : null}

      <CtaFinalSequence props={props} />
    </AbsoluteFill>
  );
};
