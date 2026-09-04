/**
 * POST /api/jobs
 * Recebe o video + brief + especialista_slug.
 * Responde com SSE: emite eventos de progresso (transcribing, analyzing)
 * e no final emite o job completo (done) ou um erro (error).
 */

import { NextRequest } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir, readFile, copyFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { analyze, planejarInserts } from "../../../services/analysis-bridge";
import { buscarInserts } from "../../../services/inserts";
import { getEspecialistaOrGenerico } from "../../../lib/db";
import { getVideoDuration } from "../../../lib/video-duration";
import { LegendaConfigSchema, transcriptToLegendaPalavras, type LegendaConfig, AulaConfigSchema, CaixinhaPerguntaSchema } from "@pontob/schema";
import { todosJobsDirs } from "@/lib/jobsDir";

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

// Cache de transcricoes, indexado por hash do arquivo de video + modelo do
// Whisper.
//
// Motivo: a transcricao e a etapa cara do pipeline (5-8 min num video de 45s
// em 1080p). Se qualquer etapa POSTERIOR falhar - a chamada ao LLM sem saldo
// na API, por exemplo - o job inteiro e descartado e o Whisper roda de novo do
// zero no retry, mesmo sendo exatamente o mesmo arquivo. Com o cache, o retry
// e instantaneo.
//
// Fica na RAIZ do repo, fora de JOBS_DIR, de proposito: os jobs sao isolados
// por instancia (jobs-instance2, jobs-instance3...), mas nao ha razao para
// transcrever o mesmo arquivo de novo so porque ele foi aberto noutra
// instancia. O cache e conteudo-enderecado, entao compartilhar e seguro.
const TRANSCRIPT_CACHE_DIR = path.join(REPO_ROOT, ".transcript-cache");

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
        // Formato de edição escolhido na tela inicial (default: cenas).
        const formatoRaw = (form.get("formato") as string) ?? "cenas";
        const formato = ["tela_dividida", "aula", "narrado", "caixinha_pergunta"].includes(formatoRaw) ? formatoRaw : "cenas";

        // Configuração de legenda contínua (opcional). Vem como JSON no form.
        const legendaRaw = (form.get("legenda") as string) ?? "";
        let legendaConfig: LegendaConfig | undefined;
        if (legendaRaw) {
          try {
            const parsed = LegendaConfigSchema.parse(JSON.parse(legendaRaw));
            if (parsed.ativa) legendaConfig = parsed;
          } catch (e) {
            console.warn("[POST /api/jobs] config de legenda inválida, ignorando:", e);
          }
        }

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

        // --- ETAPA 1: Transcricao (com cache por hash do video) ---
        const whisperModel = process.env.WHISPER_MODEL ?? "large-v3";
        // O modelo entra na chave: trocar de modelo tem que invalidar o cache,
        // senao um upgrade de qualidade nunca surtiria efeito em video repetido.
        const cacheKey = crypto
          .createHash("sha256")
          .update(videoBuffer)
          .update(`|${whisperModel}`)
          .digest("hex");
        const cachePath = path.join(TRANSCRIPT_CACHE_DIR, `${cacheKey}.json`);
        const transcriptPath = path.join(jobDir, "transcript.json");
        const transcriptEmCache = existsSync(cachePath);

        emit({ type: "step", step: "transcribing", cached: transcriptEmCache });

        if (transcriptEmCache) {
          await copyFile(cachePath, transcriptPath);
          console.log(`[POST /api/jobs] transcricao reaproveitada do cache (${cacheKey.slice(0, 12)})`);
        } else {
          const pythonBin = existsSync(PYTHON) ? PYTHON : "python3";

          await execFileAsync(pythonBin, [
            TRANSCRIBE_SCRIPT,
            "--input", videoPath,
            "--output", transcriptPath,
            "--model", whisperModel,
            "--device", process.env.WHISPER_DEVICE ?? "auto",
          ]);

          // Guarda no cache. Best-effort: falha aqui nao pode derrubar o job.
          try {
            await mkdir(TRANSCRIPT_CACHE_DIR, { recursive: true });
            await copyFile(transcriptPath, cachePath);
          } catch (e) {
            console.warn("[POST /api/jobs] nao foi possivel gravar o cache de transcricao:", e);
          }
        }

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

        // CTA final (encerramento). Copy puxada do especialista.
        // Regra (decisão do Artur 2026-08-07): no formato AULA o CTA é padrão do
        // formato (aula termina em chamada pro evento) — nasce SEMPRE ligado; sem
        // copy do especialista, entra um placeholder editável no editor (nunca fica
        // só a seta). Nos outros formatos, liga só quando há copy (senão fica
        // desligado e o usuário liga no editor). Duração se ajusta no editor.
        const ctaCopy = ((rawEspecialista.cta_palavra || rawEspecialista.cta_texto_secundario || "") as string).trim();
        const ctaAula = formato === "aula";
        const ctaFinal = {
          ativo: ctaAula || ctaCopy.length > 0,
          copy: ctaCopy || (ctaAula ? "Garanta sua vaga" : ""),
          duracao_segundos: 4,
        };
        const ctaDur = ctaFinal.ativo ? ctaFinal.duracao_segundos : 0;

        // --- FORMATOS COM INSERTS (tela dividida / narrado): plano + Pexels ---
        if (formato === "tela_dividida" || formato === "narrado") {
          const plano = await planejarInserts({
            transcript,
            videoDuration: videoDuration ?? undefined,
            brief: briefFinal,
          });
          const inserts = await buscarInserts(jobDir, jobId, plano.inserts);

          const videoEndInserts = videoDuration != null
            ? Math.round(videoDuration * 10) / 10
            : (inserts.length ? inserts[inserts.length - 1].fim : 0);

          const configFormato = formato === "tela_dividida"
            ? { tela_dividida: { especialista_posicao: "inicio", split_pct: 55, inserts } }
            : { narrado: { inserts } };

          const scenesInserts = {
            duracao_total_estimada: videoEndInserts + ctaDur,
            video_original_path: videoPath,
            video_start_segundos: 0,
            video_end_segundos: videoEndInserts,
            cenas: [],
            cta_final: ctaFinal,
            cor_primaria: rawEspecialista.cor_primaria || undefined,
            cor_secundaria: rawEspecialista.cor_secundaria || undefined,
            fonte_url: rawEspecialista.fonte_url || undefined,
            fonte_familia: rawEspecialista.fonte_familia || undefined,
            especialista_slug: especialistaSlug,
            formato,
            ...configFormato,
            legenda: legendaConfig ?? LegendaConfigSchema.parse({}),
            legenda_palavras: transcriptToLegendaPalavras(transcript),
          };

          const scenesPathInserts = path.join(jobDir, "scenes.json");
          await writeFile(scenesPathInserts, JSON.stringify(scenesInserts, null, 2), "utf-8");

          emit({
            type: "done",
            job: {
              id: jobId,
              fileName: videoFile.name,
              videoPath,
              transcriptPath,
              scenesPath: scenesPathInserts,
              status: "ready",
              scenes: scenesInserts,
              outputPath: null,
              error: null,
              createdAt: new Date().toISOString(),
              especialista_slug: especialistaSlug,
            },
          });
          return;
        }

        // --- FORMATO CAIXINHA DE PERGUNTA: especialista em tela cheia + sticker ---
        // Sem LLM e sem inserts: a pergunta é digitada no editor. A caixinha
        // entra em 0 e sai em 5s por padrão (ou no fim do vídeo, se for menor).
        if (formato === "caixinha_pergunta") {
          const videoEndCx = videoDuration != null ? Math.round(videoDuration * 10) / 10 : 0;
          const fimCaixinha = videoEndCx > 0 ? Math.min(5, videoEndCx) : 5;
          const scenesCx = {
            duracao_total_estimada: videoEndCx + ctaDur,
            video_original_path: videoPath,
            video_start_segundos: 0,
            video_end_segundos: videoEndCx,
            cenas: [],
            cta_final: ctaFinal,
            cor_primaria: rawEspecialista.cor_primaria || undefined,
            cor_secundaria: rawEspecialista.cor_secundaria || undefined,
            fonte_url: rawEspecialista.fonte_url || undefined,
            fonte_familia: rawEspecialista.fonte_familia || undefined,
            especialista_slug: especialistaSlug,
            formato: "caixinha_pergunta",
            caixinha: CaixinhaPerguntaSchema.parse({ fim_segundos: fimCaixinha }),
            legenda: legendaConfig ?? LegendaConfigSchema.parse({}),
            legenda_palavras: transcriptToLegendaPalavras(transcript),
          };
          const scenesPathCx = path.join(jobDir, "scenes.json");
          await writeFile(scenesPathCx, JSON.stringify(scenesCx, null, 2), "utf-8");
          emit({
            type: "done",
            job: {
              id: jobId,
              fileName: videoFile.name,
              videoPath,
              transcriptPath,
              scenesPath: scenesPathCx,
              status: "ready",
              scenes: scenesCx,
              outputPath: null,
              error: null,
              createdAt: new Date().toISOString(),
              especialista_slug: especialistaSlug,
            },
          });
          return;
        }

        // --- FORMATO AULA: layout (recorte do slide + especialista), sem LLM ---
        if (formato === "aula") {
          const videoEndAula = videoDuration != null ? Math.round(videoDuration * 10) / 10 : 0;
          // CTA usa gradiente da identidade da marca (cor primária), não foto de fundo.
          const scenesAula = {
            duracao_total_estimada: videoEndAula + ctaDur,
            video_original_path: videoPath,
            video_start_segundos: 0,
            video_end_segundos: videoEndAula,
            cenas: [],
            cta_final: ctaFinal,
            cor_primaria: rawEspecialista.cor_primaria || undefined,
            cor_secundaria: rawEspecialista.cor_secundaria || undefined,
            fonte_url: rawEspecialista.fonte_url || undefined,
            fonte_familia: rawEspecialista.fonte_familia || undefined,
            especialista_slug: especialistaSlug,
            formato: "aula",
            aula: AulaConfigSchema.parse({}),
            legenda: legendaConfig ?? LegendaConfigSchema.parse({}),
            legenda_palavras: transcriptToLegendaPalavras(transcript),
          };
          const scenesPathAula = path.join(jobDir, "scenes.json");
          await writeFile(scenesPathAula, JSON.stringify(scenesAula, null, 2), "utf-8");
          emit({
            type: "done",
            job: {
              id: jobId,
              fileName: videoFile.name,
              videoPath,
              transcriptPath,
              scenesPath: scenesPathAula,
              status: "ready",
              scenes: scenesAula,
              outputPath: null,
              error: null,
              createdAt: new Date().toISOString(),
              especialista_slug: especialistaSlug,
            },
          });
          return;
        }

        const result = await analyze({
          transcript,
          videoOriginalPath: videoPath,
          videoDuration: videoDuration ?? undefined,
          especialista,
          brief: briefFinal,
          // Modo legenda: quando o usuário escolheu legenda, o agente monta a
          // edição com VideoSimples como base e cenas gráficas só nos picos.
          legenda: !!legendaConfig?.ativa,
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
          // Legenda contínua: sempre grava as palavras (do transcript) para permitir
          // ligar/editar a legenda depois no editor, mesmo que o job comece sem legenda.
          // `legenda.ativa` reflete a escolha da tela inicial (default: desligada).
          legenda: legendaConfig ?? LegendaConfigSchema.parse({}),
          legenda_palavras: transcriptToLegendaPalavras(transcript),
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
        const low = raw.toLowerCase();
        const message =
          // 400 invalid_request_error da Anthropic quando a workspace ficou sem
          // credito. Vinha como blob de JSON cru na tela porque so 401/429/529
          // tinham tratamento.
          low.includes("credit balance") || low.includes("plans & billing") || low.includes("purchase credits")
            ? "A API da Anthropic esta sem saldo. Adicione creditos em Plans & Billing no console da Anthropic e tente de novo. A transcricao deste video ficou em cache — o retry nao vai reprocessar o video."
            : raw.includes("401") || raw.toLowerCase().includes("authentication") || raw.toLowerCase().includes("api key")
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

type JobResumo = {
  id: string;
  fileName: string;
  especialista_slug: string;
  formato: string;
  createdAt: string;
  outputs: string[];
  hasOutput: boolean;
  rendering: boolean;
  instancia: string;
};

// Cache por job, invalidado por mtime. A varredura ingenua relia e reparseava
// os 98 scenes.json (11.8 KB de media, 1.1 MB somados) a CADA chamada de
// /api/jobs - o handler levava 20-40s numa maquina de 2 nucleos com um render
// em andamento. Agora o caso comum e so um statSync por arquivo; leitura e
// JSON.parse acontecem apenas no job que realmente mudou.
type Assinatura = { scenes: number; out: number; status: number };
const cachePorJob = new Map<string, { assin: Assinatura; dados: JobResumo }>();

// Cache da lista inteira. Absorve rajadas (varias abas + polling batendo junto)
// sem repetir a varredura.
let cacheLista: { t: number; dados: JobResumo[] } | null = null;
const TTL_LISTA_MS = 4000;

function mtimeOuZero(p: string): number {
  try { return statSync(p).mtimeMs; } catch { return 0; }
}

/**
 * GET /api/jobs
 * Lista os jobs de TODAS as instancias, nao so os desta porta.
 *
 * Antes cada porta listava apenas o proprio JOBS_DIR, entao um job criado no
 * localhost:3002 sumia no localhost:3004 e voltar num trabalho antigo exigia
 * lembrar em qual aba ele tinha nascido. Jobs novos continuam nascendo no
 * diretorio da instancia (e o que evita duas instancias colidirem); o que muda
 * e so a visao: leitura unificada, escrita isolada.
 */
export async function GET() {
  try {
    if (cacheLista && Date.now() - cacheLista.t < TTL_LISTA_MS) {
      return Response.json(cacheLista.dados);
    }

    const jobs: JobResumo[] = [];
    const vistos = new Set<string>();

    for (const base of todosJobsDirs()) {
      if (!existsSync(base)) continue;
      const instancia = path.basename(base);

      let entries;
      try {
        entries = readdirSync(base, { withFileTypes: true });
      } catch {
        continue; // diretorio sumiu ou sem permissao
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const jobId = entry.name;
        const jobDir = path.join(base, jobId);
        const scenesPath = path.join(jobDir, "scenes.json");
        // scenes.json e o que separa um job de verdade de um upload
        // interrompido ou do diretorio de cache de transcricao.
        const mtScenes = mtimeOuZero(scenesPath);
        if (!mtScenes) continue;

        const outDir = path.join(jobDir, "out");
        const assin: Assinatura = {
          scenes: mtScenes,
          // mtime do diretorio muda quando um mp4 novo aparece nele
          out: mtimeOuZero(outDir),
          // o render vivo reescreve esse arquivo a cada ~400ms
          status: mtimeOuZero(path.join(jobDir, "render-status.json")),
        };

        const cache = cachePorJob.get(jobDir);
        const igual = cache
          && cache.assin.scenes === assin.scenes
          && cache.assin.out === assin.out
          && cache.assin.status === assin.status;

        if (igual) {
          vistos.add(jobDir);
          jobs.push(cache!.dados);
          continue;
        }

        let fileName = "";
        let especialista_slug = "generico";
        let formato = "cenas";
        let createdAt = "";

        try {
          const files = readdirSync(jobDir);
          const mp4 = files.find((f) => f.endsWith(".mp4"));
          if (mp4) fileName = mp4;
        } catch { /* segue com o que tem */ }

        try {
          createdAt = new Date(mtScenes).toISOString();
        } catch { /* segue com o que tem */ }

        try {
          const scenes = JSON.parse(readFileSync(scenesPath, "utf-8"));
          especialista_slug = scenes.especialista_slug ?? "generico";
          formato = scenes.formato ?? "cenas";
        } catch { /* segue com o que tem */ }

        // Quais formatos ja foram renderizados. Um readdir do out/ em vez de
        // existsSync + statSync por formato (6 syscalls viram 1).
        // A versao antiga olhava "out/reel.mp4", nome legado que nenhum render
        // atual gera - por isso hasOutput vinha false ate em job ja exportado.
        const outputs: string[] = [];
        if (assin.out) {
          try {
            const arquivos = new Set(readdirSync(outDir));
            for (const fmt of ["reels", "wide", "square"]) {
              if (arquivos.has(`reel_${fmt}.mp4`)) outputs.push(fmt);
            }
          } catch { /* ignora */ }
        }

        // Render em andamento. So le o arquivo se ele foi tocado ha pouco: um
        // render vivo escreve a cada ~400ms, entao status antigo = render
        // antigo, e nao precisa de leitura nem de parse.
        let rendering = false;
        if (assin.status && Date.now() - assin.status < 120_000) {
          try {
            const st = JSON.parse(readFileSync(path.join(jobDir, "render-status.json"), "utf-8"));
            rendering = st.status === "running";
          } catch { /* arquivo sendo reescrito neste instante */ }
        }

        const dados: JobResumo = {
          id: jobId,
          fileName,
          especialista_slug,
          formato,
          createdAt,
          outputs,
          hasOutput: outputs.length > 0,
          rendering,
          instancia,
        };

        cachePorJob.set(jobDir, { assin, dados });
        vistos.add(jobDir);
        jobs.push(dados);
      }
    }

    // Descarta do cache jobs que sumiram do disco, para o Map nao crescer sem fim.
    for (const chave of cachePorJob.keys()) {
      if (!vistos.has(chave)) cachePorJob.delete(chave);
    }

    jobs.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));

    cacheLista = { t: Date.now(), dados: jobs };
    return Response.json(jobs);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
