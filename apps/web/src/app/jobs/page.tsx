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
  createdAt: string;
  hasOutput: boolean;
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
    fetch("/api/jobs")
      .then((r) => r.json())
      .then((data) => { setJobs(Array.isArray(data) ? data : []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div className={styles.root}>
      <AppNav breadcrumb="Jobs processados" />
      <div className={styles.header}>
        <h1 className={styles.title}>Jobs processados</h1>
        <p className={styles.sub}>Abra um job existente direto no editor, sem reprocessar.</p>
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
                <span className={styles.metaItem}>{formatDate(job.createdAt)}</span>
              </div>
            </div>
            <div className={styles.cardRight}>
              {job.hasOutput && (
                <span className={styles.badge}>✓ Renderizado</span>
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
