"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { AppNav } from "@/components/AppNav";
import styles from "./page.module.css";

type JobItem = {
  id: string;
  fileName: string;
  especialista_slug: string;
  formato?: string;
  createdAt: string;
  /** Formatos ja renderizados: "reels" | "wide" | "square". */
  outputs?: string[];
  hasOutput: boolean;
  /** true se ha um render em andamento agora para este job. */
  rendering?: boolean;
  /** Instancia dona do job ("jobs", "jobs-instance3"...). */
  instancia?: string;
};

const FORMATO_LABEL: Record<string, string> = {
  cenas: "Cenas",
  tela_dividida: "Tela dividida",
  aula: "Aula",
  narrado: "Narrado",
};

const OUTPUT_LABEL: Record<string, string> = {
  reels: "9:16",
  wide: "16:9",
  square: "1:1",
};

function formatDate(iso: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }) +
    " " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

export default function JobsPage() {
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let vivo = true;
    function carregar() {
      fetch("/api/jobs", { cache: "no-store" })
        .then((r) => r.json())
        .then((data) => { if (vivo) { setJobs(Array.isArray(data) ? data : []); setLoading(false); } })
        .catch(() => { if (vivo) setLoading(false); });
    }
    carregar();
    // Recarrega a cada 10s: um render que termina noutra aba (ou noutra
    // instancia) aparece aqui sem precisar dar F5.
    const t = setInterval(carregar, 10000);
    return () => { vivo = false; clearInterval(t); };
  }, []);

  return (
    <div className={styles.root}>
      <AppNav breadcrumb="Jobs processados" />
      <div className={styles.header}>
        <h1 className={styles.title}>Jobs processados</h1>
        <p className={styles.sub}>
          Todos os jobs de todas as instâncias. Abra um direto no editor, sem reprocessar.
        </p>
      </div>

      <div className={styles.list}>
        {loading && <p className={styles.empty}>Carregando...</p>}
        {!loading && jobs.length === 0 && (
          <p className={styles.empty}>Nenhum job encontrado. Faça o upload de um vídeo na tela inicial.</p>
        )}
        {jobs.map((job) => (
          <div key={job.id} className={styles.card}>
            <div className={styles.cardLeft}>
              <div className={styles.cardId}>{job.id}</div>
              <div className={styles.cardFile}>{job.fileName || "vídeo"}</div>
              <div className={styles.cardMeta}>
                <span className={styles.metaItem}>{job.especialista_slug}</span>
                <span className={styles.metaDivider}>·</span>
                <span className={styles.metaItem}>
                  {FORMATO_LABEL[job.formato ?? "cenas"] ?? job.formato}
                </span>
                <span className={styles.metaDivider}>·</span>
                <span className={styles.metaItem}>{formatDate(job.createdAt)}</span>
                {job.instancia && job.instancia !== "jobs" && (
                  <>
                    <span className={styles.metaDivider}>·</span>
                    <span className={styles.metaItem}>{job.instancia}</span>
                  </>
                )}
              </div>
            </div>
            <div className={styles.cardRight}>
              {job.rendering && (
                <span className={styles.badge} style={{ color: "var(--amber)", borderColor: "var(--amber-border)", background: "var(--amber-dim)" }}>
                  ● Renderizando
                </span>
              )}
              {!job.rendering && (job.outputs?.length ?? 0) > 0 && (
                <span className={styles.badge}>
                  ✓ {job.outputs!.map((f) => OUTPUT_LABEL[f] ?? f).join(" · ")}
                </span>
              )}
              <Link href={`/jobs/${job.id}`} className={styles.btnEditor}>
                Abrir editor <ArrowRight size={16} strokeWidth={2.5} />
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
