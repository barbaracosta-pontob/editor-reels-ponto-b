import { AbsoluteFill, Sequence, OffthreadVideo, Audio, staticFile, delayRender, continueRender } from "remotion";
import { useMemo, useEffect, useRef } from "react";

import { ReelPropsSchema, type ReelProps, type Cena, cenaSuprimeLegenda } from "@pontob/schema";

import { HookScene } from "../scenes/HookScene";
import { CtaScene } from "../scenes/CtaScene";
import { FraseImpactoScene } from "../scenes/FraseImpactoScene";
import { ComparativoNumericoScene } from "../scenes/ComparativoNumericoScene";
import { VideoCitacaoScene } from "../scenes/VideoCitacaoScene";
import { ListaPontosScene } from "../scenes/ListaPontosScene";
import { MiniCasoScene } from "../scenes/MiniCasoScene";
import { TransicaoTextoScene } from "../scenes/TransicaoTextoScene";
import { ConviteEventoScene } from "../scenes/ConviteEventoScene";
import { GraficoLinhaScene } from "../scenes/GraficoLinhaScene";
import { GraficoBarraScene } from "../scenes/GraficoBarraScene";
import { PlaceholderScene } from "../scenes/PlaceholderScene";
import { LegendaContinua } from "../scenes/LegendaContinua";
import { TelaDividida } from "../scenes/TelaDividida";
import { AulaLayout } from "../scenes/AulaLayout";
import { NarradoLayout } from "../scenes/NarradoLayout";
import { CaixinhaPerguntaSequence, CaixinhaLayout } from "../scenes/CaixinhaPergunta";
import { colors, resolveAudioSrc } from "../theme";

export { ReelPropsSchema, type ReelProps };

const FPS = 30;

const FontLoader: React.FC<{ fonteUrl: string }> = ({ fonteUrl }) => {
  const handleRef = useRef<number | null>(null);

  useEffect(() => {
    if (!fonteUrl) return;
    handleRef.current = delayRender(`loading-font-${fonteUrl}`);
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = fonteUrl;
    link.onload = () => {
      if (handleRef.current !== null) continueRender(handleRef.current);
    };
    link.onerror = () => {
      if (handleRef.current !== null) continueRender(handleRef.current);
    };
    document.head.appendChild(link);
    return () => {
      document.head.removeChild(link);
    };
  }, [fonteUrl]);

  return null;
};

