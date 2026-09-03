"use client";

import styles from "./ProcessingView.module.css";

// ── Constantes ────────────────────────────────────────────────────────────────

const STEPS = [
  { key: "transcribing", label: "Transcrição", detail: "Whisper AI — extraindo fala do vídeo" },
  { key: "analyzing",    label: "Análise",     detail: "Claude — identificando cenas e estrutura" },
  { key: "ready",        label: "Pronto",      detail: "Cenas geradas — abrindo editor" },
];

type ProcessingStep = "transcribing" | "analyzing" | "ready";

// ── ProcessingView ────────────────────────────────────────────────────────────

export function ProcessingView({
  fileName,
  step,
  transcriptCached = false,
}: {
  fileName: string;
  step: ProcessingStep;
  /** true quando o transcript veio do cache e o Whisper foi pulado. */
  transcriptCached?: boolean;
}) {
  const current = Math.max(0, STEPS.findIndex((s) => s.key === step));

  return (
    <main className={styles.root}>
      <div className={styles.card}>

        <div className={styles.heading}>
          <h2 className={styles.title}>Processando</h2>
          <p className={styles.subtitle}>Aguarde enquanto o pipeline analisa o vídeo</p>
        </div>

        <div className={styles.fileRow}>
          <div className={styles.fileIcon}>▶</div>
          <div className={styles.fileInfo}>
            <div className={styles.fileName}>{fileName}</div>
            <div className={styles.fileLabel}>Arquivo de entrada</div>
          </div>
        </div>

        <div className={styles.steps}>
          {STEPS.map((s, i) => {
            const done = i < current;
            const active = i === current;
            return (
              <div
                key={s.key}
                className={`${styles.step} ${active ? styles.active : ""}`}
              >
                <div className={`${styles.stepIcon} ${done ? styles.done : active ? styles.active : ""}`}>
                  {done ? (
                    <span className={styles.stepIconCheck}>✓</span>
                  ) : active ? (
                    <div className={styles.spinner} />
                  ) : (
                    <span className={styles.stepIconNum}>{i + 1}</span>
                  )}
                </div>
                <div className={styles.stepBody}>
                  <div className={`${styles.stepLabel} ${done ? styles.done : active ? styles.active : ""}`}>
                    {s.label}
                  </div>
                  <div className={styles.stepDetail}>
                    {s.key === "transcribing" && transcriptCached
                      ? "Transcrição reaproveitada do cache — Whisper pulado"
                      : s.detail}
                  </div>
                </div>
                {done && <span className={styles.stepBadgeDone}>OK</span>}
                {active && <span className={styles.stepBadgeActive}>Em andamento</span>}
              </div>
            );
          })}
        </div>

        <div className={styles.progressTrack}>
          <div
            className={styles.progressBar}
            style={{ width: `${(current / (STEPS.length - 1)) * 100}%` }}
          />
        </div>

      </div>
    </main>
  );
}
