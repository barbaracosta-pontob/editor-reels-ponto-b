/**
 * POST /api/jobs/[jobId]/render
 *
 * Dispara o render EM BACKGROUND e responde imediatamente (202).
 * O progresso NAO viaja mais pela conexao HTTP: e gravado em
 * jobs/<id>/render-status.json e lido pela UI via GET .../render/status.
 *
 * POR QUE MUDOU (2026-09-03)
 * --------------------------
 * A versao anterior devolvia SSE e o cliente lia o stream com um
 * `while(true) { reader.read() }`. Quando a aba entrava em Back-Forward Cache
 * o Chrome congelava o stream: o read nunca mais resolvia e nunca rejeitava,
 * deixando a tela "Renderizando" travada num frame X/Y para sempre - enquanto
 * o Remotion terminava normalmente e escrevia o mp4. Sem estado em disco nao
 * havia como reconectar nem descobrir que tinha acabado.
 *
 * Agora o ciclo de vida do render nao depende mais do navegador.
 */

import { NextRequest } from "next/server";
import { spawn, execFile } from "node:child_process";
import os from "node:os";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import {
  readStatus,
  writeStatus,
  processoVivo,
  type RenderPhase,
  type RenderStatus,
} from "@/lib/renderStatus";

import { acharJobDir, jobDirOuLocal, REPO_ROOT } from "@/lib/jobsDir";
import { adquirirLock } from "@/lib/renderLock";
const REMOTION_DIR = path.join(REPO_ROOT, "apps/remotion");

// Remotion passa por 3 fases distintas durante o render. Cada uma emite
// padroes de log diferentes:
//
//   1. Bundling     - "Bundled" / "Bundling" / "(1/3) Bundling code"
//   2. Rendering    - "Rendered X/Y" - frame-by-frame via Chromium
//   3. Encoding     - "Encoded X/Y" / "Stitching" / "Combining" - FFmpeg junta tudo

const FRAME_RE = /Rendered\s+(\d+)\/(\d+)/i;
const ENCODED_RE = /Encoded\s+(\d+)\/(\d+)/i;
const ETA_RE = /(\d+h\s*)?(\d+m\s*)?(\d+s)\s+remaining/i;

const PHASE_MARKERS: Array<{ pattern: RegExp; phase: RenderPhase }> = [
  { pattern: /\bbundl(ed|ing)\b/i,                          phase: "bundling" },
  { pattern: /Composition information loaded/i,              phase: "bundling" },
  { pattern: /\bRendering frames\b/i,                        phase: "rendering" },
  { pattern: /\bStitching\b/i,                               phase: "encoding" },
  { pattern: /\b(Encoding|Combining|Muxing)\b/i,             phase: "encoding" },
  { pattern: /\bFinaliz(ing|ed)\b/i,                         phase: "encoding" },
];

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, "");
}

function resolveRemotionBin(): string {
  const isWin = process.platform === "win32";
  const ext = isWin ? ".cmd" : "";
  const local = path.join(REMOTION_DIR, `node_modules/.bin/remotion${ext}`);
  const root = path.join(REPO_ROOT, `node_modules/.bin/remotion${ext}`);
  return existsSync(local) ? local : existsSync(root) ? root : `remotion${ext}`;
}

// Prefixos de assets estaticos que devem ser convertidos para URL HTTP absoluta
// para que o Remotion possa busca-los via rede durante o render (sem staticFile).
const STATIC_ASSET_PREFIXES = ["sfx/", "musica/", "ambient/"];

function isStaticAssetPath(val: unknown): val is string {
  return typeof val === "string" &&
    !val.startsWith("http") &&
    STATIC_ASSET_PREFIXES.some((p) => val.startsWith(p));
}