export const Reel: React.FC<ReelProps> = (props) => {
  const sequencias = useMemo(() => {
    let cursor = 0;
    return props.cenas.map((cena, index) => {
      const duracaoFrames = Math.max(1, Math.round(cena.duracao_segundos * FPS));
      // Se a cena de overlay tem inicio_overlay_segundos definido, usa esse valor
      const cenaRaw = cena as Record<string, unknown>;
      const inicioOverride = typeof cenaRaw["inicio_overlay_segundos"] === "number"
        ? (cenaRaw["inicio_overlay_segundos"] as number)
        : null;
      const inicioSegundos = inicioOverride !== null ? inicioOverride : cursor;
      const inicioFrames = Math.round(inicioSegundos * FPS);
      cursor += cena.duracao_segundos;
      return { cena, inicioFrames, duracaoFrames, index };
    });
  }, [props.cenas]);

  // Janelas (em frames) em que a legenda contínua fica escondida, porque a
  // cena naquele intervalo já tem texto próprio (Hook, gráficos, CTA, etc.).
  const janelasSuprimidas = useMemo<[number, number][]>(
    () =>
      sequencias
        .filter(({ cena }) => cenaSuprimeLegenda(cena.tipo))
        .map(({ inicioFrames, duracaoFrames }) => [inicioFrames, inicioFrames + duracaoFrames] as [number, number]),
    [sequencias],
  );

  const videoPath =
    props.video_original_path ??
    (props.cenas.find((c) => "video_path" in c) as { video_path: string } | undefined)
      ?.video_path;

  // video_start_segundos define onde o vídeo de fundo começa — independente
  // de qualquer cena. Permite editar o início de cada overlay sem mover o vídeo.
  const videoStartFrom = Math.round((props.video_start_segundos ?? 0) * FPS);
  // video_end_segundos: ponto de corte da cauda do vídeo bruto (em frames absolutos do arquivo).
  const videoEndAt = props.video_end_segundos != null
    ? Math.round((props.video_end_segundos as number) * FPS)
    : undefined;

  // Caixinha de pergunta: overlay COMPARTILHADO por todos os formatos. Fica por
  // cima do layout escolhido — por isso é anexado aqui, uma vez só, em vez de
  // dentro de cada layout.
  const comCaixinha = (conteudo: React.ReactNode) => (
    <AbsoluteFill>
      {conteudo}
      <CaixinhaPerguntaSequence props={props} />
    </AbsoluteFill>
  );

  // Formato "tela dividida": layout próprio (especialista + inserts), não a
  // timeline de cenas. Legenda entra na junção das telas.
  if (props.formato === "tela_dividida") {
    return comCaixinha(<TelaDividida props={props} />);
  }

  if (props.formato === "aula") {
    return comCaixinha(<AulaLayout props={props} />);
  }

  if (props.formato === "narrado") {
    return comCaixinha(<NarradoLayout props={props} />);
  }

  // Formato "caixinha de pergunta": especialista em tela cheia + legenda, sem
  // timeline de cenas. A caixinha em si vem do overlay compartilhado.
  if (props.formato === "caixinha_pergunta") {
    return comCaixinha(<CaixinhaLayout props={props} />);
  }

  return comCaixinha(
    <AbsoluteFill style={{ backgroundColor: colors.navy }}>
      {props.fonte_url ? <FontLoader fonteUrl={props.fonte_url} /> : null}

      {videoPath ? (
        <OffthreadVideo
          src={videoPath}
          startFrom={videoStartFrom}
          {...(videoEndAt != null ? { endAt: videoEndAt } : {})}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : null}

      {videoPath ? (
        <AbsoluteFill style={{
          background:
            "linear-gradient(180deg, rgba(0,0,0,0.4) 0%, rgba(0,0,0,0.1) 45%, rgba(0,0,0,0.6) 100%)",
          pointerEvents: "none",
        }} />
      ) : null}

      {/* Música de fundo — toca durante todo o reel */}
      {/* Durante render: path vem como URL HTTP absoluta (convertido em render/route.ts). */}
      {/* No Remotion Studio / preview local: path é relativo, usa staticFile como fallback. */}
      {props.musica_fundo ? (
        <Audio
          src={resolveAudioSrc(props.musica_fundo.path, staticFile)}
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
          <SceneRouter
            cena={cena}
            corPrimaria={props.cor_primaria}
            corSecundaria={props.cor_secundaria}
            fonteFamilia={props.fonte_familia}
          />
        </Sequence>
      ))}

      {/* Legenda contínua — camada única sobre todo o vídeo, escondida nas
          cenas com texto próprio. Só renderiza quando ativa e com dados. */}
      {props.legenda?.ativa && props.legenda_palavras && props.legenda_palavras.length > 0 ? (
        <LegendaContinua
          palavras={props.legenda_palavras}
          config={props.legenda}
          corPrimaria={props.cor_primaria}
          corSecundaria={props.cor_secundaria}
          fonteFamilia={props.fonte_familia}
          videoStartSegundos={props.video_start_segundos ?? 0}
          janelasSuprimidas={janelasSuprimidas}
        />
      ) : null}
    </AbsoluteFill>,
  );
};

