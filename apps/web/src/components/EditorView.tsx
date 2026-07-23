"use client";

import { useState, useMemo, useEffect } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { AppNav } from "@/components/AppNav";
import { ActionButton } from "@/components/ActionButton";
import type { Job, Cena } from "@/types";
import type { ReelProps } from "@pontob/schema";
import styles from "./EditorView.module.css";

// Player carregado sem SSR
const ReelPlayer = dynamic(
  () => import("./ReelPlayer").then((m) => m.ReelPlayer),
  { ssr: false, loading: () => <div className={styles.playerLoading}>Carregando player...</div> }
);

// ?? Constantes ????????????????????????????????????????????????????????????????

const TIPO_LABELS: Record<string, string> = {
  Hook: "Hook",
  FraseImpacto: "Frase de Impacto",
  ComparativoNumerico: "Comparativo",
  VideoCitacao: "Video + Citacao",
  ListaPontos: "Lista de Pontos",
  MiniCaso: "Mini Caso",
  TransicaoTexto: "Transicao",
  CTA: "CTA",
  ConviteEvento: "Convite / Evento",
  GraficoLinha: "Grafico de Linha",
  GraficoBarra: "Grafico de Barras",
  VideoSimples: "Video Simples",
};

const TIPO_COLORS: Record<string, string> = {
  Hook: "var(--c-hook)",
  FraseImpacto: "var(--c-frase)",
  ComparativoNumerico: "var(--c-comparativo)",
  VideoCitacao: "var(--c-citacao)",
  ListaPontos: "var(--c-lista)",
  MiniCaso: "var(--c-caso)",
  TransicaoTexto: "var(--c-transicao)",
  CTA: "var(--c-cta)",
  ConviteEvento: "var(--c-evento)",
  GraficoLinha: "var(--c-comparativo)",
  GraficoBarra: "var(--c-comparativo)",
  VideoSimples: "var(--c-citacao)",
};

const FPS = 30;

type RenderPhase = "bundling" | "rendering" | "encoding";
type RenderProgress = { frames: number; total: number; eta: string; phase?: RenderPhase };

function getPreview(cena: Cena): string {
  const c = cena as Record<string, unknown>;
  return String(
    c.titulo ?? c.nome_evento ?? c.texto ?? c.texto_principal ?? c.resultado_texto ?? ""
  ).slice(0, 50);
}

// ?? EditorView ????????????????????????????????????????????????????????????????

interface EditorViewProps {
  job: Job;
  onNew: () => void;
}

