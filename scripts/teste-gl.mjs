/**
 * Mede se a Intel UHD 620 acelera o render — angle vs swangle.
 *
 * POR QUE: o Chromium headless do Remotion usa por padrao "swangle", que
 * rasteriza 100% por software na CPU. Numa maquina de 2 nucleos fisicos e sem
 * GPU dedicada, passar o compositing para a GPU integrada e a unica mudanca com
 * potencial de ganho GRANDE. Mas depende de driver e pode cair silenciosamente
 * de volta para software — por isso se mede em vez de presumir.
 *
 * COMO USAR
 *   1. O dev server precisa estar RODANDO na porta que gerou o props.json do
 *      job (os assets do render sao servidos por ele).
 *   2. node scripts/teste-gl.mjs [jobId] [--frames=300] [--composition=Reel]
 *
 * Renderiza um trecho curto (300 frames por padrao) com cada modo e compara o
 * fps da fase de render — descontando bundling, que e identico nos dois.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REMOTION_DIR = path.join(RAIZ, "apps/remotion");

const args = process.argv.slice(2);
const flag = (nome, padrao) => {
  const a = args.find((x) => x.startsWith(`--${nome}=`));
  return a ? a.split("=")[1] : padrao;
};
const jobIdArg = args.find((a) => !a.startsWith("--"));
const FRAMES = parseInt(flag("frames", "300"), 10);
const COMPOSITION = flag("composition", "Reel");
const MODOS = flag("modos", "swangle,angle").split(",");

/** Todos os diretorios de jobs da raiz (jobs, jobs-instance2, ...). */
function jobsDirs() {
  return readdirSync(RAIZ)
    .filter((d) => /^jobs/.test(d) && statSync(path.join(RAIZ, d)).isDirectory())
    .map((d) => path.join(RAIZ, d));
}

/** Acha o job pedido, ou o job com props.json mais recente. */
function acharJob() {
  const candidatos = [];
  for (const dir of jobsDirs()) {
    for (const id of readdirSync(dir)) {
      const props = path.join(dir, id, "props.json");
      if (!existsSync(props)) continue;
      if (jobIdArg && !id.startsWith(jobIdArg)) continue;
      candidatos.push({ id, jobDir: path.join(dir, id), props, mtime: statSync(props).mtimeMs });
    }
  }
  candidatos.sort((a, b) => b.mtime - a.mtime);
  return candidatos[0] ?? null;
}

function binRemotion() {
  const ext = process.platform === "win32" ? ".cmd" : "";
  const local = path.join(REMOTION_DIR, `node_modules/.bin/remotion${ext}`);
  const root = path.join(RAIZ, `node_modules/.bin/remotion${ext}`);
  return existsSync(local) ? local : existsSync(root) ? root : `remotion${ext}`;
}

/**
 * Confere se o dev server que serve os assets do props.json esta de pe.
 * Sem isso o render falha no meio e o teste nao mede nada.
 */
async function conferirServidor(props) {
  const txt = readFileSync(props, "utf-8");
  const m = txt.match(/http:\/\/(localhost|127\.0\.0\.1):(\d+)/);
  if (!m) return { ok: true, aviso: "props.json sem URL http — nada a conferir." };
  const base = `http://${m[1]}:${m[2]}`;
  try {
    await fetch(base, { signal: AbortSignal.timeout(3000) });
    return { ok: true, base };
  } catch {
    return { ok: false, base };
  }
}

const RENDERED_RE = /Rendered\s+(\d+)\/(\d+)/;

/** Roda um render e devolve o fps medido SO na fase de frames. */
function rodar(modo, job) {
  return new Promise((resolve) => {
    const saida = path.join(job.jobDir, `gl-test-${modo}.mp4`);
    const inicio = Date.now();
    let tPrimeiroFrame = 0;
    let tUltimoFrame = 0;
    let primeiro = 0;
    let ultimo = 0;
    let erro = "";

    const child = spawn(binRemotion(), [
      "render",
      COMPOSITION,
      saida,
      `--props=${job.props}`,
      `--frames=0-${FRAMES - 1}`,
      `--gl=${modo}`,
      "--timeout=120000",
      "--log=info",
    ], { cwd: REMOTION_DIR, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });

    const ler = (buf) => {
      const txt = buf.toString().replace(/\x1B\[[0-9;]*m/g, "");
      const m = txt.match(RENDERED_RE);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!primeiro) { primeiro = n; tPrimeiroFrame = Date.now(); }
        ultimo = n;
        tUltimoFrame = Date.now();
      }
      if (/error|Error|falhou/.test(txt) && !erro) erro = txt.trim().slice(0, 300);
      process.stdout.write(".");
    };
    child.stdout?.on("data", ler);
    child.stderr?.on("data", ler);

    child.on("close", (code) => {
      process.stdout.write("\n");
      const seg = (tUltimoFrame - tPrimeiroFrame) / 1000;
      const frames = ultimo - primeiro;
      resolve({
        modo,
        code,
        erro,
        totalSeg: (Date.now() - inicio) / 1000,
        renderSeg: seg,
        frames,
        fps: seg > 0 ? frames / seg : 0,
        saida,
      });
    });
  });
}

const job = acharJob();
if (!job) {
  console.error("Nenhum job com props.json encontrado. Exporte um projeto uma vez pela interface e rode de novo.");
  process.exit(1);
}

const srv = await conferirServidor(job.props);
if (!srv.ok) {
  console.error(`O dev server em ${srv.base} nao respondeu. Ele serve os assets do render — suba-o antes de medir.`);
  process.exit(1);
}

console.log(`Job:         ${job.id}`);
console.log(`Composicao:  ${COMPOSITION}`);
console.log(`Frames:      ${FRAMES}`);
console.log(`Modos:       ${MODOS.join(", ")}`);
console.log("");
console.log("Rode isto com a maquina OCIOSA: qualquer outro render em paralelo invalida a comparacao.\n");

const resultados = [];
for (const modo of MODOS) {
  console.log(`--- ${modo} ---`);
  const r = await rodar(modo, job);
  resultados.push(r);
  if (r.code !== 0) {
    console.log(`  FALHOU (codigo ${r.code}) ${r.erro ? "- " + r.erro : ""}`);
  } else {
    console.log(`  ${r.frames} frames em ${r.renderSeg.toFixed(1)}s = ${r.fps.toFixed(3)} fps (total ${r.totalSeg.toFixed(1)}s com bundling)`);
  }
}

console.log("\n=== RESULTADO ===");
const ok = resultados.filter((r) => r.code === 0 && r.fps > 0);
for (const r of ok) console.log(`${r.modo.padEnd(10)} ${r.fps.toFixed(3)} fps`);

if (ok.length === 2) {
  const [a, b] = ok;
  const ganho = ((b.fps / a.fps) - 1) * 100;
  console.log("");
  if (Math.abs(ganho) < 10) {
    console.log(`Diferenca de ${ganho.toFixed(1)}% — dentro do ruido. O driver provavelmente caiu de volta para software: nao vale trocar.`);
  } else if (ganho > 0) {
    console.log(`${b.modo} foi ${ganho.toFixed(1)}% mais rapido. Vale usar: defina REMOTION_GL=${b.modo} no .env e confira um render inteiro antes de adotar.`);
  } else {
    console.log(`${b.modo} foi ${Math.abs(ganho).toFixed(1)}% MAIS LENTO. Manter ${a.modo}.`);
  }
  console.log("\nConfira tambem os dois mp4 lado a lado antes de decidir — o modo GL pode mudar sutilmente o antialiasing:");
  for (const r of ok) console.log(`  ${r.saida}`);
}
