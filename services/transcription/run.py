"""
Transcrição com faster-whisper — word-level timestamps em PT-BR.

Uso:
    python run.py --input video.mp4 --output transcript.json [--model large-v3] [--device auto]

Saída: JSON com segments + words timestampados, pronto para alimentar a etapa de análise Claude.
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

from faster_whisper import WhisperModel


def detectar_device() -> str:
    """
    Decide entre "cuda" e "cpu" perguntando ao CTranslate2 - que e quem de fato
    executa o modelo do faster-whisper.

    POR QUE MUDOU (2026-09-03)
    --------------------------
    A versao anterior testava `torch.cuda.is_available()` dentro de um
    try/except ImportError. Mas o torch NUNCA foi dependencia deste servico:
    nao esta no requirements.txt nem instalado na .venv. Ou seja, o import
    falhava sempre, caia no except e cravava "cpu" - mesmo numa maquina com
    GPU NVIDIA ociosa ao lado. As 40 transcricoes do historico do projeto
    rodaram todas em cpu/int8, a ~0.17x realtime (45s de audio = ~4 minutos).

    `get_cuda_device_count()` vem do proprio ctranslate2, que ja e dependencia,
    e responde a pergunta certa: existe GPU que ESTE runtime consegue usar.
    """
    forcado = os.getenv("WHISPER_DEVICE", "").strip().lower()
    if forcado in ("cpu", "cuda"):
        return forcado
    try:
        from ctranslate2 import get_cuda_device_count

        n = get_cuda_device_count()
        if n > 0:
            print(f"[transcribe] {n} GPU(s) CUDA disponivel(is)", file=sys.stderr)
            return "cuda"
        print("[transcribe] nenhuma GPU CUDA visivel para o CTranslate2", file=sys.stderr)
    except Exception as e:
        print(f"[transcribe] deteccao de CUDA falhou ({e})", file=sys.stderr)
    return "cpu"


def threads_cpu() -> int:
    """
    Threads de computacao para o CTranslate2.

    O default do CTranslate2 e 4 threads, independente do tamanho da maquina.
    Num processador de 8+ nucleos isso deixa metade da CPU parada durante a
    transcricao. Usamos metade dos nucleos logicos (piso de 4): melhora em
    maquina grande e nunca fica pior que o default, e a folga evita que uma
    transcricao sozinha estrangule o dev server e um render simultaneo.

    Ajustavel por WHISPER_CPU_THREADS quando quiser calibrar na mao.
    """
    env = os.getenv("WHISPER_CPU_THREADS", "").strip()
    if env.isdigit() and int(env) > 0:
        return int(env)
    logicos = os.cpu_count() or 4
    return max(4, logicos // 2)


def transcribe(
    input_path: str,
    output_path: str,
    model_size: str = "large-v3",
    device: str = "auto",
    language: str = "pt",
    beam_size: int = 5,
) -> dict:
    """Transcreve o vídeo e salva JSON estruturado."""

    if not os.path.exists(input_path):
        raise FileNotFoundError(f"Arquivo não encontrado: {input_path}")

    # Auto-detect device se nao especificado
    if device == "auto":
        device = detectar_device()

    compute_type = "float16" if device == "cuda" else "int8"
    cpu_threads = threads_cpu()

    print(f"[transcribe] modelo={model_size} device={device} compute_type={compute_type} cpu_threads={cpu_threads}", file=sys.stderr)
    print(f"[transcribe] carregando modelo (primeira vez baixa ~3GB)...", file=sys.stderr)
    t0 = time.time()
    try:
        model = WhisperModel(
            model_size,
            device=device,
            compute_type=compute_type,
            cpu_threads=cpu_threads,
        )
    except Exception as e:
        # No Windows a GPU pode ser detectada e mesmo assim o carregamento
        # falhar por falta das DLLs de cuDNN/cuBLAS. Cair para CPU aqui e
        # melhor do que abortar o job inteiro: o usuario perde velocidade,
        # nao o resultado. A mensagem diz exatamente o que instalar.
        if device != "cuda":
            raise
        print(
            f"[transcribe] GPU detectada mas o modelo nao carregou ({e}).\n"
            f"[transcribe] Faltam provavelmente as bibliotecas cuDNN 8.x / cuBLAS do CUDA.\n"
            f"[transcribe] Continuando em CPU (mais lento).",
            file=sys.stderr,
        )
        device = "cpu"
        compute_type = "int8"
        model = WhisperModel(
            model_size,
            device=device,
            compute_type=compute_type,
            cpu_threads=cpu_threads,
        )
    print(f"[transcribe] modelo carregado em {time.time() - t0:.1f}s", file=sys.stderr)

    print(f"[transcribe] transcrevendo {input_path}...", file=sys.stderr)
    t0 = time.time()
    segments_iter, info = model.transcribe(
        input_path,
        language=language,
        beam_size=beam_size,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
    )

    segments = []
    for seg in segments_iter:
        words = []
        if seg.words:
            for w in seg.words:
                words.append({
                    "word": w.word.strip(),
                    "start": round(w.start, 3),
                    "end": round(w.end, 3),
                    "probability": round(w.probability, 3),
                })

        segments.append({
            "id": seg.id,
            "start": round(seg.start, 3),
            "end": round(seg.end, 3),
            "text": seg.text.strip(),
            "words": words,
        })
        # Stream incremental progress
        print(f"  [{seg.start:.1f}s → {seg.end:.1f}s] {seg.text[:80]}", file=sys.stderr)

    elapsed = time.time() - t0
    duration = info.duration
    realtime_factor = duration / elapsed if elapsed > 0 else 0
    print(f"[transcribe] concluído. {len(segments)} segments. {elapsed:.1f}s para {duration:.1f}s de áudio ({realtime_factor:.1f}x realtime).", file=sys.stderr)

    result = {
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
        "duration": round(info.duration, 3),
        "segments": segments,
        "metadata": {
            "model": model_size,
            "device": device,
            "compute_type": compute_type,
            "beam_size": beam_size,
            "cpu_threads": cpu_threads,
            "elapsed_seconds": round(elapsed, 1),
        },
    }

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"[transcribe] salvo em {output_path}", file=sys.stderr)
    return result


def main():
    parser = argparse.ArgumentParser(description="Transcrever vídeo com faster-whisper")
    parser.add_argument("--input", required=True, help="Caminho do vídeo de entrada (mp4, mov, etc)")
    parser.add_argument("--output", required=True, help="Caminho do JSON de saída")
    parser.add_argument("--model", default=os.getenv("WHISPER_MODEL", "large-v3"))
    parser.add_argument("--device", default=os.getenv("WHISPER_DEVICE", "auto"))
    parser.add_argument("--language", default="pt")
    # beam_size 5 e o default do faster-whisper. Em CPU fraca, 1 (greedy) corta
    # ~40% do tempo com perda pequena em audio limpo de estudio. Fica em env
    # para poder ser testado sem mudar codigo - e A/B com o cache de transcricao
    # e barato: mesma chave de video, so muda o modelo/parametro.
    parser.add_argument("--beam-size", type=int, default=int(os.getenv("WHISPER_BEAM_SIZE", "5")))

    args = parser.parse_args()

    transcribe(
        input_path=args.input,
        output_path=args.output,
        model_size=args.model,
        device=args.device,
        language=args.language,
        beam_size=args.beam_size,
    )


if __name__ == "__main__":
    main()