export function EditorView({ job, onNew }: EditorViewProps) {
  const [scenes, setScenes] = useState<Cena[]>(job.scenes?.cenas ?? []);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(0);
  const [rendering, setRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState<RenderProgress | null>(null);
  const [renderFormatLabel, setRenderFormatLabel] = useState<string>("");
  const [renderPhase, setRenderPhase] = useState<RenderPhase>("bundling");
  const [renderLastSeenAt, setRenderLastSeenAt] = useState<number>(0);
  const [outputs, setOutputs] = useState<Record<string, string> | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [formatosRender, setFormatosRender] = useState<string[]>(["reels"]);
  const [showRenderModal, setShowRenderModal] = useState(false);
  const previousOutput = job.outputPath;

  const [refining, setRefining] = useState(false);
  const [refineError, setRefineError] = useState<string | null>(null);
  const [refineToast, setRefineToast] = useState<string | null>(null);
  const [showRefineModal, setShowRefineModal] = useState(false);
  const [refineBrief, setRefineBrief] = useState("");

  type MusicaItem = { filename: string; label: string; path: string };
  const [musicas, setMusicas] = useState<MusicaItem[]>([]);
  const [musicaFundo, setMusicaFundo] = useState<{ path: string; volume: number } | null>(
    job.scenes?.musica_fundo
      ? { path: job.scenes.musica_fundo.path, volume: (job.scenes.musica_fundo.volume ?? 3) * 10 }
      : null
  );
  const [videoStartSegundos, setVideoStartSegundos] = useState<number>(
    (job.scenes as Record<string, unknown>)?.video_start_segundos as number ?? 0
  );
  const videoDuration = job.videoDuration ?? null;
  const [videoEndSegundos, setVideoEndSegundos] = useState<number>(() => {
    const stored = (job.scenes as Record<string, unknown>)?.video_end_segundos;
    if (typeof stored === "number" && stored > 0) return stored;
    return videoDuration ?? 0;
  });

  useEffect(() => {
    fetch("/api/musicas").then((r) => r.json()).then(setMusicas).catch(() => {});
  }, []);

  const totalSec = scenes.reduce((acc, c) => acc + c.duracao_segundos, 0);

  // ── Inserir cena ────────────────────────────────────────────────────────────
  // Insere uma FraseImpacto logo depois da cena selecionada. Comportamento:
  // - Bloqueado se ja chegou no max do schema (15 cenas)
  // - Bloqueado se a cena selecionada e o CTA (CTA deve ser sempre a ultima)
  // - Se nenhuma cena estiver selecionada, insere no final antes do CTA
  // O usuario pode trocar o tipo via o seletor de tipo, mover com setas e editar texto.
  const MAX_CENAS = 15;
  const podeAdicionarCena = scenes.length < MAX_CENAS && (
    selectedIdx === null
      ? true
      : scenes[selectedIdx]?.tipo !== "CTA"
  );

  function addSceneAfterSelected() {
    if (!podeAdicionarCena) return;
    // Posicao de insercao: depois da selecionada, ou antes do CTA se nenhuma selecionada
    const insertAt = selectedIdx !== null
      ? selectedIdx + 1
      : Math.max(1, scenes.length - 1); // antes do CTA (ultima cena)

    const novaCena = {
      tipo: "FraseImpacto",
      texto: "Novo texto",
      palavras_destacadas: [],
      alinhamento: "centro",
      duracao_segundos: 3,
      fundo: "navy",
      sfx: { path: "sfx/transition.mp3", volume: 2 },
    } as unknown as Cena;

    const next = [...scenes];
    next.splice(insertAt, 0, novaCena);
    setScenes(next);
    setSelectedIdx(insertAt);
  }

  // Duracao real do player = trecho ativo do video bruto (fim - inicio).
  // NAO e a soma dos overlays.
  const duracaoPlayer = videoEndSegundos > videoStartSegundos
    ? videoEndSegundos - videoStartSegundos
    : totalSec;

  const initialFrame = useMemo(() => {
    if (selectedIdx === null) return 0;
    const cenaSelecionada = scenes[selectedIdx] as Record<string, unknown>;
    if (typeof cenaSelecionada?.["inicio_overlay_segundos"] === "number") {
      return Math.round((cenaSelecionada["inicio_overlay_segundos"] as number) * FPS);
    }
    let acc = 0;
    for (let i = 0; i < selectedIdx; i++) {
      acc += (scenes[i]?.duracao_segundos ?? 0);
    }
    return Math.round(acc * FPS);
  }, [selectedIdx, scenes]);

  const reelProps: ReelProps = useMemo(() => {
    const videoUrl = `/api/jobs/${job.id}/video`;
    const cenasComUrl = scenes.map((c) => {
      const cc = c as Record<string, unknown>;
      const updates: Record<string, unknown> = {};
      if ("video_path" in cc) updates.video_path = videoUrl;
      return Object.keys(updates).length ? { ...c, ...updates } : c;
    });
    return {
      duracao_total_estimada: duracaoPlayer,
      video_original_path: videoUrl,
      video_start_segundos: videoStartSegundos,
      video_end_segundos: videoEndSegundos > videoStartSegundos && videoEndSegundos > 0 ? videoEndSegundos : undefined,
      cenas: cenasComUrl as typeof scenes,
      cor_primaria: job.scenes?.cor_primaria,
      cor_secundaria: job.scenes?.cor_secundaria,
      fonte_url: job.scenes?.fonte_url,
      fonte_familia: job.scenes?.fonte_familia,
      musica_fundo: musicaFundo
        ? { path: musicaFundo.path, volume: parseFloat((musicaFundo.volume / 10).toFixed(2)) }
        : undefined,
    } as ReelProps;
  }, [scenes, duracaoPlayer, job.id, musicaFundo, videoStartSegundos, videoEndSegundos]);

  async function handleRender() {
    setRendering(true);
    setRenderProgress(null);
    setRenderError(null);

    try {
      // Duracao total = janela de trim (fim - inicio). NUNCA soma dos overlays.
      const duracaoTrim = videoEndSegundos > videoStartSegundos
        ? parseFloat((videoEndSegundos - videoStartSegundos).toFixed(2))
        : parseFloat(scenes.reduce((acc, s) => acc + s.duracao_segundos, 0).toFixed(2));
      const saveRes = await fetch(`/api/jobs/${job.id}/scenes`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...job.scenes,
          cenas: scenes,
          duracao_total_estimada: duracaoTrim,
          video_start_segundos: videoStartSegundos,
          video_end_segundos: videoEndSegundos > videoStartSegundos && videoEndSegundos > 0 ? videoEndSegundos : undefined,
          musica_fundo: musicaFundo
            ? { path: musicaFundo.path, volume: parseFloat((musicaFundo.volume / 10).toFixed(2)) }
            : undefined,
        }),
      });
      if (!saveRes.ok) {
        let errMsg = `Erro ao salvar cenas (${saveRes.status})`;
        try { const e = await saveRes.json(); errMsg = e.error ?? errMsg; } catch { /* noop */ }
        throw new Error(errMsg);
      }

      const res = await fetch(`/api/jobs/${job.id}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ formatos: formatosRender }),
      });
      if (!res.ok || !res.body) {
        let errMsg = `Erro na renderizacao (${res.status})`;
        try { const d = await res.json(); errMsg = d.error ?? errMsg; } catch { /* noop */ }
        throw new Error(errMsg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const event of events) {
          const line = event.replace(/^data:\s*/m, "").trim();
          if (!line) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue; // linha incompleta, aguarda o resto do chunk
          }
          if (msg.type === "format_start") {
            setRenderFormatLabel(msg.label);
            setRenderPhase("bundling");
            setRenderProgress(null);
            setRenderLastSeenAt(Date.now());
          } else if (msg.type === "phase") {
            setRenderPhase(msg.phase as RenderPhase);
            setRenderLastSeenAt(Date.now());
            // Ao entrar em encoding, zera o progresso de frames pra UI nao mostrar
            // "1800/1800 frames" travado enquanto FFmpeg roda. Se vier Encoded X/Y,
            // o proximo evento de progress vai atualizar.
            if (msg.phase === "encoding") {
              setRenderProgress((prev) => prev ? { ...prev, frames: 0, total: 0, eta: "", phase: "encoding" } : null);
            }
          } else if (msg.type === "progress") {
            setRenderProgress({ frames: msg.frames, total: msg.total, eta: msg.eta, phase: msg.phase as RenderPhase | undefined });
            if (msg.phase) setRenderPhase(msg.phase as RenderPhase);
            setRenderLastSeenAt(Date.now());
          } else if (msg.type === "heartbeat") {
            if (msg.phase) setRenderPhase(msg.phase as RenderPhase);
            setRenderLastSeenAt(Date.now());
          } else if (msg.type === "format_done") {
            setRenderProgress(null);
            setRenderPhase("bundling");
          } else if (msg.type === "done") {
            setOutputs(msg.outputs ?? { reels: msg.outputPath });
            setRendering(false);
            return;
          } else if (msg.type === "error") {
            throw new Error(msg.message);
          }
        }
      }
    } catch (err) {
      setRenderError(err instanceof Error ? err.message : String(err));
      setRendering(false);
    }
  }

  async function handleRefine(brief?: string) {
    setShowRefineModal(false);
    setRefining(true);
    setRefineError(null);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3 * 60 * 1000);
      let res: Response;
      try {
        res = await fetch(`/api/jobs/${job.id}/refine`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brief: brief ?? "" }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!res.ok) {
        let errMsg = `Erro no refinamento (${res.status})`;
        try {
          const data = await res.json();
          errMsg = data.error ?? errMsg;
          if (data.detalhe) errMsg += `\n${data.detalhe}`;
        } catch { /* noop */ }
        throw new Error(errMsg);
      }
      const data = await res.json();
      const novasCenas: Cena[] = data.scenes.cenas;
      setScenes(novasCenas);
      setSelectedIdx(0);
      setRefineToast(`Sequencia refinada ? ${novasCenas.length} cenas`);
      setTimeout(() => setRefineToast(null), 4000);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setRefineError("Tempo limite excedido (3 min). Tente novamente.");
      } else {
        setRefineError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setRefining(false);
    }
  }

  if (rendering) return <RenderingScreen progress={renderProgress} formatLabel={renderFormatLabel} phase={renderPhase} lastSeenAt={renderLastSeenAt} />;
  if (refining) return <RefiningScreen />;
  if (outputs) return <SuccessScreen jobId={job.id} outputs={outputs} onNew={onNew} />;

  const selected = selectedIdx !== null ? scenes[selectedIdx] : null;

  return (
    <main className={styles.root}>

      <AppNav breadcrumb={job.fileName}>
        <div className={styles.topbarMeta}>{scenes.length} cenas &middot; {Math.round(totalSec)}s</div>
        <button onClick={onNew} className={styles.btnGhost}>Novo</button>
        {previousOutput && (
          <a href={`/api/jobs/${job.id}/download`} download="reel.mp4" className={styles.btnGhost}>
            &#8595; Baixar
          </a>
        )}
        <ActionButton onClick={() => { setRefineBrief(""); setShowRefineModal(true); }} icon={"✦"}>Refinar com IA</ActionButton>
        <ActionButton onClick={() => setShowRenderModal(true)} icon={"▶"}>Renderizar</ActionButton>
      </AppNav>

      {renderError && <div className={styles.errorBanner}>&#9888; {renderError}</div>}
      {refineError && <div className={styles.errorBanner}>&#9888; {refineError}</div>}
      {refineToast && <div className={styles.refineToast}>{refineToast}</div>}

      {showRenderModal && (
        <div className={styles.refineModalOverlay} onClick={() => setShowRenderModal(false)}>
          <div className={styles.refineModal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.refineModalTitle}>&#9654; Renderizar</div>
            <p className={styles.refineModalDesc}>
              Selecione os formatos que deseja exportar. Cada formato e renderizado em sequencia.
            </p>
            <div className={styles.formatGroup}>
              {([
                { key: "reels",  label: "9:16", desc: "Stories / Reels" },
                { key: "wide",   label: "16:9", desc: "YouTube / Wide" },
                { key: "square", label: "1:1",  desc: "Feed quadrado" },
              ] as const).map(({ key, label, desc }) => {
                const active = formatosRender.includes(key);
                return (
                  <button
                    key={key}
                    type="button"
                    className={`${styles.formatChip} ${active ? styles.formatChipActive : ""}`}
                    onClick={() => {
                      if (active) {
                        const next = formatosRender.filter((f) => f !== key);
                        if (next.length > 0) setFormatosRender(next);
                      } else {
                        setFormatosRender((prev) => [...prev, key]);
                      }
                    }}
                  >
                    <span className={styles.formatChipDot} />
                    <span>
                      <span style={{ fontWeight: 700 }}>{label}</span>
                      <span style={{ fontWeight: 400, color: "var(--ink-3)", marginLeft: 6 }}>{desc}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            <div className={styles.refineModalActions}>
              <button className={styles.refineModalCancel} onClick={() => setShowRenderModal(false)}>
                Cancelar
              </button>
              <ActionButton onClick={() => { setShowRenderModal(false); handleRender(); }} icon={"▶"}>
                Renderizar
              </ActionButton>
            </div>
          </div>
        </div>
      )}

      {showRefineModal && (
        <div className={styles.refineModalOverlay} onClick={() => setShowRefineModal(false)}>
          <div className={styles.refineModal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.refineModalTitle}>&#10022; Refinar com IA</div>
            <p className={styles.refineModalDesc}>
              Descreva o que precisa ser corrigido ou melhorado. O agente vai priorizar suas orientacoes.
            </p>
            <textarea
              className={styles.refineModalTextarea}
              placeholder="Ex: A FraseImpacto entrou cedo demais. O ConviteEvento ficou longo, divide com um VideoSimples."
              value={refineBrief}
              onChange={(e) => setRefineBrief(e.target.value)}
              rows={5}
              autoFocus
            />
            <div className={styles.refineModalActions}>
              <button className={styles.refineModalCancel} onClick={() => setShowRefineModal(false)}>
                Cancelar
              </button>
              <ActionButton onClick={() => handleRefine(refineBrief)} icon={"✦"}>
                Refinar
              </ActionButton>
            </div>
          </div>
        </div>
      )}

      <VideoTrimBar
        duration={videoDuration}
        start={videoStartSegundos}
        end={videoEndSegundos}
        onStartChange={setVideoStartSegundos}
        onEndChange={setVideoEndSegundos}
      />

      {musicas.length > 0 && (
        <div className={styles.musicaBar}>
          <span className={styles.musicaLabel}>&#9834; Musica de fundo</span>
          <select
            className={styles.musicaSelect}
            value={musicaFundo?.path ?? ""}
            onChange={(e) => {
              const path = e.target.value;
              if (!path) { setMusicaFundo(null); return; }
              setMusicaFundo({ path, volume: musicaFundo?.volume ?? 20 });
            }}
          >
            <option value="">Nenhuma</option>
            {musicas.map((m) => (
              <option key={m.path} value={m.path}>{m.label}</option>
            ))}
          </select>
          {musicaFundo && (
            <div className={styles.musicaVolume}>
              <span className={styles.musicaVolLabel}>Volume</span>
              <input
                type="range" min={0} max={100} step={1}
                value={musicaFundo.volume}
                onChange={(e) => setMusicaFundo({ ...musicaFundo, volume: Number(e.target.value) })}
                className={styles.musicaSlider}
              />
              <div className={styles.musicaVolNum}>
                <input
                  type="number" min={0} max={100} step={1}
                  value={musicaFundo.volume}
                  onChange={(e) => {
                    const v = Math.min(100, Math.max(0, Number(e.target.value) || 0));
                    setMusicaFundo({ ...musicaFundo, volume: v });
                  }}
                  className={styles.musicaVolInput}
                />
                <span className={styles.musicaVolPct}>%</span>
              </div>
            </div>
          )}
        </div>
      )}

      <div className={styles.body}>

        <div className={styles.sidebar}>
          <div className={styles.sidebarHeader} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span>Sequencia &middot; {Math.round(totalSec)}s</span>
            <button
              onClick={addSceneAfterSelected}
              disabled={!podeAdicionarCena}
              title={
                scenes.length >= MAX_CENAS
                  ? `Limite de ${MAX_CENAS} cenas atingido`
                  : selectedIdx !== null && scenes[selectedIdx]?.tipo === "CTA"
                  ? "Nao e possivel inserir cena depois do CTA"
                  : selectedIdx !== null
                  ? `Adicionar cena depois da #${String(selectedIdx + 1).padStart(2, "0")}`
                  : "Adicionar cena antes do CTA"
              }
              style={{
                background: podeAdicionarCena ? "var(--accent)" : "var(--b-mid)",
                border: "none",
                borderRadius: 6,
                color: "#fff",
                cursor: podeAdicionarCena ? "pointer" : "not-allowed",
                opacity: podeAdicionarCena ? 1 : 0.5,
                padding: "4px 10px",
                fontSize: 12,
                fontWeight: 600,
                lineHeight: 1.2,
              }}
            >
              + Cena
            </button>
          </div>
          {scenes.map((cena, i) => {
            const cor = TIPO_COLORS[cena.tipo] ?? "var(--c-transicao)";
            const label = TIPO_LABELS[cena.tipo] ?? cena.tipo;
            const active = selectedIdx === i;
            const pct = totalSec > 0 ? (cena.duracao_segundos / totalSec) * 100 : 0;
            return (
              <div
                key={i}
                className={`${styles.sceneItem} ${active ? styles.active : ""}`}
                onClick={() => setSelectedIdx(i)}
              >
                <div className={styles.sceneAccent} style={{ background: active ? cor : "transparent" }} />
                <div className={styles.sceneContent}>
                  <div className={styles.sceneRow}>
                    <div className={styles.sceneDot} style={{ background: cor }} />
                    <span className={styles.sceneLabel}>{label}</span>
                    <span className={styles.sceneSpacer} />
                    <span className={styles.sceneDuration}>{cena.duracao_segundos}s</span>
                    <span className={styles.sceneIndex}>#{String(i + 1).padStart(2, "0")}</span>
                  </div>
                  <div className={styles.sceneBar}>
                    <div className={styles.sceneBarFill} style={{ width: `${pct}%`, background: cor }} />
                  </div>
                  {getPreview(cena) && <div className={styles.scenePreview}>{getPreview(cena)}</div>}
                </div>
              </div>
            );
          })}
        </div>

        <div className={styles.playerCol}>
          <div className={styles.playerWrap}>
            <ReelPlayer props={reelProps} initialFrame={initialFrame} />
          </div>
          <div className={styles.playerHint}>
            Clique numa cena para pular &middot; Edite a direita e o preview atualiza
          </div>
        </div>

        <div className={styles.detailCol}>
          {selected ? (
            <SceneDetail
              cena={selected}
              index={selectedIdx!}
              startAcumulado={scenes.slice(0, selectedIdx!).reduce((acc, s) => acc + s.duracao_segundos, 0)}
              especialistaSlug={job.especialista_slug}
              corPrimariaEspecialista={job.scenes?.cor_primaria}
              corSecundariaEspecialista={job.scenes?.cor_secundaria}
              videoOriginalPath={`/api/jobs/${job.id}/video`}
              onChange={(updated) => {
                const next = [...scenes];
                const upd = updated as Record<string, unknown>;

                const inicioEditada: number =
                  typeof upd["inicio_overlay_segundos"] === "number"
                    ? (upd["inicio_overlay_segundos"] as number)
                    : next.slice(0, selectedIdx!).reduce((acc, s) => acc + s.duracao_segundos, 0);

                const proxIdx = selectedIdx! + 1;
                if (proxIdx < next.length) {
                  const proxCena = next[proxIdx] as Record<string, unknown>;
                  const inicioProxima: number =
                    typeof proxCena["inicio_overlay_segundos"] === "number"
                      ? (proxCena["inicio_overlay_segundos"] as number)
                      : next.slice(0, proxIdx).reduce((acc, s, i) =>
                          acc + (i === selectedIdx! ? updated.duracao_segundos : s.duracao_segundos), 0);

                  const espacoDisponivel = inicioProxima - inicioEditada;
                  if (espacoDisponivel > 0 && updated.duracao_segundos > espacoDisponivel) {
                    updated = { ...updated, duracao_segundos: parseFloat(espacoDisponivel.toFixed(2)) };
                  }
                }

                next[selectedIdx!] = updated;
                setScenes(next);
              }}
              onDelete={() => {
                const next = scenes.filter((_, i) => i !== selectedIdx);
                setScenes(next);
                setSelectedIdx(Math.min(selectedIdx!, next.length - 1));
              }}
              onMoveUp={() => {
                if (selectedIdx! <= 0) return;
                const next = [...scenes];
                [next[selectedIdx! - 1], next[selectedIdx!]] = [next[selectedIdx!], next[selectedIdx! - 1]];
                setScenes(next);
                setSelectedIdx(selectedIdx! - 1);
              }}
              onMoveDown={() => {
                if (selectedIdx! >= scenes.length - 1) return;
                const next = [...scenes];
                [next[selectedIdx!], next[selectedIdx! + 1]] = [next[selectedIdx! + 1], next[selectedIdx!]];
                setScenes(next);
                setSelectedIdx(selectedIdx! + 1);
              }}
            />
          ) : (
            <div className={styles.detailEmpty}>Selecione uma cena para editar</div>
          )}
        </div>

      </div>
    </main>
  );
}

