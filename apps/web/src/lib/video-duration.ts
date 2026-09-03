/**
 * Helper para obter a duração real do arquivo de vídeo via ffprobe.
 * Centraliza a chamada para evitar divergência entre rotas que precisam
 * desse valor (analise, refinamento, GET do job).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";

const execFileAsync = promisify(execFile);

export async function getVideoDuration(videoPath: string): Promise<number | null> {
  if (!existsSync(videoPath)) return null;
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ]);
    const d = parseFloat(stdout.trim());
    return isNaN(d) ? null : Math.round(d * 10) / 10;
  } catch {
    return null;
  }
}
