/**
 * Resolucao de jobs ACROSS instancias.
 *
 * O PROBLEMA
 * ----------
 * Cada instancia do editor sobe com um JOBS_DIR proprio (./jobs,
 * ./jobs-instance2, ./jobs-instance3...) para que dois servidores nao
 * disputem os mesmos arquivos. O efeito colateral era que a lista /jobs
 * mostrava SO os jobs criados naquela porta: um job feito no localhost:3002
 * ficava invisivel no localhost:3004, e voltar num trabalho antigo exigia
 * lembrar em qual aba ele tinha nascido.
 *
 * A SOLUCAO
 * ---------
 * Isolamento na ESCRITA, visao unica na LEITURA. Jobs novos continuam
 * nascendo no JOBS_DIR da instancia (isso e o que evita colisao). Mas
 * localizar um job existente passa a varrer todos os diretorios jobs*, e a
 * listagem junta todos. Um job aberto de outra instancia funciona
 * normalmente: as rotas leem e escrevem no diretorio onde ele realmente
 * esta, nao no da instancia atual.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export const REPO_ROOT = path.resolve(process.cwd(), "../..");

/** Diretorio de jobs desta instancia. E onde jobs NOVOS sao criados. */
export const JOBS_DIR = process.env.JOBS_DIR
  ? path.resolve(REPO_ROOT, process.env.JOBS_DIR)
  : path.join(REPO_ROOT, "jobs");

/**
 * Todos os diretorios de jobs do repo, comecando pelo desta instancia.
 * A ordem importa: em caso de id repetido entre instancias (improvavel com
 * uuid de 8 chars, mas nao impossivel), o job local ganha.
 */
export function todosJobsDirs(): string[] {
  const dirs = new Set<string>([JOBS_DIR]);
  try {
    for (const nome of readdirSync(REPO_ROOT)) {
      if (nome !== "jobs" && !nome.startsWith("jobs-instance")) continue;
      const p = path.join(REPO_ROOT, nome);
      if (statSync(p).isDirectory()) dirs.add(p);
    }
  } catch {
    // Sem permissao de leitura na raiz: cai para o diretorio local apenas.
  }
  return [...dirs];
}

/**
 * Caminho do job, procurando em todas as instancias.
 * Retorna null se o job nao existe em lugar nenhum.
 *
 * Um job so conta se tiver scenes.json: e o que separa um job de verdade de
 * um diretorio pela metade (upload interrompido) ou do cache de transcricao.
 */
export function acharJobDir(jobId: string): string | null {
  // Barra travessia de caminho: o id vem da URL.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(jobId)) return null;
  for (const base of todosJobsDirs()) {
    const dir = path.join(base, jobId);
    if (existsSync(path.join(dir, "scenes.json"))) return dir;
  }
  return null;
}

/**
 * Como acharJobDir, mas cai no diretorio local quando o job ainda nao existe.
 * Use nas rotas que CRIAM coisa (ex.: primeiro salvamento de cenas); as que
 * so leem devem tratar o null como 404.
 */
export function jobDirOuLocal(jobId: string): string {
  return acharJobDir(jobId) ?? path.join(JOBS_DIR, jobId);
}

/** Nome curto da instancia dona do job ("jobs", "jobs-instance3"). */
export function instanciaDoJob(jobDir: string): string {
  return path.basename(path.dirname(jobDir));
}