// ?? VideoTrimBar ??????????????????????????????????????????????????????????????

function VideoTrimBar({
  duration,
  start,
  end,
  onStartChange,
  onEndChange,
}: {
  duration: number | null;
  start: number;
  end: number;
  onStartChange: (v: number) => void;
  onEndChange: (v: number) => void;
}) {
  const total = duration ?? Math.max(end, start + 1, 60);
  const effectiveEnd = end > 0 ? end : total;
  const startPct = Math.min(100, (start / total) * 100);
  const endPct = Math.min(100, (effectiveEnd / total) * 100);
  const activePct = Math.max(0, endPct - startPct);
  const displayEnd = end > 0 ? end : total;

  function fmt(s: number) {
    const m = Math.floor(s / 60);
    const sec = (s % 60).toFixed(1).padStart(4, "0");
    return m > 0 ? `${m}:${sec}` : `${sec}s`;
  }

  return (
    <div className={styles.trimBar}>
      <span className={styles.trimLabel}>&#9986; Video bruto</span>
      {duration != null && (
        <span className={styles.trimDuration}>{fmt(duration)}</span>
      )}
      <div className={styles.trimTrackWrap}>
        <div className={styles.trimTrack}>
          <div
            className={styles.trimActive}
            style={{ left: `${startPct}%`, width: `${activePct}%` }}
          />
          <input
            type="range"
            className={`${styles.trimThumb} ${styles.trimThumbStart}`}
            min={0}
            max={total}
            step={0.1}
            value={start}
            onChange={(e) => {
              const v = Math.min(Number(e.target.value), end - 0.5);
              onStartChange(parseFloat(v.toFixed(1)));
            }}
          />
          <input
            type="range"
            className={`${styles.trimThumb} ${styles.trimThumbEnd}`}
            min={0}
            max={total}
            step={0.1}
            value={effectiveEnd}
            onChange={(e) => {
              const v = Math.max(Number(e.target.value), start + 0.5);
              onEndChange(parseFloat(v.toFixed(1)));
            }}
          />
        </div>
        <div className={styles.trimLabels}>
          <span>{fmt(start)}</span>
          <span className={styles.trimActiveLabel}>{fmt(effectiveEnd - start)} ativo</span>
          <span>{fmt(effectiveEnd)}</span>
        </div>
      </div>
      <div className={styles.trimInputs}>
        <div className={styles.trimInputGroup}>
          <span className={styles.trimInputLabel}>Inicio</span>
          <input
            type="number"
            className={styles.trimInput}
            step={0.1}
            min={0}
            max={end - 0.1}
            value={start}
            onChange={(e) => {
              const v = Math.min(Math.max(0, Number(e.target.value)), end - 0.5);
              onStartChange(parseFloat(v.toFixed(1)));
            }}
          />
        </div>
        <div className={styles.trimInputGroup}>
          <span className={styles.trimInputLabel}>Fim</span>
          <input
            type="number"
            className={styles.trimInput}
            step={0.1}
            min={start + 0.1}
            max={total}
            value={effectiveEnd}
            onChange={(e) => {
              const v = Math.max(Math.min(total, Number(e.target.value)), start + 0.5);
              onEndChange(parseFloat(v.toFixed(1)));
            }}
          />
        </div>
      </div>
    </div>
  );
}

