"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import Link from "next/link";
import { ProcessingView } from "@/components/ProcessingView";
import { EditorView } from "@/components/EditorView";
import { ActionButton } from "@/components/ActionButton";
import { useToast } from "@/components/Toast";
import type { Job } from "@/types";
import styles from "./page.module.css";

// ── Tipos ─────────────────────────────────────────────────────────────────────

type Screen = "upload" | "processing" | "editor";
type ProcessingStep = "transcribing" | "analyzing" | "ready";

type EspecialistaItem = {
  slug: string;
  nome: string;
  cargo: string;
  cor_primaria: string;
};

// ── Dados estáticos ───────────────────────────────────────────────────────────

const PIPELINE_STEPS = [
  { num: "01", label: "Transcrição", detail: "Whisper extrai a fala com timestamps" },
  { num: "02", label: "Análise",     detail: "Claude identifica cenas e monta a estrutura" },
  { num: "03", label: "Renderização", detail: "Remotion gera o vídeo em 9:16, 16:9 ou 1:1" },
];

// ── Home ──────────────────────────────────────────────────────────────────────

export default function Home() {
  const [screen, setScreen] = useState<Screen>("upload");
  const [job, setJob] = useState<Job | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [brief, setBrief] = useState("");
  const [especialistaSlug, setEspecialistaSlug] = useState("generico");
  const [formato, setFormato] = useState<"cenas" | "tela_dividida" | "aula" | "narrado" | "caixinha_pergunta">("cenas");
  const [legendaOpcao, setLegendaOpcao] = useState<"nenhuma" | "palavra_unica" | "frase_limpa" | "dinamica">("nenhuma");
  const [especialistas, setEspecialistas] = useState<EspecialistaItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [processingStep, setProcessingStep] = useState<ProcessingStep>("transcribing");
  // Sinalizado pelo servidor quando a transcricao veio do cache (Whisper pulado).
  const [transcriptCached, setTranscriptCached] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  useEffect(() => {
    fetch("/api/especialistas")
      .then((r) => r.json())
      .then((data: EspecialistaItem[]) => setEspecialistas(data))
      .catch(() => {});
  }, []);

  function handleFile(f: File) {
    if (!f.type.startsWith("video/")) return;
    setFile(f);
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  }, []);

  async function handleSubmit() {
    if (!file) return;
    const formData = new FormData();
    formData.append("video", file);
    formData.append("brief", brief);
    formData.append("especialista_slug", especialistaSlug);
    formData.append("formato", formato);
    if (legendaOpcao !== "nenhuma") {
      formData.append("legenda", JSON.stringify({ ativa: true, estilo: legendaOpcao }));
    }
    setProcessingStep("transcribing");
    setTranscriptCached(false);
    setScreen("processing");
    try {
      const res = await fetch("/api/jobs", { method: "POST", body: formData });
      if (!res.body) throw new Error("Resposta sem body");
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
          if (msg.type === "step") {
            setProcessingStep(msg.step as ProcessingStep);
            if (msg.step === "transcribing") setTranscriptCached(!!msg.cached);
          } else if (msg.type === "done") {
            setJob(msg.job as Job);
            setScreen("editor");
            return;
          } else if (msg.type === "error") {
            throw new Error(msg.message);
          }
        }
      }
    } catch (err) {
      console.error("[handleSubmit] falha ao processar o vídeo:", err);
      const msg = err instanceof Error ? err.message : String(err);
      toast(msg || "Não foi possível processar o vídeo. Veja os detalhes no console (F12).");
      setScreen("upload");
    }
  }

  function handleNew() {
    setScreen("upload");
    setFile(null);
    setBrief("");
    setJob(null);
    setProcessingStep("transcribing");
    setTranscriptCached(false);
  }

  if (screen === "processing") return <ProcessingView fileName={file?.name ?? ""} step={processingStep} transcriptCached={transcriptCached} />;
  if (screen === "editor" && job) return <EditorView job={job} onNew={handleNew} />;

  return (
    <main className={styles.root}>

      {/* Painel esquerdo */}
      <div className={styles.leftPanel}>
        <div className={styles.gridBg} />

        <div className={styles.leftContent}>
          <div className={styles.badge}>
            <span className={styles.badgeDot} />
            <span className={styles.badgeLabel}>Pipeline ativo</span>
          </div>

          <h1 className={styles.title}>
            Ponto B<br /><span>Editor de Vídeos</span>
          </h1>

          <p className={styles.description}>
            Suba o vídeo bruto de um expert, descreva o que priorizar
            e o pipeline gera o vídeo editado automaticamente.
          </p>

          <div className={styles.pipelineSteps}>
            {PIPELINE_STEPS.map((item, i) => (
              <div key={item.num} className={styles.pipelineStep}>
                {i < PIPELINE_STEPS.length - 1 && (
                  <div className={styles.stepConnector} />
                )}
                <div className={styles.stepNum}>{item.num}</div>
                <div className={styles.stepBody}>
                  <div className={styles.stepLabel}>{item.label}</div>
                  <div className={styles.stepDetail}>{item.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className={styles.leftFooter}>Ponto B — uso interno</div>
      </div>

      {/* Painel direito */}
      <div className={styles.rightPanel}>

        <div className={styles.formHeading}>
          <div className={styles.formHeadingRow}>
            <div>
              <h2 className={styles.formTitle}>Novo vídeo</h2>
              <p className={styles.formSubtitle}>Configure e submeta o vídeo para processamento</p>
            </div>
            {/* Atalho para /jobs: a pagina ja existia, mas so era alcancavel
                digitando a URL. Daqui da pra reabrir um job ja processado no
                editor sem refazer transcricao e analise. */}
            <Link href="/jobs" className={styles.jobsLink}>
              Jobs processados →
            </Link>
          </div>
        </div>

        {/* Drop zone */}
        <div
          className={`${styles.dropzone} ${dragging ? styles.dragging : ""} ${file ? styles.hasFile : ""}`}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          <div className={`${styles.dropzoneIcon} ${file ? styles.hasFile : ""}`}>
            {file ? "✓" : "↑"}
          </div>

          {file ? (
            <div style={{ textAlign: "center" }}>
              <div className={styles.dropzoneFileName}>{file.name}</div>
              <div className={styles.dropzoneFileMeta}>
                {(file.size / 1024 / 1024).toFixed(1)} MB · clique para trocar
              </div>
            </div>
          ) : (
            <div style={{ textAlign: "center" }}>
              <div className={styles.dropzoneHint}>Arraste ou clique para selecionar</div>
              <div className={styles.dropzoneBadges}>
                {["MP4", "MOV", "AVI"].map((ext) => (
                  <span key={ext} className={styles.extBadge}>{ext}</span>
                ))}
              </div>
            </div>
          )}

          <input
            ref={fileRef}
            type="file"
            accept="video/*"
            style={{ display: "none" }}
            onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
          />
        </div>

        <div className={styles.divider} />

        {/* Especialista */}
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Especialista</label>
          <div className={styles.selectWrapper}>
            <select
              className={styles.select}
              value={especialistaSlug}
              onChange={(e) => setEspecialistaSlug(e.target.value)}
            >
              <option value="generico">Sem especialista — genérico</option>
              {especialistas
                .filter((e) => e.slug !== "generico")
                .map((e) => (
                  <option key={e.slug} value={e.slug}>
                    {e.nome}{e.cargo ? ` — ${e.cargo}` : ""}
                  </option>
                ))}
            </select>
            <span className={styles.selectArrow}>▾</span>
          </div>
          <div className={styles.fieldHint}>
            <Link href="/especialistas">Gerenciar especialistas →</Link>
          </div>
        </div>

        {/* Formato de edição */}
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Formato</label>
          <div className={styles.selectWrapper}>
            <select
              className={styles.select}
              value={formato}
              onChange={(e) => setFormato(e.target.value as typeof formato)}
            >
              <option value="cenas">Cenas (edição atual)</option>
              <option value="tela_dividida">Tela dividida (especialista + inserts)</option>
              <option value="aula">Aula (slide + especialista)</option>
              <option value="narrado">Narrado (voz + inserts em tela cheia)</option>
              <option value="caixinha_pergunta">Caixinha de pergunta (especialista + sticker)</option>
            </select>
            <span className={styles.selectArrow}>▾</span>
          </div>
          <div className={styles.fieldHint}>
            Tela dividida busca imagens do tema (Pexels). Aula usa a gravação com slide + câmera. Caixinha de pergunta reproduz o sticker do Instagram — a pergunta é escrita no editor.
          </div>
        </div>

        {/* Legenda contínua */}
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Legenda contínua</label>
          <div className={styles.selectWrapper}>
            <select
              className={styles.select}
              value={legendaOpcao}
              onChange={(e) => setLegendaOpcao(e.target.value as typeof legendaOpcao)}
            >
              <option value="nenhuma">Sem legenda</option>
              <option value="palavra_unica">Palavra única (elegante)</option>
              <option value="frase_limpa">Frase limpa (contínua)</option>
              <option value="dinamica">Dinâmica (palavra ativa)</option>
            </select>
            <span className={styles.selectArrow}>▾</span>
          </div>
          <div className={styles.fieldHint}>
            Aparece nos trechos de vídeo e some nas cenas com texto próprio.
          </div>
        </div>

        {/* Brief */}
        <div className={styles.fieldGroup} style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 5 }}>
            <label className={styles.fieldLabel} style={{ margin: 0 }}>
              Brief{" "}
              <span className={styles.fieldLabelOpt}>— opcional</span>
            </label>
            <Link href="/componentes" target="_blank" style={{ fontSize: 12, color: "var(--ink-ghost)", textDecoration: "none", whiteSpace: "nowrap" }}>
              ver componentes →
            </Link>
          </div>
          <textarea
            className={styles.textarea}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="Ex: priorize os comparativos, use o trecho 3:20–4:10..."
            rows={3}
          />
        </div>

        <ActionButton
          onClick={handleSubmit}
          disabled={!file}
        >
          {file ? "Analisar e montar vídeo →" : "Selecione um vídeo para começar"}
        </ActionButton>
      </div>
    </main>
  );
}
