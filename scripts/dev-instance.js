#!/usr/bin/env node
/**
 * Sobe uma instancia local do app, auto-detectando o proximo slot livre.
 * Cada clique no atalho abre uma instancia nova sem precisar digitar nada.
 * Instancia 1 usa porta/JOBS_DIR padrao do .env; a partir da 2a usa
 * JOBS_DIR isolado (./jobs-instanceN) pra nao conflitar arquivos de job.
 *
 * Usa lockfile (nao porta TCP) pra decidir o slot: o Next.js demora alguns
 * segundos pra de fato bindar a porta apos o processo subir, entao checar
 * porta livre sozinho tem race condition se o usuario clicar 2x rapido.
 * Criar arquivo com flag "wx" (falha se ja existe) e imediato/atomico.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const BASE_PORT = parseInt(process.env.PORT || "3000", 10);
const MAX_INSTANCES = 20;
const LOCK_DIR = path.join(__dirname, ".instance-locks");

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function claimSlot() {
  fs.mkdirSync(LOCK_DIR, { recursive: true });

  for (let n = 1; n <= MAX_INSTANCES; n++) {
    const lockFile = path.join(LOCK_DIR, `instance-${n}.lock`);

    if (fs.existsSync(lockFile)) {
      const pid = parseInt(fs.readFileSync(lockFile, "utf-8").trim(), 10);
      if (isPidAlive(pid)) continue; // slot em uso de verdade
      fs.unlinkSync(lockFile); // lock orfao (processo morreu sem limpar)
    }

    try {
      // wx: falha se outro processo criou o arquivo entre o existsSync e aqui
      const fd = fs.openSync(lockFile, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return { n, lockFile };
    } catch {
      continue; // outro processo ganhou esse slot, tenta o proximo
    }
  }

  throw new Error(`Nenhum slot livre entre 1 e ${MAX_INSTANCES}`);
}

function main() {
  const { n, lockFile } = claimSlot();
  const port = BASE_PORT + n - 1;
  const env = { ...process.env };

  if (n > 1) {
    env.PORT = String(port);
    env.JOBS_DIR = `./jobs-instance${n}`;
  }

  const cleanup = () => {
    try { fs.unlinkSync(lockFile); } catch {}
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  console.log(`[dev-instance] instancia ${n} -> http://localhost:${port}${n > 1 ? ` (JOBS_DIR=./jobs-instance${n})` : ""}`);

  // Se o launcher (.bat) passou um token, escreve a porta escolhida num
  // arquivo que ele fica esperando aparecer, pra saber em qual porta abrir
  // o navegador (a porta so e decidida aqui dentro, dinamicamente).
  if (process.env.INSTANCE_TOKEN) {
    const tokenFile = path.join(LOCK_DIR, `token-${process.env.INSTANCE_TOKEN}.port`);
    fs.writeFileSync(tokenFile, String(port));
    process.on("exit", () => { try { fs.unlinkSync(tokenFile); } catch {} });
  }

  const child = spawn("npm", ["run", "dev", "--workspace=@pontob/web"], {
    cwd: path.resolve(__dirname, ".."),
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  child.on("exit", (code) => process.exit(code ?? 0));
}

main();
