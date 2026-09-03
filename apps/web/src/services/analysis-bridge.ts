/**
 * Bridge entre o app Next.js e o serviço de análise.
 *
 * O Next.js roda em CommonJS/ESM híbrido. O serviço de análise é ESM puro.
 * Este arquivo importa diretamente do source TypeScript via tsx/ts-node,
 * que o Next.js resolve corretamente no servidor.
 *
 * Em produção (build), o tsx compila antes. Em dev, o Next.js usa o
 * transpiler nativo do Node 22 para .ts.
 */

export { analyze, refine, AnalysisError, planejarInserts } from "../../../../services/analysis/src/claude";
export type { AnalyzeParams, AnalyzeResult, RefineParams, PlanejarInsertsParams } from "../../../../services/analysis/src/claude";
