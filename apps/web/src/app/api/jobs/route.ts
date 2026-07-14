/**
 * POST /api/jobs
 * Recebe o video + brief + especialista_slug.
 * Responde com SSE: emite eventos de progresso (transcribing, analyzing)
 * e no final emite o job completo (done) ou um erro (error).
 */

import { NextRequest } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { analyze } from "../../../services/analysis-bridge";
import { getEspecialistaOrGenerico } from "../../../lib/db";
import { getVideoDuration } from "../../../lib/video-duration";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(process.cwd(), "../..");
const JOBS_DIR = process.env.JOBS_DIR
  ? path.resolve(REPO_ROOT, process.env.JOBS_DIR)
  : path.join(REPO_ROOT, "jobs");
const PYTHON = path.join(
  REPO_ROOT,
  process.platform === "win32"
    ? "services/transcription/.venv/Scripts/python.exe"
    : "services/transcription/.venv/bin/python"
);
const TRANSCRIBE_SCRIPT = path.join(REPO_ROOT, "services/transcription/run.py");

function sseEvent(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function emit(data: unknown) {
        controller.enqueue(encoder.encode(sseEvent(data)));
      }

      try {
        const form = await req.formData();
        const videoFile = form.get("video") as File | null;
        const brief = (form.get("brief") as string) ?? "";
        const especialistaSlug = (form.get("especialista_slug") as string) ?? "generico";

        if (!videoFile) {
          emit({ type: "error", message: "Video nao enviado" });
          controller.close();
          return;
        }

        const jobId = crypto.randomUUID().slice(0, 8);
        const jobDir = path.join(JOBS_DIR, jobId);
        await mkdir(jobDir, { recursive: true });

        const videoPath = path.join(jobDir, videoFile.name);
        const videoBuffer = Buffer.from(await videoFile.arrayBuffer());
        await writeFile(videoPath, videoBuffer);

        // --- ETAPA 1: Transcricao ---
        emit({ type: "step", step: "transcribing" });

        const transcriptPath = path.join(jobDir, "transcript.json");
        const pythonBin = existsSync(PYTHON) ? PYTHON : "python3";

        await execFileAsync(pythonBin, [
          TRANSCRIBE_SCRIPT,
          "--input", videoPath,
          "--output", transcriptPath,
          "--model", process.env.WHISPER_MODEL ?? "large-v3",
          "--device", process.env.WHISPER_DEVICE ?? "auto",
        ]);

        const transcript = JSON.parse(await readFile(transcriptPath, "utf-8"));

        // --- ETAPA 2: Analise Claude ---
        emit({ type: "step", step: "analyzing" });

        const rawEspecialista = getEspecialistaOrGenerico(especialistaSlug);

        const especialista: Parameters<typeof analyze>[0]["especialista"] = {
          nome: rawEspecialista.nome || "Especialista",
          cargo: rawEspecialista.cargo || "",
          area_atuacao: rawEspecialista.nicho || undefined,
          publico_alvo: rawEspecialista.publico_alvo || undefined,
          tom_de_voz: rawEspecialista.tom_de_voz || undefined,
          vocabulario_prioritario: rawEspecialista.vocabulario
            ? rawEspecialista.vocabulario.split(",").map((t: string) => ({ termo: t.trim(), tipo: "jargao" as const })).filter((t: { termo: string }) => t.termo)
            : undefined,
          palavras_a_evitar: rawEspecialista.palavras_proibidas
            ? rawEspecialista.palavras_proibidas.split(",").map((p: string) => p.trim()).filter(Boolean)
            : undefined,
          cta_padrao: rawEspecialista.cta_formato
            ? {
                formato: rawEspecialista.cta_formato,
                palavra_ou_evento: rawEspecialista.cta_palavra || undefined,
                texto_secundario: rawEspecialista.cta_texto_secundario || undefined,
              }
            : undefined,
          metricas_referencia: rawEspecialista.metricas
            ? rawEspecialista.metricas.split(",").map((m: string) => ({ nome: m.trim(), unidade: "" })).filter((m: { nome: string }) => m.nome)
            : undefined,
          identidade_visual: {
            cor_destaque_primaria: rawEspecialista.cor_primaria,
            cor_destaque_secundaria: rawEspecialista.cor_secundaria,
          },
          observacoes: [
            rawEspecialista.brief_padrao || null,
            rawEspecialista.posicionamento_texto
              ? "Posicionamento padrao de texto: " + rawEspecialista.posicionamento_texto
              : null,
          ]
            .filter(Boolean)
            .join("\n") || undefined,
        };

        const briefFinal = [rawEspecialista.brief_padrao, brief]
          .filter(Boolean)
          .join("\n\n---\nBRIEF DO JOB:\n") || undefined;

        // Obtem duracao real do arquivo de video via ffprobe.
        // Usada como teto duro para impedir que o agente gere timeline alem
        // do conteudo do video (resultando em tela preta/congelada no final).
        const videoDuration = await getVideoDuration(videoPath);

        const result = await analyze({
          transcript,
          videoOriginalPath: videoPath,
          videoDuration: videoDuration ?? undefined,
          especialista,
          brief: briefFinal,
        });

        // Calcula video_end_segundos respeitando o teto fisico do arquivo.
        const scenesRaw = result.scenes as Record<string, unknown>;
        const agentStart = typeof scenesRaw.video_start_segundos === "number"
          ? scenesRaw.video_start_segundos as number
          : 0;
        const agentDuracao = typeof scenesRaw.duracao_total_estimada === "number"
          ? scenesRaw.duracao_total_estimada as number
          : (result.scenes.cenas ?? []).reduce((acc: number, c: { duracao_segundos: number }) => acc + c.duracao_segundos, 0);
        const endCalculado = typeof scenesRaw.video_end_segundos === "number"
          ? scenesRaw.video_end_segundos as number
          : Math.round((agentStart + agentDuracao) * 10) / 10;
        const agentEnd = videoDuration != null
          ? Math.min(endCalculado, videoDuration)
          : endCalculado;

        const scenesComCores = {
          ...result.scenes,
          video_start_segundos: agentStart,
          video_end_segundos: agentEnd,
          cor_primaria: rawEspecialista.cor_primaria || undefined,
          cor_secundaria: rawEspecialista.cor_secundaria || undefined,
          fonte_url: rawEspecialista.fonte_url || undefined,
          fonte_familia: rawEspecialista.fonte_familia || undefined,
          especialista_slug: especialistaSlug,
        };

        const scenesPath = path.join(jobDir, "scenes.json");
        await writeFile(scenesPath, JSON.stringify(scenesComCores, null, 2), "utf-8");

        // --- DONE ---
        emit({
          type: "done",
          job: {
            id: jobId,
            fileName: videoFile.name,
            videoPath,
            transcriptPath,
            scenesPath,
            status: "ready",
            scenes: scenesComCores,
            outputPath: null,
            error: null,
            createdAt: new Date().toISOString(),
            especialista_slug: especialistaSlug,
          },
        });

      } catch (err) {
        console.error("[POST /api/jobs]", err);
        const raw = err instanceof Error ? err.message : String(err);
        // Erros de autenticação da Anthropic (AuthenticationError)
        const message =
          raw.includes("401") || raw.toLowerCase().includes("authentication") || raw.toLowerCase().includes("api key")
            ? "Chave de API inválida ou ausente. Verifique o valor de ANTHROPIC_API_KEY no arquivo .env e reinicie o servidor."
            : raw.includes("529") || raw.toLowerCase().includes("overloaded")
            ? "A API da Anthropic está sobrecarregada. Aguarde alguns segundos e tente novamente."
            : raw.includes("rate") || raw.includes("429")
            ? "Limite de requisições da API atingido. Aguarde alguns segundos e tente novamente."
            : `Erro ao processar o vídeo: ${raw}`;
        emit({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

/**
 * GET /api/jobs
 * Lista todos os jobs processados.
 */
export async function GET() {
  try {
    const jobsDir = JOBS_DIR;
    if (!existsSync(jobsDir)) return Response.json([]);

    const entries = readdirSync(jobsDir, { withFileTypes: true });
    const jobs = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const jobId = entry.name;
      const jobDir = path.join(jobsDir, jobId);
      const scenesPath = path.join(jobDir, "scenes.json");
      if (!existsSync(scenesPath)) continue;

      let fileName = "";
      let especialista_slug = "generico";
      let createdAt = "";

      try {
        const files = readdirSync(jobDir);
        const mp4 = files.find((f) => f.endsWith(".mp4"));
        if (mp4) fileName = mp4;
      } catch {}

      try {
        const stat = statSync(scenesPath);
        createdAt = stat.mtime.toISOString();
      } catch {}

      try {
        const scenes = JSON.parse(readFileSync(scenesPath, "utf-8"));
        especialista_slug = scenes.especialista_slug ?? "generico";
      } catch {}

      const hasOutput = existsSync(path.join(jobDir, "out", "reel.mp4"));

      jobs.push({ id: jobId, fileName, especialista_slug, createdAt, hasOutput });
    }

    jobs.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));

    return Response.json(jobs);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
