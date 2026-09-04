import { z } from "zod";
import { LegendaConfigSchema, LegendaPalavraSchema } from "./captions";
import { FORMATOS, TelaDivididaConfigSchema, AulaConfigSchema, NarradoConfigSchema, CtaFinalSchema, CaixinhaPerguntaSchema } from "./split";

// Reexporta os módulos de legenda e de formatos (schemas, tipos e helpers puros)
// para que consumidores importando "@pontob/schema" tenham tudo num ponto só.
export * from "./captions";
export * from "./split";

export const WordHighlightSchema = z.object({
  palavra: z.string().min(1),
  cor: z.string().min(1),  // hex, ex: "#E63946"
});
export type WordHighlight = z.infer<typeof WordHighlightSchema>;

export const SfxSchema = z.object({
  path: z.string().min(1),                        // ex: "sfx/whoosh.mp3"
  volume: z.number().min(0).max(10).default(5),   // default 5 (50% do máximo)
  inicio_segundos: z.number().min(0).optional(),  // offset dentro da cena
  fim_segundos: z.number().min(0).optional(),     // corta o som nesse ponto
});
export type Sfx = z.infer<typeof SfxSchema>;


export const HookSchema = z.object({
  tipo: z.literal("Hook"),
  titulo: z.string().min(1).max(120),
  subtitulo: z.string().max(80).optional(),
  palavras_destacadas: z.array(WordHighlightSchema).max(3),
  sfx: SfxSchema.optional(),
  duracao_segundos: z.number().min(2).max(8),
  animacao_entrada: z.enum(["spring", "fade", "slide"]).optional(),
  inicio_overlay_segundos: z.number().min(0).optional(),
});
export type Hook = z.infer<typeof HookSchema>;

export const FraseImpactoSchema = z.object({
  tipo: z.literal("FraseImpacto"),
  texto: z.string().min(1).max(200),
  palavras_destacadas: z.array(WordHighlightSchema).max(3).optional(),
  alinhamento: z.enum(["centro", "esquerda"]).optional(),
  sfx: SfxSchema.optional(),
  duracao_segundos: z.number().min(3).max(10),
  fundo: z.enum(["navy", "preto", "gradiente"]).optional(),
  inicio_overlay_segundos: z.number().min(0).optional(),
});
export type FraseImpacto = z.infer<typeof FraseImpactoSchema>;

export const ComparativoNumericoLadoSchema = z.object({
  valor: z.union([z.number(), z.string()]),
  rotulo: z.string().min(1).max(40),
  eh_destaque: z.boolean().optional(),
});

export const ComparativoNumericoSchema = z.object({
  tipo: z.literal("ComparativoNumerico"),
  metrica_nome: z.string().min(1).max(80),
  metrica_unidade: z.string().min(1).max(20),
  lados: z.array(ComparativoNumericoLadoSchema).min(2).max(3),
  visualizacao: z.enum(["barras", "numeros_grandes", "bonecos"]),
  duracao_segundos: z.number().min(4).max(10),
  cor_destaque: z.string().optional(),  // hex livre, ex: "#E63946"
  sfx: SfxSchema.optional(),
  inicio_overlay_segundos: z.number().min(0).optional(),
});
export type ComparativoNumerico = z.infer<typeof ComparativoNumericoSchema>;

export const VideoCitacaoSchema = z.object({
  tipo: z.literal("VideoCitacao"),
  duracao_segundos: z.number().min(5).max(18),
  nome_mentor: z.string().min(1),
  cargo_mentor: z.string().min(1),
  frases: z.array(z.string().min(1).max(80)).min(1).max(3),
  estilo_lower_third: z.enum(["barra_inferior", "card_lateral"]).optional(),
  sfx: SfxSchema.optional(),
  inicio_overlay_segundos: z.number().min(0).optional(),
});
export type VideoCitacao = z.infer<typeof VideoCitacaoSchema>;

