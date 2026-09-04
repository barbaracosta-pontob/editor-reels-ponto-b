/**
 * Fila serial de render — um render por vez NA MAQUINA.
 *
 * POR QUE ISSO EXISTE
 * -------------------
 * Medicao de 04/09/2026 sobre todos os render-*.log do repositorio: a mediana
 * de fps de um render varia de 0.152 a 1.755 e a dispersao DENTRO de cada nivel
 * de concorrencia e maior que a diferenca ENTRE os niveis. Ou seja, o que
 * determina a velocidade nao e o `setConcurrency` — e quantas abas de Chromium
 * headless estao disputando os 2 nucleos fisicos da maquina naquele instante.
 *
 * Com 2 renders simultaneos o throughput agregado foi ~1.72 fps; com 4, ~0.51.
 * Mais paralelismo entregou MENOS video por hora. Serializar nao acelera um
 * render isolado, mas acaba com a dispersao e faz o primeiro arquivo ficar
 * pronto em ~40min em vez de todos em ~4h.
 *
 * O lock vive em disco na raiz do repo porque o usuario roda VARIAS instancias
 * do Next (jobs/, jobs-instance2/, ...) em portas diferentes. Um Set em memoria
 * so serializaria dentro de um processo — exatamente o caso que nao acontece.
 */

import { writeFileSync, readFileSync, existsSync, unlinkSync, openSync, closeSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./jobsDir";

const LOCK_FILE = path.join(REPO_ROOT, ".render-lock.json");

/** De quanto em quanto tempo o dono do lock renova o updatedAt. */
const HEARTBEAT_MS = 10_000;
/** Sem heartbeat por mais que isso, o lock e considerado abandonado. */
const STALE_MS = 45_000;
/** Intervalo de tentativa de quem esta na fila. */
const POLL_MS = 2_000;

interface Lock {
  jobId: string;
  /** PID do processo Next que segura o lock (nao do Remotion). */
  pid: number;
  acquiredAt: number;
  updatedAt: number;
}

function lerLock(): Lock | null {
  if (!existsSync(LOCK_FILE)) return null;
  try {
    return JSON.parse(readFileSync(LOCK_FILE, "utf-8")) as Lock;
  } catch {
    // Sendo reescrito neste instante — trata como ocupado; o proximo poll le.
    return null;
  }
}

function pidVivo(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Um lock so vale se o dono existe E deu sinal recentemente. */
function lockVivo(l: Lock): boolean {
  return pidVivo(l.pid) && Date.now() - l.updatedAt < STALE_MS;
}

function gravar(l: Lock): void {
  writeFileSync(LOCK_FILE, JSON.stringify(l, null, 2), "utf-8");
}

/**
 * Tenta pegar o lock. Retorna o registro gravado, ou o lock alheio que barrou.
 *
 * O caminho feliz usa `openSync(..., "wx")`, que e create-exclusive atomico: se
 * duas instancias tentarem ao mesmo tempo, so uma cria o arquivo. O caminho de
 * roubo (dono morto ou sem heartbeat) nao e atomico, entao quem rouba confere
 * depois se continua sendo o dono.
 */
function tentar(jobId: string): { ok: true; lock: Lock } | { ok: false; dono: Lock | null } {
  const agora = Date.now();
  const meu: Lock = { jobId, pid: process.pid, acquiredAt: agora, updatedAt: agora };

  try {
    const fd = openSync(LOCK_FILE, "wx");
    closeSync(fd);
    gravar(meu);
    return { ok: true, lock: meu };
  } catch {
    // Arquivo ja existe.
  }

  const dono = lerLock();
  if (dono && lockVivo(dono)) return { ok: false, dono };

  // Dono morto ou sem heartbeat: rouba e confirma.
  gravar(meu);
  const conf = lerLock();
  if (conf && conf.pid === meu.pid && conf.acquiredAt === meu.acquiredAt) {
    return { ok: true, lock: meu };
  }
  return { ok: false, dono: conf };
}

export interface EsperaInfo {
  /** Job que esta segurando a fila, se der pra saber. */
  donoJobId?: string;
  /** Segundos que este job ja esperou. */
  esperandoHa: number;
}

/**
 * Espera a vez e devolve a funcao de liberacao. SEMPRE chamar a liberacao num
 * `finally` — um lock nao liberado trava toda a maquina ate expirar o STALE_MS.
 *
 * `aoEsperar` e chamado a cada tentativa frustrada, para a UI conseguir mostrar
 * "aguardando outro render" em vez de uma tela parada.
 */
export async function adquirirLock(
  jobId: string,
  aoEsperar?: (info: EsperaInfo) => void,
): Promise<() => void> {
  const inicio = Date.now();

  for (;;) {
    const r = tentar(jobId);
    if (r.ok) {
      const bater = setInterval(() => {
        const atual = lerLock();
        // So renova se ainda for meu. Se alguem roubou (eu travei alem do
        // STALE_MS), nao reescreve por cima do novo dono.
        if (atual && atual.pid === process.pid && atual.jobId === jobId) {
          gravar({ ...atual, updatedAt: Date.now() });
        }
      }, HEARTBEAT_MS);
      if (typeof bater.unref === "function") bater.unref();

      let liberado = false;
      return () => {
        if (liberado) return;
        liberado = true;
        clearInterval(bater);
        try {
          const atual = lerLock();
          if (!atual || (atual.pid === process.pid && atual.jobId === jobId)) {
            unlinkSync(LOCK_FILE);
          }
        } catch { /* ja removido */ }
      };
    }

    aoEsperar?.({
      donoJobId: r.dono?.jobId,
      esperandoHa: Math.round((Date.now() - inicio) / 1000),
    });
    await new Promise((res) => setTimeout(res, POLL_MS));
  }
}

/** Estado da fila para diagnostico (usado pela home e por scripts). */
export function lockAtual(): Lock | null {
  const l = lerLock();
  return l && lockVivo(l) ? l : null;
}