// ?? RenderingScreen ???????????????????????????????????????????????????????????

const PHASE_DESC: Record<RenderPhase, { titulo: string; descricao: string; mostraBarra: boolean }> = {
  bundling:  { titulo: "Preparando componentes",     descricao: "Compilando React e carregando assets.",   mostraBarra: false },
  rendering: { titulo: "Renderizando frames",         descricao: "Cada frame e gerado pelo Chromium.",       mostraBarra: true  },
  encoding:  { titulo: "Combinando em MP4",           descricao: "O FFmpeg esta juntando audio e video. Pode levar de 10s a 1min.", mostraBarra: true  },
};

function RenderingScreen({
  progress,
  formatLabel,
  phase,
  lastSeenAt,
}: {
  progress: RenderProgress | null;
  formatLabel?: string;
  phase: RenderPhase;
  lastSeenAt: number;
}) {
  const [now, setNow] = useState(Date.now());

  // Tick a cada 500ms para detectar quando o servidor para de enviar eventos
  // (heartbeat ou progress). Se passar mais que 8s, mostra aviso de stall.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const phaseInfo = PHASE_DESC[phase];
  const temProgresso = progress && progress.total > 0 && phaseInfo.mostraBarra;
  const pct = temProgresso ? Math.round((progress!.frames / progress!.total) * 100) : 0;
  const segundosDesdeUltimoEvento = lastSeenAt > 0 ? Math.floor((now - lastSeenAt) / 1000) : 0;
  const stallSuspeito = lastSeenAt > 0 && segundosDesdeUltimoEvento > 8;

  return (
    <main className={styles.renderScreen}>
      <div className={styles.renderCard}>
        <div className={styles.renderHeading}>
          <h2 className={styles.renderTitle}>Renderizando</h2>
          <p className={styles.renderSubtitle}>
            {formatLabel ? `Formato ${formatLabel} — ` : ""}{phaseInfo.descricao}
          </p>
        </div>

        {/* Indicador de fases */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16, justifyContent: "center" }}>
          {(["bundling", "rendering", "encoding"] as RenderPhase[]).map((p) => {
            const order = { bundling: 0, rendering: 1, encoding: 2 };
            const atual = order[phase];
            const este = order[p];
            const estado = este < atual ? "feito" : este === atual ? "ativo" : "pendente";
            return (
              <div
                key={p}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 10px",
                  borderRadius: 999,
                  background: estado === "ativo" ? "var(--accent)" : estado === "feito" ? "rgba(34, 197, 94, 0.15)" : "var(--b-mid)",
                  color: estado === "ativo" ? "#fff" : estado === "feito" ? "#22c55e" : "var(--text-muted)",
                  fontSize: 11,
                  fontWeight: 600,
                  opacity: estado === "pendente" ? 0.5 : 1,
                  transition: "all 0.2s",
                }}
              >
                <span>{estado === "feito" ? "✓" : este + 1}</span>
                <span>{PHASE_DESC[p].titulo}</span>
              </div>
            );
          })}
        </div>

        <div className={styles.renderBox}>
          {temProgresso ? (
            <>
              <div className={styles.renderFrameRow}>
                <div>
                  <span className={styles.renderFrames}>{progress!.frames}</span>
                  <span className={styles.renderTotal}> / {progress!.total} frames</span>
                </div>
                {progress!.eta && <span className={styles.renderEta}>{progress!.eta} restante</span>}
              </div>
              <div className={styles.renderProgressTrack}>
                <div className={styles.renderProgressBar} style={{ width: `${pct}%` }} />
              </div>
              <div className={styles.renderProgressPct}>{pct}%</div>
            </>
          ) : (
            <div className={styles.renderWaiting}>
              <div className={styles.renderPulseDot} />
              {phaseInfo.titulo}...
            </div>
          )}
        </div>

        {/* Sinal de "ainda vivo" para o usuario nao achar que travou */}
        {lastSeenAt > 0 && (
          <div style={{
            marginTop: 12,
            fontSize: 11,
            color: stallSuspeito ? "#E63946" : "var(--text-muted)",
            textAlign: "center",
          }}>
            {stallSuspeito
              ? `Sem resposta do servidor ha ${segundosDesdeUltimoEvento}s — pode ter travado.`
              : segundosDesdeUltimoEvento === 0
              ? "Recebendo dados do servidor"
              : `Ultimo sinal ha ${segundosDesdeUltimoEvento}s`}
          </div>
        )}
      </div>
    </main>
  );
}

// ?? RefiningScreen ????????????????????????????????????????????????????????????

function RefiningScreen() {
  return (
    <main className={styles.renderScreen}>
      <div className={styles.renderCard}>
        <div className={styles.renderHeading}>
          <h2 className={styles.renderTitle}>Refinando com IA</h2>
          <p className={styles.renderSubtitle}>
            O Claude esta analisando a transcricao e as cenas atuais para gerar uma versao melhorada.
          </p>
        </div>
        <div className={styles.renderBox}>
          <div className={styles.renderWaiting}>
            <div className={styles.renderPulseDot} />
            Processando...
          </div>
        </div>
      </div>
    </main>
  );
}

// ?? SuccessScreen ?????????????????????????????????????????????????????????????

const FORMAT_LABELS: Record<string, string> = {
  reels:  "9:16 Reels",
  wide:   "16:9 Wide",
  square: "1:1 Square",
};