function substituirVideoPaths(obj: unknown, videoUrl: string, baseUrl: string): unknown {
  if (Array.isArray(obj)) return obj.map((v) => substituirVideoPaths(v, videoUrl, baseUrl));
  if (obj && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => {
        if (k === "video_path" || k === "video_original_path") return [k, videoUrl];
        // Converte sfx.path e musica_fundo.path relativos para URL HTTP absoluta.
        // O Remotion proibe staticFile() com URLs - assets devem ser servidos via HTTP.
        if (k === "path" && isStaticAssetPath(v)) {
          return [k, `${baseUrl}/${(v as string).replace(/^\//, "")}`];
        }
        // Converte logo_url relativa para absoluta
        if (k === "logo_url" && typeof v === "string" && v.startsWith("/")) {
          return [k, `${baseUrl}${v}`];
        }
        // Converte image_url de insert (tela dividida) relativa para absoluta.
        if (k === "image_url" && typeof v === "string" && v.startsWith("/")) {
          return [k, `${baseUrl}${v}`];
        }
        // Converte video_url de insert (b-roll de video) relativa para absoluta.
        // Sem isso, o Remotion nao busca os mp4 dos inserts no render (falha).
        if (k === "video_url" && typeof v === "string" && v.startsWith("/")) {
          return [k, `${baseUrl}${v}`];
        }
        return [k, substituirVideoPaths(v, videoUrl, baseUrl)];
      })
    );
  }
  return obj;
}

// IMPORTANTE: o nome do arquivo de saida usa direto a formatKey
// (`reel_${formatKey}.mp4`) - sem campo `suffix` intermediario.
// Versao antiga tinha suffix="reel" para a key "reels", gerando
// `reel_reel.mp4` em disco enquanto o download tentava buscar
// `reel_reels.mp4` (HTTP 404).
const FORMAT_CONFIG = {
  reels:  { compositionId: "Reel",       label: "9:16 Reels" },
  wide:   { compositionId: "ReelWide",   label: "16:9 Wide" },
  square: { compositionId: "ReelSquare", label: "1:1 Square" },
} as const;

type FormatKey = keyof typeof FORMAT_CONFIG;

/**
 * Ajusta a prioridade do processo de render no Windows.
 *
 * POR QUE: o render roda numa janela de console em segundo plano. O Windows 11
 * empurra processos de segundo plano para EcoQoS ("Modo de eficiencia") quando
 * a maquina fica ociosa - clock reduzido e execucao nos nucleos de eficiencia.
 *
 * POR QUE MUDOU (2026-09-04): a versao anterior colocava a ARVORE INTEIRA em
 * AboveNormal - o log mostrou "prioridade AboveNormal aplicada a 29 processo(s)".
 * Numa maquina de 2 nucleos fisicos isso nao cria CPU: so garante que os 29
 * processos do render ganhem da thread do proprio Next, que e quem serve os mp4
 * dos inserts PARA o render e responde o /render/status. O sintoma foi
 * /render/status levando 16569ms para ler um JSON de 500 bytes.
 *
 * Agora: a arvore vai para `Normal` (o suficiente para escapar do EcoQoS, sem
 * passar na frente do dev server) e so o processo raiz fica em AboveNormal.
 *
 * Best-effort de proposito: se o PowerShell nao existir, se faltar permissao ou
 * se a arvore ja tiver mudado, nao acontece nada e o render segue normal. Nunca
 * pode derrubar um job por causa de um ajuste de prioridade.
 */