export const ListaPontosSchema = z.object({
  tipo: z.literal("ListaPontos"),
  titulo: z.string().max(60).optional(),
  pontos: z.array(z.string().min(1).max(60)).min(2).max(5),
  numerado: z.boolean().optional(),
  sfx: SfxSchema.optional(),
  duracao_segundos: z.number().min(5).max(15),
  fundo: z.enum(["navy", "preto", "gradiente"]).optional(),
  inicio_overlay_segundos: z.number().min(0).optional(),
});
export type ListaPontos = z.infer<typeof ListaPontosSchema>;

export const MiniCasoSchema = z.object({
  tipo: z.literal("MiniCaso"),
  duracao_segundos: z.number().min(5).max(15),
  resultado_texto: z.string().min(1).max(100),
  contexto_texto: z.string().max(80).optional(),
  palavras_destacadas: z.array(WordHighlightSchema).max(3).optional(),
  sfx: SfxSchema.optional(),
  inicio_overlay_segundos: z.number().min(0).optional(),
});
export type MiniCaso = z.infer<typeof MiniCasoSchema>;

export const TransicaoTextoSchema = z.object({
  tipo: z.literal("TransicaoTexto"),
  texto: z.string().min(1).max(60),
  sfx: SfxSchema.optional(),
  duracao_segundos: z.number().min(1).max(4),
  fundo: z.enum(["navy", "preto", "gradiente"]).optional(),
  inicio_overlay_segundos: z.number().min(0).optional(),
});
export type TransicaoTexto = z.infer<typeof TransicaoTextoSchema>;

export const CTASchema = z.object({
  tipo: z.literal("CTA"),
  texto_principal: z.string().min(1).max(80),
  texto_secundario: z.string().max(80).optional(),
  palavras_destacadas: z.array(WordHighlightSchema).max(3).optional(),
  duracao_segundos: z.number().min(3).max(15),
  mostrar_seta: z.boolean().optional(),
  cor_seta: z.string().optional(),  // hex livre, ex: "#F4C430"
  sfx: SfxSchema.optional(),
  inicio_overlay_segundos: z.number().min(0).optional(),
});
export type CTA = z.infer<typeof CTASchema>;

export const ConviteEventoSchema = z.object({
  tipo: z.literal("ConviteEvento"),
  nome_evento: z.string().min(1).max(60),
  descricao: z.string().max(80).optional(),
  bullets: z.array(z.string().min(1).max(60)).min(1).max(4),
  duracao_segundos: z.number().min(5).max(12),
  fundo: z.enum(["navy", "preto", "gradiente"]).optional(),
  logo_url: z.string().url().optional(),
  logo_altura: z.number().min(24).max(1080).optional(),
  logo_posicao: z.enum(["topo", "centro", "rodape"]).optional(),
  sfx: SfxSchema.optional(),
  inicio_overlay_segundos: z.number().min(0).optional(),
});
export type ConviteEvento = z.infer<typeof ConviteEventoSchema>;

export const GraficoLinhaPontoSchema = z.object({
  rotulo: z.string().min(1).max(20),
  valor: z.number(),
});

export const GraficoLinhaSchema = z.object({
  tipo: z.literal("GraficoLinha"),
  titulo: z.string().min(1).max(80),
  subtitulo: z.string().max(80).optional(),
  unidade: z.string().max(10).optional(),
  pontos: z.array(GraficoLinhaPontoSchema).min(2).max(12),
  mostrar_area: z.boolean().optional(),
  cor_primaria: z.string().optional(),
  cor_secundaria: z.string().optional(),
  sfx: SfxSchema.optional(),
  duracao_segundos: z.number().min(4).max(12),
  inicio_overlay_segundos: z.number().min(0).optional(),
});
export type GraficoLinha = z.infer<typeof GraficoLinhaSchema>;
export type GraficoLinhaPonto = z.infer<typeof GraficoLinhaPontoSchema>;

export const GraficoBarraPontoSchema = z.object({
  rotulo: z.string().min(1).max(24),
  valor: z.number(),
  valor_display: z.string().max(20).optional(),
  eh_destaque: z.boolean().optional(),
});

