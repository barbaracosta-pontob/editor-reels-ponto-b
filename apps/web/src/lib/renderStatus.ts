/**
 * Estado de render persistido em disco (jobs/<id>/render-status.json).
 *
 * POR QUE ISSO EXISTE
 * -------------------
 * Antes o progresso do render vivia SO no stream SSE que o navegador abria.
 * Se a aba entrasse em Back-Forward Cache (minimizar, trocar de aba, maquina
 * dormir), o Chrome congelava o stream: o `reader.read()` do cliente nunca
 * mais resolvia E nunca rejeitava - a UI ficava pendurada pra sempre enquanto
 * o Remotion terminava normalmente e escrevia o mp4 em disco. Nao havia como
 * reconectar porque nao existia estado nenhum fora daquela conexao.
 *
 * Agora o render roda desacoplado da request e escreve o progresso aqui. A UI
 * so faz polling deste arquivo - fechar a aba, dar F5 ou dormir a maquina nao
 * perde mais nada.
 */

import { readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export type RenderPhase = "queued" | "bundling" | "rendering" | "encoding";
export type RenderState = "running" | "done" | "error";

export interface RenderStatus {
  status: RenderState;
  /** Formatos pedidos nesta execucao, na ordem. */
  formatos: string[];
  /** Formato sendo renderizado agora. */
  format?: string;
  /** Label amigavel do formato atual ("9:16 Reels"). */
  formatLabel?: string;
  phase: RenderPhase;
  /** Texto explicando a espera quando phase === "queued". */
  filaInfo?: string;
  frames: number;
  total: number;
  eta: string;
  /** Caminhos finais por formato - preenchido conforme cada um termina. */
  outputs: Record<string, string>;
  error?: string;
  /** PID do processo do render (para detectar orfao). Shell no Windows. */
  pid?: number;
  startedAt: number;
  updatedAt: number;
}

export const RENDER_STATUS_FILE = "render-status.json";

export function statusPath(jobDir: string): string {
  return path.join(jobDir, RENDER_STATUS_FILE);
}

/**
 * Escrita atomica: grava num .tmp e renomeia. Sem isso, um GET /status que
 * caia exatamente no meio do write le JSON truncado e quebra o polling.
 */
export async function writeStatus(jobDir: string, status: RenderStatus): Promise<void> {
  const dest = statusPath(jobDir);
  const tmp = `${dest}.tmp`;
  await writeFile(tmp, JSON.stringify(status, null, 2), "utf-8");
  await rename(tmp, dest);
}

export async function readStatus(jobDir: string): Promise<RenderStatus | null> {
  const file = statusPath(jobDir);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, "utf-8")) as RenderStatus;
  } catch {
    // Arquivo sendo reescrito nesse instante - o proximo poll pega.
    return null;
  }
}

/** true se o processo ainda existe. `kill(pid, 0)` nao envia sinal, so testa. */
export function processoVivo(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