const SceneRouter: React.FC<{
  cena: Cena;
  corPrimaria?: string;
  corSecundaria?: string;
  fonteFamilia?: string;
}> = ({ cena, corPrimaria, corSecundaria, fonteFamilia }) => {
  const p = { corPrimaria, corSecundaria, fonteFamilia };
  switch (cena.tipo) {
    case "Hook":
      return <HookScene cena={cena} {...p} />;
    case "CTA":
      return <CtaScene cena={cena} {...p} />;
    case "FraseImpacto":
      return <FraseImpactoScene cena={cena} {...p} />;
    case "ComparativoNumerico":
      return <ComparativoNumericoScene cena={cena} corPrimaria={corPrimaria} corSecundaria={corSecundaria} fonteFamilia={fonteFamilia} />;
    case "VideoCitacao":
      return <VideoCitacaoScene cena={cena} corPrimaria={corPrimaria} fonteFamilia={fonteFamilia} />;
    case "ListaPontos":
      return <ListaPontosScene cena={cena} corPrimaria={corPrimaria} fonteFamilia={fonteFamilia} />;
    case "MiniCaso":
      return <MiniCasoScene cena={cena} {...p} />;
    case "TransicaoTexto":
      return <TransicaoTextoScene cena={cena} fonteFamilia={fonteFamilia} />;
    case "ConviteEvento":
      return <ConviteEventoScene cena={cena} corPrimaria={corPrimaria} fonteFamilia={fonteFamilia} />;
    case "GraficoLinha":
      return <GraficoLinhaScene cena={cena} corPrimaria={corPrimaria} corSecundaria={corSecundaria} fonteFamilia={fonteFamilia} />;
    case "GraficoBarra":
      return <GraficoBarraScene cena={cena} corPrimaria={corPrimaria} corSecundaria={corSecundaria} fonteFamilia={fonteFamilia} />;
    case "VideoSimples":
      return null; // Só o vídeo de fundo, sem overlay
    default: {
      const _exhaustive: never = cena;
      return <PlaceholderScene tipo={(_exhaustive as Cena).tipo} />;
    }
  }
};

export const defaultReelProps: ReelProps = {
  duracao_total_estimada: 66,
  video_original_path: "jobs/teste01/video.mp4",
  video_start_segundos: 0,
  cenas: [
    {
      tipo: "Hook",
      titulo: "VIVER COM 20 MIL POR MES EXIGE 2 MILHOES",
      palavras_destacadas: [
        { palavra: "20 MIL", cor: "primaria" },
        { palavra: "2 MILHOES", cor: "primaria" },
      ],
      duracao_segundos: 6,
      animacao_entrada: "spring",
    },
    {
      tipo: "FraseImpacto",
      texto: "A maioria investe certo. Mas no instrumento errado.",
      palavras_destacadas: [{ palavra: "instrumento errado", cor: "primaria" }],
      alinhamento: "centro",
      duracao_segundos: 5,
      fundo: "navy",
    },
    {
      tipo: "GraficoLinha",
      titulo: "Patrimonio acumulado",
      subtitulo: "Juros compostos com aportes mensais",
      unidade: "R$",
      pontos: [
        { rotulo: "Jan", valor: 10000 },
        { rotulo: "Jun", valor: 14200 },
        { rotulo: "Dez", valor: 21000 },
      ],
      mostrar_area: true,
      duracao_segundos: 7,
    },
    {
      tipo: "GraficoBarra",
      titulo: "Rentabilidade anual por estrategia",
      unidade: "%",
      barras: [
        { rotulo: "Poupanca", valor: 6.2, eh_destaque: false },
        { rotulo: "Tesouro", valor: 11.8, eh_destaque: false },
        { rotulo: "Metodo V", valor: 28.3, eh_destaque: true },
      ],
      duracao_segundos: 7,
    },
    {
      tipo: "CTA",
      texto_principal: "Comente MARATONA aqui embaixo",
      texto_secundario: "Vou te enviar a inscricao gratuita",
      duracao_segundos: 6,
      mostrar_seta: true,
      cor_seta: "primaria",
    },
  ],
};
