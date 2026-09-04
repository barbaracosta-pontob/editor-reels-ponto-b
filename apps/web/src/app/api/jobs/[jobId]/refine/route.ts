/**
 * POST /api/jobs/[jobId]/refine
 *
 * Le a transcricao e as cenas atuais do job, envia ao Claude com o
 * prompt de refinamento e devolve a sequencia de cenas melhorada.
 * Tambem persiste o resultado em scenes.json.
 */

import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { refine, planejarInserts, AnalysisError } from "../../../../../services/analysis-bridge";
import { buscarInserts } from "../../../../../services/inserts";
import { getEspecialistaOrGenerico } from "../../../../../lib/db";
import { getVideoDuration } from "../../../../../lib/video-duration";

import { acharJobDir, jobDirOuLocal, REPO_ROOT } from "@/lib/jobsDir";

export async function POST(
  req: NextRequest,
  { params }: { params: { jobId: string } },
) {
  const { jobId } = params;
  const jobDir = jobDirOuLocal(jobId);

  let brief: string | undefined;
  try {
    const body = await req.json();
    brief = typeof body?.brief === "string" && body.brief.trim() ? body.brief.trim() : undefined;
  } catch {
    // body vazio ou nao-JSON
  }

  if (!existsSync(jobDir)) {
    return NextResponse.json({ error: "Job nao encontrado" }, { status: 404 });
  }

  const transcriptPath = path.join(jobDir, "transcript.json");
  if (!existsSync(transcriptPath)) {
    return NextResponse.json({ error: "Transcricao nao encontrada" }, { status: 404 });
  }
  const transcript = JSON.parse(await readFile(transcriptPath, "utf-8"));

  const scenesPath = path.join(jobDir, "scenes.json");
  if (!existsSync(scenesPath)) {
    return NextResponse.json({ error: "Cenas nao encontradas" }, { status: 404 });
  }
  const cenasAtuais = JSON.parse(await readFile(scenesPath, "utf-8"));

  const especialistaSlug = cenasAtuais.especialista_slug ?? "generico";
  const rawEsp = getEspecialistaOrGenerico(especialistaSlug);

  const especialista = {
    nome: rawEsp.nome || "Especialista",
    cargo: rawEsp.cargo || "",
    area_atuacao: rawEsp.nicho || undefined,
    identidade_visual: {
      cor_destaque_primaria: rawEsp.cor_primaria,
      cor_destaque_secundaria: rawEsp.cor_secundaria,
    },
    observacoes: rawEsp.brief_padrao || undefined,
  };

  // Obtem duracao real do arquivo de video via ffprobe.
  // Procura qualquer arquivo .mp4 dentro do diretorio do job — o nome pode
  // diferir, mas a pasta sempre tem apenas um video bruto.
  const videoFile = (() => {
    try {
      const files = readdirSync(jobDir);
      return files.find((f) => f.toLowerCase().endsWith(".mp4")) ?? null;
    } catch {
      return null;
    }
  })();
  const videoPathLocal = videoFile ? path.join(jobDir, videoFile) : cenasAtuais.video_original_path;
  const videoDuration = videoPathLocal ? await getVideoDuration(videoPathLocal) : null;

  // Formatos com inserts (tela dividida / narrado): "Refinar com IA" REGERA os
  // inserts do zero (novo plano + nova busca). O motor de cenas/refine não
  // entende inserts — chamar refine() aqui sempre falha na validação. Preserva o
  // layout/trim/CTA do job e só troca a lista de inserts.
  const formato = cenasAtuais.formato;

  // Caixinha de pergunta: não há nada para a IA refinar — a edição é o vídeo
  // inteiro + a copy digitada à mão. Chamar refine() aqui falharia na validação
  // (cenas: []), então devolve o estado atual sem tocar em nada.
  if (formato === "caixinha_pergunta") {
    return NextResponse.json({
      scenes: cenasAtuais,
      metadata: { semRefino: true, motivo: "Formato caixinha de pergunta não usa refino por IA." },
    });
  }

  if (formato === "tela_dividida" || formato === "narrado") {
    try {
      const briefFinal = [rawEsp.brief_padrao, brief].filter(Boolean).join("\n\n---\nBRIEF DO JOB:\n") || undefined;
      const plano = await planejarInserts({
        transcript,
        videoDuration: videoDuration ?? undefined,
        brief: briefFinal,
      });
      const inserts = await buscarInserts(jobDir, jobId, plano.inserts);

      const scenesRegeneradas = { ...cenasAtuais };
      if (formato === "tela_dividida") {
        const cfg = cenasAtuais.tela_dividida ?? {};
        scenesRegeneradas.tela_dividida = {
          especialista_posicao: cfg.especialista_posicao ?? "inicio",
          split_pct: cfg.split_pct ?? 55,
          inserts,
        };
      } else {
        scenesRegeneradas.narrado = { ...(cenasAtuais.narrado ?? {}), inserts };
      }
      await writeFile(scenesPath, JSON.stringify(scenesRegeneradas, null, 2), "utf-8");

      return NextResponse.json({
        scenes: scenesRegeneradas,
        metadata: { regenerouInserts: true, totalInserts: inserts.length },
      });
    } catch (err) {
      console.error("[refine/inserts] erro:", err);
      const message = err instanceof Error ? err.message : String(err);
      const isCredits = message.includes("credit balance");
      return NextResponse.json(
        {
          error: isCredits
            ? "Saldo insuficiente na API Anthropic. Acesse platform.claude.com/settings/billing para adicionar creditos."
            : "Erro ao regerar inserts: " + message,
        },
        { status: 500 },
      );
    }
  }

  try {
    const result = await refine({
      transcript,
      videoOriginalPath: cenasAtuais.video_original_path,
      videoDuration: videoDuration ?? undefined,
      cenasAtuais,
      especialista,
      brief,
    });

    // Preserva cores e metadados do especialista
    const scenesRefinadas = {
      ...result.scenes,
      especialista_slug: especialistaSlug,
      cor_primaria: rawEsp.cor_primaria || undefined,
      cor_secundaria: rawEsp.cor_secundaria || undefined,
      fonte_url: rawEsp.fonte_url || undefined,
      fonte_familia: rawEsp.fonte_familia || undefined,
    };
    await writeFile(scenesPath, JSON.stringify(scenesRefinadas, null, 2), "utf-8");

    return NextResponse.json({
      scenes: scenesRefinadas,
      metadata: result.metadata,
    });
  } catch (err) {
    console.error("[refine] erro:", err);

    if (err instanceof AnalysisError) {
      return NextResponse.json(
        {
          error: err.message,
          tentativas: err.tentativas,
          detalhe: err.zodError
            ? err.zodError.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")
            : undefined,
        },
        { status: 422 },
      );
    }

    const message = err instanceof Error ? err.message : String(err);
    const isCredits = message.includes("credit balance");
    const isTruncated = message.includes("max_tokens") || message.includes("length");

    return NextResponse.json(
      {
        error: isCredits
          ? "Saldo insuficiente na API Anthropic. Acesse platform.claude.com/settings/billing para adicionar creditos."
          : isTruncated
          ? "Resposta truncada pelo limite de tokens. Tente novamente."
          : "Erro inesperado: " + message,
      },
      { status: 500 },
    );
  }
}