export const GraficoBarraSchema = z.object({
  tipo: z.literal("GraficoBarra"),
  titulo: z.string().min(1).max(80),
  subtitulo: z.string().max(80).optional(),
  unidade: z.string().max(10).optional(),
  barras: z.array(GraficoBarraPontoSchema).min(2).max(6),
  cor_primaria: z.string().optional(),
  cor_secundaria: z.string().optional(),
  sfx: SfxSchema.optional(),
  duracao_segundos: z.number().min(4).max(12),
  inicio_overlay_segundos: z.number().min(0).optional(),
});
export type GraficoBarra = z.infer<typeof GraficoBarraSchema>;
export type GraficoBarraPonto = z.infer<typeof GraficoBarraPontoSchema>;

// VideoSimples: janela de "respiração" — só o vídeo do mentor sem overlay de texto.
// Use quando o mentor está falando mas não há conteúdo que justifique um overlay.
export const VideoSimplesSchema = z.object({
  tipo: z.literal("VideoSimples"),
  video_path: z.string().min(1),
  start_segundos: z.number().min(0),
  duracao_segundos: z.number().min(2).max(20),
  sfx: SfxSchema.optional(),
});
export type VideoSimples = z.infer<typeof VideoSimplesSchema>;

export const CenaSchema = z.discriminatedUnion("tipo", [
  HookSchema,
  FraseImpactoSchema,
  ComparativoNumericoSchema,
  VideoCitacaoSchema,
  ListaPontosSchema,
  MiniCasoSchema,
  TransicaoTextoSchema,
  CTASchema,
  ConviteEventoSchema,
  GraficoLinhaSchema,
  GraficoBarraSchema,
  VideoSimplesSchema,
]);
export type Cena = z.infer<typeof CenaSchema>;

export const MusicaFundoSchema = z.object({
  path: z.string().min(1),          // ex: "musica/lofi-beat.mp3"
  volume: z.number().min(0).max(10).optional(),  // 0-10, default 3
});
export type MusicaFundo = z.infer<typeof MusicaFundoSchema>;

export const ReelPropsSchema = z
  .object({
    // Aceita reels curtos quando o video bruto e curto (ex: video de 30s -> reel de 30s).
    // O teto fisico (videoDuration) e aplicado em runtime pelo clampReelToVideoDuration.
    duracao_total_estimada: z.number().min(5).max(120),
    video_original_path: z.string().optional(),
    // Ponto exato (em segundos) onde o vídeo de fundo começa a tocar.
    // Separado do início de cada cena/overlay — permite editar quando cada
    // componente entra sem mover o vídeo subjacente.
    video_start_segundos: z.number().min(0).optional(),
    // Ponto de corte final do vídeo bruto (em segundos a partir do início do arquivo).
    // Se definido, o vídeo de fundo para nesse ponto. Permite trim de cauda sem afetar os overlays.
    video_end_segundos: z.number().min(0).optional(),
    cenas: z.array(CenaSchema).min(4).max(15),
    cor_primaria: z.string().optional(),
    cor_secundaria: z.string().optional(),
    fonte_url: z.string().optional(),
    fonte_familia: z.string().optional(),
    musica_fundo: MusicaFundoSchema.optional(),
    // Legenda contínua (opcional). `legenda` = configuração escolhida no editor;
    // `legenda_palavras` = timestamps palavra-a-palavra derivados do transcript.
    // Quando ausente ou `ativa: false`, nenhuma legenda é renderizada.
    legenda: LegendaConfigSchema.optional(),
    legenda_palavras: z.array(LegendaPalavraSchema).optional(),
    // Formato de edição do reel. "cenas" = timeline de cenas (padrão atual);
    // "tela_dividida" = especialista numa metade + inserts do tema na outra.
    formato: z.enum(FORMATOS).optional(),
    tela_dividida: TelaDivididaConfigSchema.optional(),
    aula: AulaConfigSchema.optional(),
    narrado: NarradoConfigSchema.optional(),
    cta_final: CtaFinalSchema.optional(),
    // Caixinha de pergunta (sticker do Instagram). Overlay opcional em qualquer
    // formato; no formato "caixinha_pergunta" é o elemento central da edição.
    caixinha: CaixinhaPerguntaSchema.optional(),
  })
  .strict();

export type ReelProps = z.infer<typeof ReelPropsSchema>;