function priorizarArvore(pid: number, jobId: string): void {
  if (process.platform !== "win32") {
    try { os.setPriority(pid, os.constants.priority.PRIORITY_ABOVE_NORMAL); } catch { /* ignora */ }
    return;
  }
  // No Windows spawn usa shell: true, entao `pid` e o cmd.exe - os processos que
  // interessam sao os descendentes. Espera alguns segundos para a arvore existir.
  setTimeout(() => {
    const ps = [
      "$ErrorActionPreference='SilentlyContinue';",
      `$raiz=${pid};`,
      "$alvo=@($raiz);",
      "for($i=0;$i -lt 4;$i++){",
      "  $filhos=Get-CimInstance Win32_Process | Where-Object { $alvo -contains $_.ParentProcessId } | ForEach-Object { $_.ProcessId };",
      "  if(-not $filhos){break};",
      "  $alvo+=$filhos",
      "};",
      // Arvore inteira em Normal: tira do EcoQoS sem competir com o Next.
      "foreach($p in $alvo){ try { (Get-Process -Id $p).PriorityClass='Normal' } catch {} };",
      // So a raiz fica acima do normal.
      "try { (Get-Process -Id $raiz).PriorityClass='AboveNormal' } catch {};",
      "Write-Output $alvo.Count",
    ].join(" ");
    execFile("powershell", ["-NoProfile", "-Command", ps], (err, stdout) => {
      if (err) {
        console.warn(`[render ${jobId}] nao foi possivel ajustar a prioridade:`, err.message);
        return;
      }
      console.log(`[render ${jobId}] prioridade Normal aplicada a ${String(stdout).trim()} processo(s); raiz em AboveNormal`);
    });
  }, 8000);
}

// Guarda em memoria dos renders disparados por ESTE processo. Serve pra evitar
// dois renders concorrentes do mesmo job. Nao e a fonte da verdade - o
// render-status.json em disco e, justamente porque sobrevive a hot-reload.
const emAndamento = new Set<string>();

/**
 * Roda os formatos em sequencia, atualizando o render-status.json.
 * NAO recebe o controller de nenhuma response: a request que disparou isso
 * ja terminou ha muito tempo.
 */
