import {
  AbsoluteFill,
  OffthreadVideo,
  Img,
  Sequence,
  Audio,
  staticFile,
  useVideoConfig,
  useCurrentFrame,
  interpolate,
} from "remotion";
import type { ReelProps } from "@pontob/schema";
import { resolveAudioSrc } from "../theme";
import { LegendaContinua } from "./LegendaContinua";
import { CtaFinalSequence } from "./CtaFinal";

/** Uma imagem de insert com zoom/pan suave (Ken Burns). Sem fade — o fade de
 * entrada revelava o fundo entre um insert e outro (flash azul). */
const InsertKenBurns: React.FC<{ src: string; durF: number }> = ({ src, durF }) => {
  const frame = useCurrentFrame();
  const k = interpolate(frame, [0, durF], [1.0, 1.1], { extrapolateRight: "clamp" });
  const px = interpolate(frame, [0, durF], [-2, 2], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <Img
        src={src}
        style={{ width: "100%", height: "100%", objectFit: "cover", transform: `scale(${k}) translateX(${px}%)` }}
      />
    </AbsoluteFill>
  );
};

/** Um b-roll de vídeo (mudo) cobrindo o insert. Sem fade (evita flash de fundo). */
const InsertVideo: React.FC<{ src: string }> = ({ src }) => {
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <OffthreadVideo src={src} muted style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    </AbsoluteFill>
  );
};

/** Faixa de texto (dado/fato recente) sobre o insert. Copyright-safe: só texto. */
export const OverlayTextoInsert: React.FC<{ texto: string }> = ({ texto }) => (
  <AbsoluteFill style={{ justifyContent: "flex-end", pointerEvents: "none" }}>
    <div style={{ margin: "0 5% 7%", background: "rgba(8,15,25,0.82)", borderLeft: "5px solid #f5a623", borderRadius: 8, padding: "12px 16px", color: "#fff", fontSize: 36, fontWeight: 600, lineHeight: 1.25, textShadow: "0 2px 8px rgba(0,0,0,0.6)" }}>{texto}</div>
  </AbsoluteFill>
);

type AssetLike = { tipo?: string; video_url?: string; image_url?: string };
/**
 * Para cada bloco, resolve QUAL asset renderizar: o próprio, ou — se o bloco
 * ficou sem asset (busca não achou nada) — o do vizinho mais próximo (anterior,
 * senão o próximo). Evita "buraco preto" no meio da timeline. Mantém o tempo do
 * bloco atual; só empresta o visual. Retorna null só se NENHUM bloco tem asset.
 */
export function resolverAssetsInsert<T extends AssetLike>(inserts: T[]): (T | null)[] {
  const tem = (x?: T | null) => !!x && ((x.tipo === "video" && !!x.video_url) || !!x.image_url);
  const out: (T | null)[] = new Array(inserts.length).fill(null);
  let ult: T | null = null;
  for (let i = 0; i < inserts.length; i++) {
    if (tem(inserts[i])) ult = inserts[i];
    out[i] = tem(inserts[i]) ? inserts[i] : ult;
  }
  let prox: T | null = null;
  for (let i = inserts.length - 1; i >= 0; i--) {
    if (tem(inserts[i])) prox = inserts[i];
    if (!out[i]) out[i] = prox;
  }
  return out;
}

/**
 * Formato "Tela dividida": especialista numa metade, sequência de inserts do
 * tema na outra. Orientação derivada do aspect ratio (vertical no 9:16 e 1:1,
 * horizontal no 16:9). Sem linha de divisão. Legenda (se ativa) na junção.
 */
export const TelaDividida: React.FC<{ props: ReelProps }> = ({ props }) => {
  const { fps, width, height } = useVideoConfig();
  const vertical = height >= width; // 9:16 e 1:1 => vertical; 16:9 => horizontal

  const cfg = props.tela_dividida;
  const splitPct = cfg?.split_pct ?? 55;
  const especialistaPrimeiro = (cfg?.especialista_posicao ?? "inicio") === "inicio";
  const inserts = cfg?.inserts ?? [];

  const videoPath = props.video_original_path ?? "";
  const videoStart = props.video_start_segundos ?? 0;
  const videoStartFrom = Math.round(videoStart * fps);
  const videoEnd = (props as Record<string, unknown>).video_end_segundos;
  const videoEndAt =
    typeof videoEnd === "number" && videoEnd > videoStart ? Math.round(videoEnd * fps) : undefined;

  const videoHalf = (
    <AbsoluteFill style={{ overflow: "hidden", background: "#000" }}>
      {videoPath ? (
        <>
          {/* Realce de nitidez (unsharp) — paliativo p/ gravações de baixa
              resolução ampliadas na metade do especialista. Não cria pixel novo. */}
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
    </AbsoluteFill>
  );

  // Inserts CONTÍGUOS: cada um dura exatamente até o próximo começar (sem gaps de
  // arredondamento). Sem isso + sem fade, não há mais flash de fundo entre inserts.
  const froms = inserts.map((ins) => Math.max(0, Math.round((ins.inicio - videoStart) * fps)));
  const endFrameRel =
    videoEndAt != null
      ? videoEndAt - videoStartFrom
      : (inserts.length ? froms[froms.length - 1] + Math.max(1, Math.round((inserts[inserts.length - 1].fim - inserts[inserts.length - 1].inicio) * fps)) : 0);

  const assets = resolverAssetsInsert(inserts);
  const insertHalf = (
    <AbsoluteFill style={{ overflow: "hidden", background: "#000" }}>
      {inserts.map((ins, i) => {
        const asset = assets[i];
        if (!asset) return null; // nenhum insert do vídeo tem asset
        const ehVideo = asset.tipo === "video" && !!asset.video_url;
        const from = froms[i];
        const proximo = i < inserts.length - 1 ? froms[i + 1] : endFrameRel;
        const durF = Math.max(1, proximo - from);
        return (
          <Sequence key={i} from={from} durationInFrames={durF} name={`insert-${i}`}>
            {ehVideo ? <InsertVideo src={asset.video_url as string} /> : <InsertKenBurns src={asset.image_url as string} durF={durF} />}
            {ins.overlay_texto ? <OverlayTextoInsert texto={ins.overlay_texto} /> : null}
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

  // Legenda na junção: parte de "centro" e desloca até a linha de divisão (vertical).
  const legenda = props.legenda;
  const offsetSeam = vertical ? splitPct - 50 : 0;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <div style={primeiro}>{a}</div>
      <div style={segundo}>{b}</div>

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
          posicaoForcada="centro"
          offsetSeamPct={offsetSeam}
        />
      ) : null}

      <CtaFinalSequence props={props} />
    </AbsoluteFill>
  );
};
