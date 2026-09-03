import { z } from "zod";

/**
 * Formato "Tela dividida" — schema e configuração.
 *
 * O vídeo inteiro fica dividido: o especialista ocupa uma metade e uma
 * sequência de inserts (imagens do tema) ocupa a outra. A orientação da divisão
 * é derivada do aspect ratio no render (vertical no 9:16 e 1:1, horizontal no
 * 16:9), não é gravada aqui.
 *
 * O Claude produz o PLANO de inserts (intervalos + termo de busca). O motor de
 * inserts (Pexels, com fallback de IA na fase 2) preenche `image_url`.
 * Módulo puro — sem React / sem Remotion.
 */

export const FORMATOS = ["cenas", "tela_dividida", "aula", "narrado"] as const;
export type Formato = (typeof FORMATOS)[number];

// ── Formato "Aula" ───────────────────────────────────────────────────────────
// A gravação já traz slide (tela cheia) + câmera do especialista num PiP. A
// edição recorta as duas regiões do MESMO vídeo e monta um split: slide
// dominante + especialista ampliado. Regiões em frações (0–1) da fonte.

export const RegiaoSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});
export type Regiao = z.infer<typeof RegiaoSchema>;

export const AulaConfigSchema = z.object({
  // Recorte da câmera do especialista (PiP). Default = layout do VG/Oregon.
  camera_regiao: RegiaoSchema.default({ x: 0.008, y: 0.319, w: 0.175, h: 0.333 }),
  // Recorte do slide (exclui a faixa onde fica o PiP). Default = direita do PiP.
  slide_regiao: RegiaoSchema.default({ x: 0.1875, y: 0, w: 0.8125, h: 1 }),
  // Antes deste instante a câmera está em tela cheia (intro) — mostra o vídeo
  // inteiro; a partir dele entra o split slide+especialista.
  slide_inicio_segundos: z.number().min(0).default(0),
  // Proporção da metade do SLIDE (dominante), em %. Resto é o especialista.
  split_pct: z.number().min(40).max(80).default(60),
  // Aspect ratio da gravação (para o recorte). Default 16:9.
  source_aspect: z.number().positive().default(16 / 9),
});
export type AulaConfig = z.infer<typeof AulaConfigSchema>;

// Um insert = um asset do tema (imagem OU vídeo b-roll) cobrindo um bloco.
export const InsertSchema = z.object({
  inicio: z.number().min(0), // segundos, na linha do tempo do vídeo bruto
  fim: z.number().min(0),
  // Termo de busca gerado pelo Claude (o que mostrar naquele bloco).
  query: z.string().min(1),
  // Descrição/legenda opcional do que a imagem representa.
  descricao: z.string().optional(),
  // Tipo do asset. "video" => usa video_url (b-roll mudo); senão image_url.
  tipo: z.enum(["imagem", "video"]).default("imagem"),
  // Preenchido pelo motor de inserts: URL http servida ou caminho local do asset.
  image_url: z.string().optional(),
  // Preenchido quando tipo="video": rota que serve o mp4 do b-roll.
  video_url: z.string().optional(),
  // Texto curto (dado/fato recente) renderizado como overlay sobre o insert.
  // Preenchido pelo plano quando há um número/fato relevante. Copyright-safe:
  // é texto, não imagem de terceiro. Ver planejarInserts (busca web).
  overlay_texto: z.string().optional(),
  // Origem do asset e crédito (atribuição da fonte, quando houver).
  // "web" = imagem de busca web/notícia (SerpAPI/Google CSE) — atribuição no crédito.
  fonte: z.enum(["pexels", "pexels_video", "openverse", "wikimedia", "web", "ia", "manual"]).optional(),
  credito: z.string().optional(),
});
export type Insert = z.infer<typeof InsertSchema>;

// ── CTA final (tela de encerramento) ─────────────────────────────────────────
// Aparece no FIM dos formatos novos (aula/tela dividida/narrado): logo do
// evento (enviada pelo usuário) + copy editável. Estende a duração do reel.
export const CtaFinalSchema = z.object({
  ativo: z.boolean().default(true),
  copy: z.string().default(""),
  // URL da logo (servida pelo job após upload). Opcional.
  logo_url: z.string().optional(),
  // Fundo do CTA: foto do tema (mercado/nicho) buscada no processamento. A chave
  // é "image_url" de propósito — o render (substituirVideoPaths) já converte
  // image_url relativo → absoluto automaticamente. Sem isso, cai no gradiente navy.
  image_url: z.string().optional(),
  duracao_segundos: z.number().min(1).max(12).default(4),
});
export type CtaFinal = z.infer<typeof CtaFinalSchema>;

// ── Formato "Narrado" ────────────────────────────────────────────────────────
// A voz do especialista conduz e os inserts cobrem a tela inteira. Reusa o
// mesmo Insert (plano do Claude + busca no Pexels). Onde falta insert, o vídeo
// do especialista aparece por baixo como fallback.
export const NarradoConfigSchema = z.object({
  inserts: z.array(InsertSchema).default([]),
});
export type NarradoConfig = z.infer<typeof NarradoConfigSchema>;

export const TelaDivididaConfigSchema = z.object({
  // "inicio" = especialista em cima (vertical) / à esquerda (horizontal).
  // "fim"    = especialista embaixo (vertical) / à direita (horizontal).
  especialista_posicao: z.enum(["inicio", "fim"]).default("inicio"),
  // Proporção da metade do especialista, em % (30–70).
  split_pct: z.number().min(30).max(70).default(55),
  inserts: z.array(InsertSchema).default([]),
});
export type TelaDivididaConfig = z.infer<typeof TelaDivididaConfigSchema>;

// Plano de inserts produzido pelo Claude (antes de buscar as imagens).
// Cada item = um bloco de assunto: intervalo + termo de busca + descrição.
export const InsertPlanoItemSchema = z.object({
  inicio: z.number().min(0),
  fim: z.number().min(0),
  // Termo de busca em INGLÊS, concreto e "fotografável" em banco de stock
  // (ex: "stock market chart", "doctor office", "healthy food").
  query: z.string().min(1),
  // Descrição em PT do que a imagem representa (para o editor entender).
  descricao: z.string().optional(),
  // true quando o bloco fala de algo REAL e nomeável (pessoa, lugar, empresa,
  // evento) — nesses casos o motor tenta fonte CC (Openverse) antes do stock.
  preferir_real: z.boolean().optional(),
  // Dado/fato/número recente relevante ao bloco, para renderizar como texto
  // sobre o insert. Preenchido pela busca web na Etapa B; opcional.
  overlay_texto: z.string().optional(),
});
export type InsertPlanoItem = z.infer<typeof InsertPlanoItemSchema>;

export const PlanoInsertsSchema = z.object({
  inserts: z.array(InsertPlanoItemSchema).min(1),
});
export type PlanoInserts = z.infer<typeof PlanoInsertsSchema>;

// Insert ativo em um instante t (segundos). Último cujo início já passou.
export function insertAtivo(inserts: Insert[], t: number): Insert | null {
  let atual: Insert | null = null;
  for (const ins of inserts) {
    if (ins.inicio <= t) atual = ins;
    else break;
  }
  return atual;
}