function SuccessScreen({ jobId, outputs, onNew }: { jobId: string; outputs: Record<string, string>; onNew: () => void }) {
  const [cleanup, setCleanup] = useState(true);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const formatKeys = Object.keys(outputs);

  /**
   * Baixa um arquivo via fetch+blob, garantindo que TODOS os bytes
   * sao transferidos antes da Promise resolver. Necessario porque
   * o pattern <a href> + click() apenas dispara o download — nao da
   * pra saber quando ele termina, e isso quebra qualquer cleanup
   * que rode em sequencia.
   */
  async function baixarArquivo(url: string, filename: string): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Falha ao baixar ${filename}: HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } finally {
      // Libera a memoria do blob depois de um tempo curto. O browser
      // ja salvou o arquivo no disco quando o click() rodou.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
    }
  }

  async function runCleanup() {
    if (!cleanup) return;
    const res = await fetch(`/api/jobs/${jobId}/cleanup`, { method: "DELETE" });
    if (!res.ok) {
      console.warn(`[cleanup] DELETE retornou ${res.status} — arquivos podem ter ficado em disco.`);
    }
  }

  async function handleDownload(formatKey: string, filename: string) {
    setDownloading(formatKey);
    setDownloadError(null);
    try {
      await baixarArquivo(`/api/jobs/${jobId}/download?format=${formatKey}`, filename);
      await runCleanup();
      if (cleanup) onNew();
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(null);
    }
  }

  async function handleDownloadAll() {
    setDownloading("all");
    setDownloadError(null);
    try {
      for (const key of formatKeys) {
        setDownloading(key);
        await baixarArquivo(
          `/api/jobs/${jobId}/download?format=${key}`,
          `reel_${key}.mp4`,
        );
      }
      // Todos os arquivos foram realmente recebidos pelo browser.
      // So agora e seguro apagar o diretorio do job no servidor.
      await runCleanup();
      onNew();
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(null);
    }
  }

  return (
    <main className={styles.successScreen}>
      <div className={styles.successCard}>
        <div className={styles.successIcon}>&#10003;</div>
        <h2 className={styles.successTitle}>
          {formatKeys.length === 1 ? "Reel gerado" : `${formatKeys.length} formatos gerados`}
        </h2>
        <p className={styles.successSubtitle}>O video foi renderizado com sucesso.</p>

        <div className={styles.successFiles}>
          {formatKeys.map((key) => (
            <div key={key} className={styles.successFileRow}>
              <div className={styles.successFileInfo}>
                <span className={styles.successFileLabel}>{FORMAT_LABELS[key] ?? key}</span>
                <code className={styles.successPath}>{outputs[key]}</code>
              </div>
              <button
                className={styles.successDownloadBtn}
                disabled={downloading === key}
                onClick={() => handleDownload(key, `reel_${key}.mp4`)}
              >
                {downloading === key ? "..." : "↓"}
              </button>
            </div>
          ))}
        </div>

        {downloadError && (
          <div style={{
            margin: "12px 0",
            padding: "10px 14px",
            background: "rgba(230, 57, 70, 0.12)",
            border: "1px solid rgba(230, 57, 70, 0.45)",
            borderRadius: 8,
            color: "#E63946",
            fontSize: 13,
            lineHeight: 1.4,
          }}>
            {downloadError}
          </div>
        )}
        <label className={styles.cleanupRow}>
          <input type="checkbox" checked={cleanup} onChange={(e) => setCleanup(e.target.checked)} disabled={!!downloading} />
          <div className={styles.cleanupLabel}>
            Limpar arquivos temporarios apos baixar
            <span>Remove video original, transcricao e JSONs. So executa depois que TODOS os downloads terminam.</span>
          </div>
        </label>
        <div className={styles.successActions}>
          <ActionButton onClick={handleDownloadAll} disabled={!!downloading} icon={"↓"}>
            {downloading
              ? (downloading === "all"
                  ? "Baixando..."
                  : `Baixando ${FORMAT_LABELS[downloading] ?? downloading}...`)
              : formatKeys.length > 1
              ? "Baixar todos"
              : "Baixar video"}
          </ActionButton>
          <button onClick={async () => { await runCleanup(); onNew(); }} className={styles.btnSecondary}>Novo video</button>
        </div>
      </div>
    </main>
  );
}

// ?? SceneDetail ???????????????????????????????????????????????????????????????

