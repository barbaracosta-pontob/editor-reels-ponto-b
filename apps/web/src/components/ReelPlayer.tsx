"use client";

/**
 * Preview do reel usando @remotion/player.
 * durationInFrames = janela de trim (duracao_total_estimada), nao soma dos overlays.
 * Mudar duracao de uma cena nunca altera o tempo total do video.
 */

import { Player, PlayerRef } from "@remotion/player";
import { useEffect, useRef } from "react";
import type { ReelProps } from "@pontob/schema";
import { ReelForPlayer } from "./ReelComposition";

const FPS = 30;
const WIDTH = 1080;
const HEIGHT = 1920;

// O Remotion pre-monta tags <Html5Audio /> compartilhadas (padrao 5) para driblar o
// autoplay do browser. Cada cena tem SFX + o video de fundo tem audio; em transicoes
// varios tocam ao mesmo tempo e estouram o limite. O schema permite ate 15 cenas, entao
// reservamos folga (15 SFX + video + margem). Valor constante evita remount do Player.
const NUMBER_OF_SHARED_AUDIO_TAGS = 20;

interface ReelPlayerProps {
  props: ReelProps;
  initialFrame?: number;
}

export function ReelPlayer({ props, initialFrame = 0 }: ReelPlayerProps) {
  const playerRef = useRef<PlayerRef>(null);

  // Duracao total = janela de trim definida pelo agente (video_end - video_start).
  // NUNCA e a soma das duracoes dos overlays.
  const totalFrames = Math.max(
    1,
    Math.round(props.duracao_total_estimada * FPS)
  );

  useEffect(() => {
    if (playerRef.current) {
      playerRef.current.seekTo(initialFrame);
    }
  }, [initialFrame]);

  return (
    <Player
      ref={playerRef}
      component={ReelForPlayer}
      inputProps={props}
      durationInFrames={totalFrames}
      compositionWidth={WIDTH}
      compositionHeight={HEIGHT}
      fps={FPS}
      numberOfSharedAudioTags={NUMBER_OF_SHARED_AUDIO_TAGS}
      style={{
        width: "100%",
        height: "100%",
        borderRadius: 8,
        overflow: "hidden",
      }}
      controls
      loop
      clickToPlay
      acknowledgeRemotionLicense
      errorFallback={({ error }) => (
        <div style={{
          width: "100%", height: "100%",
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "#0c0c0c", color: "#888", fontSize: 13, padding: 16,
          textAlign: "center",
        }}>
          Erro no player: {error.message}
        </div>
      )}
    />
  );
}
