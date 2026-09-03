import {
  AbsoluteFill,
  OffthreadVideo,
  Img,
  Sequence,
  useVideoConfig,
  useCurrentFrame,
  interpolate,
} from "remotion";
import type { ReelProps } from "@pontob/schema";
import { LegendaContinua } from "./LegendaContinua";
import { CtaFinalSequence } from "./CtaFinal";
import { OverlayTextoInsert, resolverAssetsInsert } from "./TelaDividida";

/**
 * Formato "Narrado": a voz do especialista conduz e os inserts do tema cobrem a
 * tela inteira. O vídeo do especialista fica por baixo como fallback (aparece
 * onde não há insert) e fornece o áudio. Legenda em posição normal.
 */

const InsertFull: React.FC<{ src: string; durF: number }> = ({ src, durF }) => {
  const frame = useCurrentFrame();
  const k = interpolate(frame, [0, durF], [1.0, 1.08], { extrapolateRight: "clamp" });
  const px = interpolate(frame, [0, durF], [-1.5, 1.5], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${k}) translateX(${px}%)` }} />
    </AbsoluteFill>
  );
};

/** B-roll de vídeo (mudo) cobrindo a tela inteira — o áudio vem da base. Sem fade. */
const InsertFullVideo: React.FC<{ src: string }> = ({ src }) => {
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <OffthreadVideo src={src} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    </AbsoluteFill>
  );
};

export const NarradoLayout: React.FC<{ props: ReelProps }> = ({ props }) => {
  const { fps } = useVideoConfig();
  const inserts = props.narrado?.inserts ?? [];
  const videoPath = props.video_original_path ?? "";
  const videoStart = props.video_start_segundos ?? 0;
  const videoStartFrom = Math.round(videoStart * fps);
  const videoEndRaw = (props as Record<string, unknown>).video_end_segundos;
  const videoEndAt =
    typeof videoEndRaw === "number" && videoEndRaw > videoStart ? Math.round(videoEndRaw * fps) : undefined;

  const legenda = props.legenda;

  // Inserts CONTÍGUOS: cada um dura até o próximo começar (sem gap de arredondamento).
  const froms = inserts.map((x) => Math.max(0, Math.round((x.inicio - videoStart) * fps)));
  const endFrameRel = videoEndAt != null
    ? videoEndAt - videoStartFrom
    : (inserts.length ? froms[froms.length - 1] + Math.max(1, Math.round((inserts[inserts.length - 1].fim - inserts[inserts.length - 1].inicio) * fps)) : 0);
  const assetsNarrado = resolverAssetsInsert(inserts);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {/* Base: vídeo do especialista (áudio + fallback visual onde falta insert). */}
      {videoPath ? (
        <>
          <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
            <defs>
              <filter id="esp-sharpen">
                <feConvolveMatrix order="3" preserveAlpha="true" kernelMatrix="0 -0.4 0  -0.4 2.6 -0.4  0 -0.4 0" />
              </filter>
            </defs>
          </svg>
          <OffthreadVideo
            src={videoPath}
            startFrom={videoStartFrom}
            {...(videoEndAt != null ? { endAt: videoEndAt } : {})}
            style={{ width: "100%", height: "100%", objectFit: "cover", filter: "url(#esp-sharpen)" }}
          />
        </>
      ) : null}

      {/* Inserts cobrindo a tela inteira, CONTÍGUOS (sem gap/fade entre eles).
          Bloco sem asset herda o do vizinho (nunca fica preto). */}
      {inserts.map((ins, i) => {
        const asset = assetsNarrado[i];
        const from = froms[i];
        const durF = Math.max(1, (i < inserts.length - 1 ? froms[i + 1] : endFrameRel) - from);
        const ehVideo = !!asset && asset.tipo === "video" && !!asset.video_url;
        return (
          <Sequence key={i} from={from} durationInFrames={durF} name={`insert-${i}`}>
            {asset ? (ehVideo ? <InsertFullVideo src={asset.video_url as string} /> : <InsertFull src={asset.image_url as string} durF={durF} />) : null}
            {ins.overlay_texto ? <OverlayTextoInsert texto={ins.overlay_texto} /> : null}
          </Sequence>
        );
      })}

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