function SceneDetail({
  cena, index, startAcumulado, especialistaSlug, corPrimariaEspecialista, corSecundariaEspecialista, videoOriginalPath, onChange, onDelete, onMoveUp, onMoveDown,
}: {
  cena: Cena;
  index: number;
  startAcumulado: number;
  especialistaSlug?: string;
  corPrimariaEspecialista?: string;
  corSecundariaEspecialista?: string;
  videoOriginalPath?: string;
  onChange: (c: Cena) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const c = cena as Record<string, unknown>;
  const cor = TIPO_COLORS[cena.tipo] ?? "var(--c-transicao)";
  const label = TIPO_LABELS[cena.tipo] ?? cena.tipo;
  const [logos, setLogos] = useState<{ filename: string; url: string }[]>([]);

  useEffect(() => {
    if (cena.tipo === "ConviteEvento" && especialistaSlug) {
      fetch(`/api/especialistas/${especialistaSlug}/logos`)
        .then((r) => r.ok ? r.json() : [])
        .then(setLogos)
        .catch(() => setLogos([]));
    }
  }, [cena.tipo, especialistaSlug]);

  function textField(key: string, multiline = false) {
    if (!(key in c) || c[key] === undefined) return null;
    return (
      <div key={key} className={styles.field}>
        <label className={styles.fieldLabel}>{key}</label>
        {multiline ? (
          <textarea className={styles.input} value={String(c[key])} rows={3}
            onChange={(e) => onChange({ ...cena, [key]: e.target.value } as Cena)} />
        ) : (
          <input className={styles.input} type="text" value={String(c[key])}
            onChange={(e) => onChange({ ...cena, [key]: e.target.value } as Cena)} />
        )}
      </div>
    );
  }

  function numberField(key: string, lbl?: string, step = 0.5) {
    if (!(key in c)) return null;
    return (
      <div key={key} className={styles.field}>
        <label className={styles.fieldLabel}>{lbl ?? key}</label>
        <input className={styles.input} type="number" step={step} value={Number(c[key])}
          onChange={(e) => onChange({ ...cena, [key]: Number(e.target.value) } as Cena)} />
      </div>
    );
  }

  function listField(key: string, lbl: string) {
    if (!(key in c)) return null;
    // IMPORTANTE: nao filtrar strings vazias no onChange. O textarea e controlado;
    // se filtrarmos enquanto o usuario digita, a tecla Enter "nao funciona" porque
    // o "\n" cria uma string vazia que sumiria, fazendo o cursor voltar pra mesma linha.
    // A limpeza acontece no onBlur (quando o usuario sai do campo).
    const itens = (c[key] as string[]) ?? [];
    return (
      <div key={key} className={styles.field}>
        <label className={styles.fieldLabel}>{lbl}</label>
        <textarea
          className={styles.input}
          rows={Math.max(4, itens.length + 1)}
          value={itens.join("\n")}
          onChange={(e) =>
            onChange({ ...cena, [key]: e.target.value.split("\n") } as Cena)
          }
          onBlur={(e) =>
            onChange({
              ...cena,
              [key]: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean),
            } as Cena)
          }
        />
        <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-muted)" }}>
          {itens.filter((s) => s.trim()).length} {itens.filter((s) => s.trim()).length === 1 ? "item" : "itens"}
        </div>
      </div>
    );
  }

  function migrarTipo(novoTipo: string) {
    if (novoTipo === cena.tipo) return;
    const dur = c["duracao_segundos"] ?? 8;
    const videoPath = c["video_path"] ?? videoOriginalPath ?? undefined;
    const startSeg = c["start_segundos"] ?? undefined;
    const base: Record<string, unknown> = { tipo: novoTipo, duracao_segundos: dur };

    if (c["inicio_overlay_segundos"] !== undefined) {
      base["inicio_overlay_segundos"] = c["inicio_overlay_segundos"];
    }

    const tiposComTitulo = ["Hook", "FraseImpacto", "ListaPontos", "GraficoBarra", "GraficoLinha", "ConviteEvento"];
    if (tiposComTitulo.includes(novoTipo) && c["titulo"]) base["titulo"] = c["titulo"];

    switch (novoTipo) {
      case "Hook":
        if (!base["sfx"]) base["sfx"] = { path: "sfx/whoosh.mp3", volume: 5 };
        base["titulo"] = base["titulo"] ?? "TITULO DO HOOK";
        base["palavras_destacadas"] = [];
        base["animacao_entrada"] = "spring";
        break;
      case "FraseImpacto":
        if (!base["sfx"]) base["sfx"] = { path: "sfx/transition.mp3", volume: 5 };
        base["texto"] = String(c["titulo"] ?? c["texto"] ?? "Frase de impacto aqui");
        base["palavras_destacadas"] = [];
        base["alinhamento"] = "centro";
        base["fundo"] = "navy";
        break;
      case "ComparativoNumerico":
        if (!base["sfx"]) base["sfx"] = { path: "sfx/ding.mp3", volume: 5 };
        base["metrica_nome"] = String(c["titulo"] ?? "Metrica");
        base["metrica_unidade"] = "";
        base["lados"] = [
          { valor: "A", rotulo: "Opcao A", eh_destaque: false },
          { valor: "B", rotulo: "Opcao B", eh_destaque: true },
        ];
        base["visualizacao"] = "numeros_grandes";
        break;
      case "GraficoBarra":
        if (!base["sfx"]) base["sfx"] = { path: "sfx/slide.mp3", volume: 5 };
        base["titulo"] = base["titulo"] ?? String(c["metrica_nome"] ?? "Comparativo");
        base["barras"] = [
          { rotulo: "A", valor: 1, valor_display: "1", eh_destaque: false },
          { rotulo: "B", valor: 1.5, valor_display: "1,5", eh_destaque: false },
          { rotulo: "C", valor: 2, valor_display: "2", eh_destaque: true },
        ];
        break;
      case "GraficoLinha":
        if (!base["sfx"]) base["sfx"] = { path: "sfx/slide.mp3", volume: 5 };
        base["titulo"] = base["titulo"] ?? "Evolucao";
        base["pontos"] = [
          { rotulo: "Jan", valor: 1 },
          { rotulo: "Fev", valor: 2 },
          { rotulo: "Mar", valor: 3 },
        ];
        base["unidade"] = "";
        break;
      case "VideoCitacao":
        if (!base["sfx"]) base["sfx"] = { path: "sfx/slide.mp3", volume: 5 };
        base["frases"] = Array.isArray(c["frases"]) ? c["frases"] : ["Frase do mentor aqui"];
        base["nome_mentor"] = c["nome_mentor"] ?? "";
        base["cargo_mentor"] = c["cargo_mentor"] ?? "";
        base["estilo_lower_third"] = "barra_inferior";
        break;
      case "ListaPontos":
        if (!base["sfx"]) base["sfx"] = { path: "sfx/pop.mp3", volume: 5 };
        base["pontos"] = Array.isArray(c["pontos"]) ? c["pontos"] : ["Ponto 1", "Ponto 2", "Ponto 3"];
        base["numerado"] = false;
        base["fundo"] = "navy";
        break;
      case "MiniCaso":
        if (!base["sfx"]) base["sfx"] = { path: "sfx/ding.mp3", volume: 5 };
        base["resultado_texto"] = String(c["titulo"] ?? "Resultado aqui");
        base["contexto_texto"] = "";
        base["palavras_destacadas"] = [];
        break;
      case "TransicaoTexto":
        if (!base["sfx"]) base["sfx"] = { path: "sfx/transition.mp3", volume: 5 };
        base["texto"] = String(c["titulo"] ?? c["texto"] ?? "Mas existe outro caminho");
        base["fundo"] = "navy";
        base["duracao_segundos"] = Math.min(Number(dur), 4);
        break;
      case "ConviteEvento":
        if (!base["sfx"]) base["sfx"] = { path: "sfx/slide.mp3", volume: 5 };
        base["nome_evento"] = String(c["titulo"] ?? "Nome do Evento");
        base["descricao"] = "";
        base["bullets"] = ["Beneficio 1", "Beneficio 2"];
        base["fundo"] = "navy";
        break;
      case "CTA":
        if (!base["sfx"]) base["sfx"] = { path: "sfx/transition.mp3", volume: 5 };
        base["texto_principal"] = String(c["texto_principal"] ?? c["titulo"] ?? "Comente aqui embaixo");
        base["texto_secundario"] = "";
        base["mostrar_seta"] = true;
        base["cor_seta"] = "secundaria";
        base["palavras_destacadas"] = [];
        break;
      case "VideoSimples":
        base["video_path"] = videoPath ?? videoOriginalPath ?? "";
        if (startSeg !== undefined) base["start_segundos"] = startSeg;
        else base["start_segundos"] = 0;
        base["duracao_segundos"] = Number(dur);
        break;
    }

    onChange(base as unknown as Cena);
  }

  return (
    <div className={styles.sceneDetail}>
      <div className={styles.sceneDetailHeader}>
        <div className={styles.sceneDetailDot} style={{ background: cor }} />
        <h2 className={styles.sceneDetailTitle}>{label}</h2>
        <span className={styles.sceneDetailIndex}>#{String(index + 1).padStart(2, "0")}</span>
        <div className={styles.sceneDetailActions}>
          <button className={styles.btnSceneAction} onClick={onMoveUp} title="Mover para cima">&#8593;</button>
          <button className={styles.btnSceneAction} onClick={onMoveDown} title="Mover para baixo">&#8595;</button>
          <button className={`${styles.btnSceneAction} ${styles.btnSceneDelete}`} onClick={onDelete} title="Excluir cena">&#10005;</button>
        </div>
      </div>

      <div className={styles.field} style={{ marginBottom: 0 }}>
        <label className={styles.fieldLabel}>Tipo de cena</label>
        <select
          className={styles.input}
          value={cena.tipo}
          style={{ appearance: "none", cursor: "pointer", borderLeft: `3px solid ${cor}` }}
          onChange={(e) => migrarTipo(e.target.value)}
        >
          {Object.entries(TIPO_LABELS).map(([tipo, tipoLabel]) => (
            <option key={tipo} value={tipo}>{tipoLabel}</option>
          ))}
        </select>
      </div>

      <div className={styles.timingGroup}>
        <div className={styles.field}>
          {"start_segundos" in c ? (
            <>
              <label className={styles.fieldLabel}>Inicio no video (s)</label>
              <input
                className={styles.input}
                type="number"
                step={0.1}
                min={0}
                value={Number(c["start_segundos"])}
                onChange={(e) => onChange({ ...cena, start_segundos: Number(e.target.value) } as Cena)}
              />
            </>
          ) : (
            <>
              <label className={styles.fieldLabel}>
                Inicio overlay (s)
                <span style={{ fontWeight: 400, color: "var(--ink-3)", marginLeft: 4 }}>
                  &middot; auto = {parseFloat(startAcumulado.toFixed(1))}s
                </span>
              </label>
              <input
                className={styles.input}
                type="number"
                step={0.1}
                min={0}
                value={typeof c["inicio_overlay_segundos"] === "number"
                  ? Number(c["inicio_overlay_segundos"])
                  : parseFloat(startAcumulado.toFixed(1))}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  const auto = parseFloat(startAcumulado.toFixed(1));
                  if (Math.abs(val - auto) < 0.05) {
                    const next = { ...cena } as Record<string, unknown>;
                    delete next["inicio_overlay_segundos"];
                    onChange(next as Cena);
                  } else {
                    onChange({ ...cena, inicio_overlay_segundos: val } as Cena);
                  }
                }}
                title="Sobrescreve o inicio automatico no preview."
              />
            </>
          )}
        </div>
        {numberField("duracao_segundos", "Duracao (s)", 0.5)}
      </div>

      {textField("titulo", true)}
      {textField("subtitulo")}
      {textField("nome_evento")}
      {cena.tipo === "ConviteEvento" ? (
        <div className={styles.field}>
          <label className={styles.fieldLabel}>Logo do evento</label>
          {logos.length > 0 ? (
            <div className={styles.logoSelectorGrid}>
              <div
                className={`${styles.logoSelectorItem} ${!c["logo_url"] ? styles.logoSelectorActive : ""}`}
                onClick={() => onChange({ ...cena, logo_url: undefined } as Cena)}
              >
                <span className={styles.logoSelectorNone}>Sem logo</span>
              </div>
              {logos.map((logo) => (
                <div
                  key={logo.filename}
                  className={`${styles.logoSelectorItem} ${c["logo_url"] === logo.url ? styles.logoSelectorActive : ""}`}
                  onClick={() => onChange({ ...cena, logo_url: logo.url } as Cena)}
                >
                  <img src={logo.url} alt={logo.filename} className={styles.logoSelectorThumb} />
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.inputHint}>
              Nenhuma logo cadastrada para este especialista.
              <a href="/especialistas" target="_blank" style={{ color: "var(--accent)", marginLeft: 4 }}>Cadastrar &#8594;</a>
            </div>
          )}
          <input className={styles.input} type="text" placeholder="Ou cole uma URL diretamente..."
            value={String(c["logo_url"] ?? "")} style={{ marginTop: 8 }}
            onChange={(e) => onChange({ ...cena, logo_url: e.target.value || undefined } as Cena)} />
        </div>
      ) : null}
      {cena.tipo === "ConviteEvento" && !!c["logo_url"] ? (
        <div className={styles.timingGroup}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Altura (px)</label>
            <input className={styles.input} type="number" min={24} max={1080} step={4}
              value={Number(c["logo_altura"] ?? 80)}
              onChange={(e) => onChange({ ...cena, logo_altura: Number(e.target.value) } as Cena)} />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Posicao</label>
            <select className={styles.input}
              value={String(c["logo_posicao"] ?? "topo")}
              onChange={(e) => onChange({ ...cena, logo_posicao: e.target.value as "topo" | "centro" | "rodape" } as Cena)}
              style={{ appearance: "none", cursor: "pointer" }}>
              <option value="topo">Topo</option>
              <option value="centro">Centro</option>
              <option value="rodape">Rodape</option>
            </select>
          </div>
        </div>
      ) : null}
      {textField("descricao")}
      {textField("texto", true)}
      {textField("texto_principal", true)}
      {textField("texto_secundario")}
      {textField("resultado_texto", true)}
      {textField("contexto_texto")}
      {textField("metrica_nome")}
      {textField("nome_mentor")}
      {textField("cargo_mentor")}

      {cena.tipo === "ComparativoNumerico" && Array.isArray((c as Record<string,unknown>)["lados"]) ? (
        <div className={styles.field}>
          <label className={styles.fieldLabel}>Lados</label>
          {((c as Record<string,unknown>)["lados"] as Array<Record<string,unknown>>).map((lado, i) => (
            <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
              <input className={styles.input} type="text" style={{ flex: 2 }}
                placeholder="Valor"
                value={String(lado["valor"] ?? "")}
                onChange={(e) => {
                  const lados = [...((c as Record<string,unknown>)["lados"] as Array<Record<string,unknown>>)];
                  lados[i] = { ...lados[i], valor: e.target.value };
                  onChange({ ...cena, lados } as Cena);
                }} />
              <input className={styles.input} type="text" style={{ flex: 2 }}
                placeholder="Rotulo"
                value={String(lado["rotulo"] ?? "")}
                onChange={(e) => {
                  const lados = [...((c as Record<string,unknown>)["lados"] as Array<Record<string,unknown>>)];
                  lados[i] = { ...lados[i], rotulo: e.target.value };
                  onChange({ ...cena, lados } as Cena);
                }} />
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                <input type="checkbox" checked={!!lado["eh_destaque"]}
                  onChange={(e) => {
                    const lados = [...((c as Record<string,unknown>)["lados"] as Array<Record<string,unknown>>)];
                    lados[i] = { ...lados[i], eh_destaque: e.target.checked };
                    onChange({ ...cena, lados } as Cena);
                  }} />
                destaque
              </label>
            </div>
          ))}
        </div>
      ) : null}

      {cena.tipo === "GraficoBarra" && Array.isArray((c as Record<string,unknown>)["barras"]) ? (
        <div className={styles.field}>
          <label className={styles.fieldLabel}>Barras</label>
          {((c as Record<string,unknown>)["barras"] as Array<Record<string,unknown>>).map((barra, i) => {
            const barras = (c as Record<string,unknown>)["barras"] as Array<Record<string,unknown>>;
            return (
              <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
                <input className={styles.input} type="text" style={{ flex: 2 }}
                  placeholder="Rotulo"
                  value={String(barra["rotulo"] ?? "")}
                  onChange={(e) => {
                    const next = [...barras];
                    next[i] = { ...next[i], rotulo: e.target.value };
                    onChange({ ...cena, barras: next } as Cena);
                  }} />
                <input className={styles.input} type="number" step={0.1} style={{ flex: 1 }}
                  placeholder="Valor"
                  value={Number(barra["valor"] ?? 0)}
                  onChange={(e) => {
                    const next = [...barras];
                    next[i] = { ...next[i], valor: Number(e.target.value) };
                    onChange({ ...cena, barras: next } as Cena);
                  }} />
                <input className={styles.input} type="text" style={{ flex: 1.5 }}
                  placeholder="Display"
                  value={String(barra["valor_display"] ?? "")}
                  onChange={(e) => {
                    const next = [...barras];
                    next[i] = { ...next[i], valor_display: e.target.value || undefined };
                    onChange({ ...cena, barras: next } as Cena);
                  }} />
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                  <input type="checkbox" checked={!!barra["eh_destaque"]}
                    onChange={(e) => {
                      const next = [...barras];
                      next[i] = { ...next[i], eh_destaque: e.target.checked };
                      onChange({ ...cena, barras: next } as Cena);
                    }} />
                  destaque
                </label>
                <button
                  style={{ flexShrink: 0, background: "none", border: "1px solid var(--b-mid)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", padding: "2px 7px", fontSize: 14, lineHeight: 1 }}
                  onClick={() => {
                    if (barras.length <= 2) return;
                    const next = barras.filter((_, j) => j !== i);
                    onChange({ ...cena, barras: next } as Cena);
                  }}
                >&#8722;</button>
              </div>
            );
          })}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 6 }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Valor numerico = altura &middot; Display = texto visivel</div>
            <button
              style={{ background: "var(--accent)", border: "none", borderRadius: 6, color: "#fff", cursor: "pointer", padding: "4px 12px", fontSize: 12, fontWeight: 600 }}
              onClick={() => {
                const barras = (c as Record<string,unknown>)["barras"] as Array<Record<string,unknown>>;
                if (barras.length >= 6) return;
                const next = [...barras, { rotulo: `Barra ${barras.length + 1}`, valor: 1, valor_display: "1", eh_destaque: false }];
                onChange({ ...cena, barras: next } as Cena);
              }}
            >+ Barra</button>
          </div>
        </div>
      ) : null}

      {cena.tipo === "GraficoLinha" && Array.isArray((c as Record<string,unknown>)["pontos"]) ? (
        <div className={styles.field}>
          <label className={styles.fieldLabel}>Pontos</label>
          {((c as Record<string,unknown>)["pontos"] as Array<Record<string,unknown>>).map((ponto, i) => {
            const pontos = (c as Record<string,unknown>)["pontos"] as Array<Record<string,unknown>>;
            return (
              <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
                <input className={styles.input} type="text" style={{ flex: 2 }}
                  placeholder="Rotulo"
                  value={String(ponto["rotulo"] ?? "")}
                  onChange={(e) => {
                    const next = [...pontos];
                    next[i] = { ...next[i], rotulo: e.target.value };
                    onChange({ ...cena, pontos: next } as Cena);
                  }} />
                <input className={styles.input} type="number" step={0.1} style={{ flex: 1 }}
                  placeholder="Valor"
                  value={Number(ponto["valor"] ?? 0)}
                  onChange={(e) => {
                    const next = [...pontos];
                    next[i] = { ...next[i], valor: Number(e.target.value) };
                    onChange({ ...cena, pontos: next } as Cena);
                  }} />
                <button
                  style={{ flexShrink: 0, background: "none", border: "1px solid var(--b-mid)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", padding: "2px 7px", fontSize: 14, lineHeight: 1 }}
                  onClick={() => {
                    if (pontos.length <= 2) return;
                    const next = pontos.filter((_, j) => j !== i);
                    onChange({ ...cena, pontos: next } as Cena);
                  }}
                >&#8722;</button>
              </div>
            );
          })}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 6 }}>
            <button
              style={{ background: "var(--accent)", border: "none", borderRadius: 6, color: "#fff", cursor: "pointer", padding: "4px 12px", fontSize: 12, fontWeight: 600 }}
              onClick={() => {
                const pontos = (c as Record<string,unknown>)["pontos"] as Array<Record<string,unknown>>;
                if (pontos.length >= 12) return;
                const next = [...pontos, { rotulo: `P${pontos.length + 1}`, valor: 1 }];
                onChange({ ...cena, pontos: next } as Cena);
              }}
            >+ Ponto</button>
          </div>
        </div>
      ) : null}

      {cena.tipo === "ListaPontos" ? listField("pontos", "Pontos (um por linha)") : null}
      {cena.tipo === "ListaPontos" ? (
        <div className={styles.field}>
          <label className={styles.fieldLabel}>Estilo da lista</label>
          <div style={{ display: "flex", gap: 8 }}>
            {([{ val: false, label: "Bullets" }, { val: true, label: "1. Numerado" }] as const).map(({ val, label: lbl }) => {
              const ativo = (c["numerado"] ?? false) === val;
              return (
                <button
                  key={String(val)}
                  onClick={() => onChange({ ...cena, numerado: val } as Cena)}
                  style={{
                    flex: 1, padding: "7px 0", borderRadius: 8, cursor: "pointer",
                    border: ativo ? "2px solid var(--accent)" : "1px solid var(--b-mid)",
                    background: ativo ? "rgba(255,255,255,0.06)" : "transparent",
                    color: ativo ? "var(--text-main)" : "var(--text-muted)",
                    fontSize: 12, fontWeight: ativo ? 700 : 400,
                  }}
                >{lbl}</button>
              );
            })}
          </div>
        </div>
      ) : null}
      {listField("bullets", "Bullets (um por linha)")}
      {listField("frases", "Frases (uma por linha)")}

      {(cena.tipo === "Hook" || cena.tipo === "FraseImpacto" || cena.tipo === "MiniCaso" || cena.tipo === "CTA") ? (() => {
        const palavras = (Array.isArray(c["palavras_destacadas"]) ? c["palavras_destacadas"] : []) as Array<{ palavra: string; cor: string }>;
        return (
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Palavras em destaque</label>
            {palavras.map((pw, i) => (
              <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "center" }}>
                <input
                  className={styles.input}
                  type="text"
                  style={{ flex: 3 }}
                  placeholder="palavra ou frase composta (ex: 20 MIL)"
                  value={pw.palavra}
                  onChange={(e) => {
                    const next = [...palavras];
                    next[i] = { ...next[i], palavra: e.target.value };
                    onChange({ ...cena, palavras_destacadas: next } as Cena);
                  }}
                />
                <input
                  type="color"
                  style={{ width: 36, height: 32, padding: 2, background: "var(--surface-raised)", border: "1px solid var(--b-mid)", borderRadius: 6, cursor: "pointer", flexShrink: 0 }}
                  value={
                    pw.cor.startsWith("#") ? pw.cor
                    : pw.cor === "secundaria" ? (corSecundariaEspecialista ?? "#F4C430")
                    : (corPrimariaEspecialista ?? "#E63946")
                  }
                  onChange={(e) => {
                    const next = [...palavras];
                    next[i] = { ...next[i], cor: e.target.value };
                    onChange({ ...cena, palavras_destacadas: next } as Cena);
                  }}
                />
                <button
                  title="Remover destaque"
                  style={{ flexShrink: 0, background: "none", border: "1px solid var(--b-mid)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", padding: "2px 7px", fontSize: 14, lineHeight: 1 }}
                  onClick={() => {
                    const next = palavras.filter((_, j) => j !== i);
                    onChange({ ...cena, palavras_destacadas: next } as Cena);
                  }}
                >&#8722;</button>
              </div>
            ))}
            {palavras.length < 3 ? (
              <button
                style={{ background: "var(--accent)", border: "none", borderRadius: 6, color: "#fff", cursor: "pointer", padding: "4px 12px", fontSize: 12, fontWeight: 600, marginTop: 4 }}
                onClick={() => {
                  const next = [...palavras, { palavra: "", cor: corPrimariaEspecialista ?? "#E63946" }];
                  onChange({ ...cena, palavras_destacadas: next } as Cena);
                }}
              >+ Destaque</button>
            ) : null}
          </div>
        );
      })() : null}

      {cena.tipo === "ComparativoNumerico" ? (
        <div className={styles.field}>
          <label className={styles.fieldLabel}>Cor do lado em destaque</label>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="color"
              style={{ width: 36, height: 32, padding: 2, background: "var(--surface-raised)", border: "1px solid var(--b-mid)", borderRadius: 6, cursor: "pointer" }}
              value={String(c["cor_destaque"] ?? corPrimariaEspecialista ?? "#E63946")}
              onChange={(e) => onChange({ ...cena, cor_destaque: e.target.value } as Cena)} />
            <input className={styles.input} type="text" style={{ flex: 1, fontFamily: "monospace" }}
              value={String(c["cor_destaque"] ?? "")}
              placeholder={corPrimariaEspecialista ?? "padrao do especialista"}
              onChange={(e) => onChange({ ...cena, cor_destaque: e.target.value || undefined } as Cena)} />
          </div>
        </div>
      ) : null}

      {(() => {
        const SFX_OPCOES = [
          { path: "sfx/whoosh.mp3",     label: "whoosh",     desc: "entrada rapida" },
          { path: "sfx/slide.mp3",      label: "slide",      desc: "movimento suave" },
          { path: "sfx/pop.mp3",        label: "pop",        desc: "item aparecendo" },
          { path: "sfx/ding.mp3",       label: "ding",       desc: "destaque / resultado" },
          { path: "sfx/transition.mp3", label: "transition", desc: "passagem de cena" },
        ];
        const sfx = c["sfx"] as { path?: string; volume?: number; inicio_segundos?: number; fim_segundos?: number } | undefined;
        const hasSfx = !!sfx?.path;

        function previewSfx(path: string, volume: number) {
          const audio = new window.Audio(`/${path}`);
          audio.volume = Math.min(1, volume / 10);
          audio.play().catch(() => {});
        }

        return (
          <div className={styles.field}>
            <label className={styles.fieldLabel} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span>Efeito sonoro</span>
              {hasSfx ? (
                <button
                  style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, padding: 0 }}
                  onClick={() => onChange({ ...cena, sfx: undefined } as Cena)}
                >&#10005; remover</button>
              ) : null}
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: hasSfx ? 8 : 0 }}>
              {SFX_OPCOES.map((op) => {
                const ativo = sfx?.path === op.path;
                return (
                  <div key={op.path} style={{ display: "flex", gap: 3, alignItems: "stretch" }}>
                    <button
                      onClick={() => onChange({ ...cena, sfx: ativo ? undefined : { path: op.path, volume: sfx?.volume ?? 5, inicio_segundos: sfx?.inicio_segundos, fim_segundos: sfx?.fim_segundos } } as Cena)}
                      style={{
                        display: "flex", flexDirection: "column", alignItems: "flex-start",
                        padding: "6px 10px", borderRadius: "8px 0 0 8px", cursor: "pointer",
                        border: ativo ? "2px solid var(--accent)" : "1px solid var(--b-mid)",
                        borderRight: "none",
                        background: ativo ? "rgba(255,255,255,0.06)" : "transparent",
                        color: ativo ? "var(--text-main)" : "var(--text-muted)",
                      }}
                    >
                      <span style={{ fontSize: 12, fontWeight: ativo ? 700 : 400 }}>{op.label}</span>
                      <span style={{ fontSize: 10, opacity: 0.6 }}>{op.desc}</span>
                    </button>
                    <button
                      title="Ouvir"
                      onClick={(e) => { e.stopPropagation(); previewSfx(op.path, sfx?.volume ?? 5); }}
                      style={{
                        padding: "0 8px", borderRadius: "0 8px 8px 0", cursor: "pointer",
                        border: ativo ? "2px solid var(--accent)" : "1px solid var(--b-mid)",
                        borderLeft: "1px solid var(--b-mid)",
                        background: "transparent",
                        color: "var(--text-muted)",
                        fontSize: 11,
                        lineHeight: 1,
                      }}
                    >&#9654;</button>
                  </div>
                );
              })}
            </div>
            {hasSfx ? (
              <div style={{ display: "flex", gap: 6 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 2 }}>Volume</div>
                  <input
                    className={styles.input}
                    type="number" min={0} max={10} step={1}
                    value={sfx?.volume ?? 5}
                    onChange={(e) => onChange({ ...cena, sfx: { ...sfx, volume: parseInt(e.target.value) ?? 5 } } as Cena)}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 2 }}>Inicio (s)</div>
                  <input
                    className={styles.input}
                    type="number" min={0} step={1}
                    value={sfx?.inicio_segundos ?? 0}
                    onChange={(e) => onChange({ ...cena, sfx: { ...sfx, inicio_segundos: parseInt(e.target.value) || 0 } } as Cena)}
                  />
                </div>
              </div>
            ) : null}
          </div>
        );
      })()}

      {(cena.tipo === "GraficoLinha" || cena.tipo === "GraficoBarra") ? (
        <div className={styles.timingGroup}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Cor primaria</label>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="color"
                style={{ width: 36, height: 32, padding: 2, background: "var(--surface-raised)", border: "1px solid var(--b-mid)", borderRadius: 6, cursor: "pointer" }}
                value={String(c["cor_primaria"] ?? corPrimariaEspecialista ?? "#2b3dbf")}
                onChange={(e) => onChange({ ...cena, cor_primaria: e.target.value } as Cena)} />
              <input className={styles.input} type="text" style={{ flex: 1, fontFamily: "monospace" }}
                value={String(c["cor_primaria"] ?? "")}
                placeholder={corPrimariaEspecialista ?? "padrao do especialista"}
                onChange={(e) => onChange({ ...cena, cor_primaria: e.target.value || undefined } as Cena)} />
            </div>
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Cor secundaria</label>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input type="color"
                style={{ width: 36, height: 32, padding: 2, background: "var(--surface-raised)", border: "1px solid var(--b-mid)", borderRadius: 6, cursor: "pointer" }}
                value={String(c["cor_secundaria"] ?? corSecundariaEspecialista ?? "#F4C430")}
                onChange={(e) => onChange({ ...cena, cor_secundaria: e.target.value } as Cena)} />
              <input className={styles.input} type="text" style={{ flex: 1, fontFamily: "monospace" }}
                value={String(c["cor_secundaria"] ?? "")}
                placeholder={corSecundariaEspecialista ?? "padrao do especialista"}
                onChange={(e) => onChange({ ...cena, cor_secundaria: e.target.value || undefined } as Cena)} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