async function executarRender(
  jobId: string,
  jobDir: string,
  propsPath: string,
  outputDir: string,
  formatos: FormatKey[],
): Promise<void> {
  const bin = resolveRemotionBin();
  const isWin = process.platform === "win32";
  const startedAt = Date.now();
  const outputs: Record<string, string> = {};

  // Estado local; cada mutacao e persistida por `flush()`.
  const status: RenderStatus = {
    status: "running",
    formatos,
    phase: "queued",
    frames: 0,
    total: 0,
    eta: "",
    outputs,
    startedAt,
    updatedAt: startedAt,
  };

  // Throttle: o Remotion emite "Rendered X/Y" varias vezes por segundo. Escrever
  // o arquivo a cada linha faria centenas de writes/s no disco a toa.
  // 800ms ainda e mais rapido que o polling da UI (1s), entao nada e perdido, e
  // sao ~1100 escritas num render de 15 min em vez de ~2200 - o que importa numa
  // maquina que ja esta com o disco disputado pelo proprio render.
  let ultimoFlush = 0;
  async function flush(force = false) {
    const agora = Date.now();
    if (!force && agora - ultimoFlush < 800) return;
    ultimoFlush = agora;
    status.updatedAt = agora;
    try {
      await writeStatus(jobDir, status);
    } catch {
      // Disco ocupado; o proximo flush resolve.
    }
  }

  await flush(true);

  // FILA SERIAL: espera a vez antes de gastar CPU. Ver lib/renderLock.ts para o
  // motivo. Enquanto espera, continua escrevendo o status (phase "queued") — sem
  // isso a UI acharia que o render travou e mostraria o aviso de stall.
  const liberarLock = await adquirirLock(jobId, ({ donoJobId, esperandoHa }) => {
    status.phase = "queued";
    status.filaInfo = donoJobId && donoJobId !== jobId
      ? `Aguardando o render do job ${donoJobId.slice(0, 8)} terminar (${esperandoHa}s na fila).`
      : `Aguardando outro render terminar (${esperandoHa}s na fila).`;
    void flush();
  });

  status.filaInfo = undefined;
  status.phase = "bundling";
  await flush(true);

  try {
    for (const formatKey of formatos) {
      const fmt = FORMAT_CONFIG[formatKey];
      const outputPath = path.join(outputDir, `reel_${formatKey}.mp4`);

      status.format = formatKey;
      status.formatLabel = fmt.label;
      status.phase = "bundling";
      status.frames = 0;
      status.total = 0;
      status.eta = "";
      await flush(true);

      // Log completo vai para arquivo, NAO para o stdout do Next dev.
      // No Windows, `process.stdout.write` e sincrono: ecoar o log verbose do
      // Remotion linha a linha bloqueava o event loop do mesmo processo que
      // estava servindo os mp4 dos inserts para o proprio render. Era parte do
      // motivo de um reel de 41s levar ~1h e do dev server devolver 500 no meio.
      const logStream = createWriteStream(path.join(jobDir, `render-${formatKey}.log`), { flags: "w" });

      const exitCode = await new Promise<number>((resolve) => {
        let currentPhase: RenderPhase = "bundling";
        let lastEncodedFrames = 0;
        let lastEncodedTotal = 0;

        // Margem de tempo maior: com b-roll de video, cada frame pode demorar
        // mais para o OffthreadVideo baixar os mp4 dos inserts.
        // Opcional: apontar um Chrome instalado via REMOTION_BROWSER_EXECUTABLE
        // quando o chrome-headless-shell falha em conectar.
        //
        // `--log=info` (nao mais `verbose`): "Rendered X/Y", "Encoded X/Y" e os
        // marcadores de fase continuam saindo em info. O verbose so acrescentava
        // ruido de rede/browser - dezenas de MB de log por render.
        const extraArgs: string[] = ["--timeout=120000", "--log=info"];
        if (process.env.REMOTION_BROWSER_EXECUTABLE) {
          extraArgs.push(`--browser-executable=${process.env.REMOTION_BROWSER_EXECUTABLE}`);
        }
        // Renderizador OpenGL do Chromium. O default headless e "swangle"
        // (rasterizacao 100% por software na CPU). Em maquina com GPU decente,
        // "angle" passa a rasterizacao para a placa e pode acelerar bastante.
        // Fica atras de env porque o resultado depende da GPU/driver e, em
        // alguns casos, muda sutilmente o antialiasing - tem que ser medido,
        // nao presumido. Valores: swangle | angle | egl | swiftshader.
        if (process.env.REMOTION_GL) {
          extraArgs.push(`--gl=${process.env.REMOTION_GL}`);
        }

        const child = spawn(bin, [
          "render",
          fmt.compositionId,
          outputPath,
          `--props=${propsPath}`,
          ...extraArgs,
        ], {
          cwd: REMOTION_DIR,
          shell: isWin,
          stdio: ["ignore", "pipe", "pipe"],
        });

        status.pid = child.pid ?? undefined;
        void flush(true);
        if (child.pid) priorizarArvore(child.pid, jobId);

        function processChunk(chunk: Buffer) {
          const raw = chunk.toString();
          logStream.write(raw);
          const text = stripAnsi(raw);

          // Detecta transicao de fase. Avanca so para frente para nao oscilar.
          for (const marker of PHASE_MARKERS) {
            if (marker.pattern.test(text)) {
              const order: RenderPhase[] = ["bundling", "rendering", "encoding"];
              if (order.indexOf(marker.phase) > order.indexOf(currentPhase)) {
                currentPhase = marker.phase;
                status.phase = currentPhase;
                // Ao entrar em encoding zera os contadores de frame pra UI nao
                // mostrar "1239/1239" parado enquanto o FFmpeg roda.
                if (currentPhase === "encoding") {
                  status.frames = 0;
                  status.total = 0;
                  status.eta = "";
                }
              }
            }
          }

          const frameMatch = text.match(FRAME_RE);
          if (frameMatch) {
            status.frames = parseInt(frameMatch[1], 10);
            status.total = parseInt(frameMatch[2], 10);
            if (currentPhase === "bundling") {
              currentPhase = "rendering";
              status.phase = currentPhase;
            }
          }

          const encodedMatch = text.match(ENCODED_RE);
          if (encodedMatch) {
            lastEncodedFrames = parseInt(encodedMatch[1], 10);
            lastEncodedTotal = parseInt(encodedMatch[2], 10);
            if (currentPhase !== "encoding") {
              currentPhase = "encoding";
              status.phase = currentPhase;
            }
            status.frames = lastEncodedFrames;
            status.total = lastEncodedTotal;
          }

          const etaMatch = text.match(ETA_RE);
          if (etaMatch) {
            status.eta = etaMatch[0].replace(/\s*remaining/i, "").trim();
          }

          void flush();
        }

        child.stdout?.on("data", processChunk);
        child.stderr?.on("data", processChunk);

        child.on("close", (code) => {
          logStream.end();
          resolve(code ?? 1);
        });
        child.on("error", (err) => {
          logStream.write(`\n[spawn error] ${String(err)}\n`);
          logStream.end();
          status.error = String(err);
          resolve(1);
        });
      });

      if (exitCode !== 0) {
        status.status = "error";
        status.error = status.error
          ?? `Falha ao renderizar formato ${fmt.label} (codigo ${exitCode}). Log: jobs/${jobId}/render-${formatKey}.log`;
        await flush(true);
        return;
      }

      outputs[formatKey] = outputPath;
      status.outputs = outputs;
      await flush(true);
    }

    status.status = "done";
    status.pid = undefined;
    await flush(true);
  } catch (err) {
    status.status = "error";
    status.error = String(err);
    await flush(true);
  } finally {
    liberarLock();
    emAndamento.delete(jobId);
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { jobId: string } }
) {
  const { jobId } = params;
  // O job pode ter nascido noutra instancia; renderiza no diretorio dele.
  const jobDir = acharJobDir(jobId);

  if (!jobDir) {
    return Response.json({ error: "Job nao encontrado" }, { status: 404 });
  }
  const scenesPath = path.join(jobDir, "scenes.json");

  // Ja existe um render vivo pra esse job? Nao dispara outro - a UI so precisa
  // comecar a fazer polling. Isso tambem cobre o caso de o usuario dar F5 na
  // tela de render e clicar em exportar de novo.
  const anterior = await readStatus(jobDir);
  if (emAndamento.has(jobId) || (anterior?.status === "running" && processoVivo(anterior.pid))) {
    return Response.json({ ok: true, jaRodando: true }, { status: 202 });
  }

  // Formatos selecionados pelo usuario (default: apenas reels)
  let formatos: FormatKey[] = ["reels"];
  try {
    const body = await req.json();
    if (Array.isArray(body?.formatos) && body.formatos.length > 0) {
      formatos = body.formatos.filter((f: string) => f in FORMAT_CONFIG) as FormatKey[];
      if (formatos.length === 0) formatos = ["reels"];
    }
  } catch { /* body vazio */ }

  // Prepara props antes de disparar o processo
  const outputDir = path.join(jobDir, "out");
  let propsPath: string;
  try {
    const scenes = JSON.parse(await readFile(scenesPath, "utf-8"));
    const host = req.headers.get("host") ?? "localhost:3001";
    const videoUrl = `http://${host}/api/jobs/${jobId}/video`;
    const baseUrl = `http://${host}`;
    const scenesComUrl = substituirVideoPaths(scenes, videoUrl, baseUrl);

    propsPath = path.join(jobDir, "props.json");
    await writeFile(propsPath, JSON.stringify(scenesComUrl, null, 2), "utf-8");

    await mkdir(outputDir, { recursive: true });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }

  emAndamento.add(jobId);

  // Marca "running" ANTES de responder. Se o status so fosse escrito la dentro
  // do executarRender, o primeiro poll da UI poderia chegar antes e ler o
  // status "done" do render ANTERIOR - mostrando o video velho como se fosse o
  // novo. Escrever aqui fecha essa janela.
  const agora = Date.now();
  await writeStatus(jobDir, {
    status: "running",
    formatos,
    format: formatos[0],
    formatLabel: FORMAT_CONFIG[formatos[0]].label,
    phase: "queued",
    frames: 0,
    total: 0,
    eta: "",
    outputs: {},
    startedAt: agora,
    updatedAt: agora,
  });

  // Deliberadamente SEM await: a request responde agora, o render segue.
  void executarRender(jobId, jobDir, propsPath, outputDir, formatos);

  return Response.json({ ok: true, formatos }, { status: 202 });
}
