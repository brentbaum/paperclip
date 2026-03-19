import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../middleware/logger.js";

export interface SttConfig {
  provider: "local_sherpa" | "nvidia_parakeet";
  // Local sherpa-onnx config
  modelDir?: string;
  numThreads?: number;
  // NVIDIA cloud API config
  nvidiaApiKey?: string;
  nvidiaModel: string;
  nvidiaBaseUrl: string;
}

export interface TranscriptionResult {
  text: string;
  durationSec?: number;
}

export interface SpeechToTextService {
  transcribe(audioBuffer: Buffer, mimeType?: string): Promise<TranscriptionResult>;
}

const MAX_AUDIO_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Convert OGG/Opus audio buffer to mono 16kHz Float32 PCM using ffmpeg.
 */
export function convertAudioToPcm(audioBuffer: Buffer): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-i", "pipe:0",
      "-f", "f32le",
      "-acodec", "pcm_f32le",
      "-ac", "1",
      "-ar", "16000",
      "-loglevel", "error",
      "pipe:1",
    ]);

    const chunks: Buffer[] = [];

    ffmpeg.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    let stderrOutput = "";
    ffmpeg.stderr.on("data", (data: Buffer) => {
      stderrOutput += data.toString();
    });

    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderrOutput}`));
        return;
      }
      const combined = Buffer.concat(chunks);
      resolve(new Float32Array(combined.buffer, combined.byteOffset, combined.byteLength / 4));
    });

    ffmpeg.on("error", (err) => {
      reject(new Error(`ffmpeg spawn failed: ${err.message}`));
    });

    ffmpeg.stdin.write(audioBuffer);
    ffmpeg.stdin.end();
  });
}

/**
 * Resolve the model file paths within a model directory.
 * Supports both regular and int8-quantized model files.
 */
function resolveModelFiles(modelDir: string) {
  const int8 = existsSync(join(modelDir, "encoder.int8.onnx"));
  const suffix = int8 ? ".int8.onnx" : ".onnx";
  return {
    encoder: join(modelDir, `encoder${suffix}`),
    decoder: join(modelDir, `decoder${suffix}`),
    joiner: join(modelDir, `joiner${suffix}`),
    tokens: join(modelDir, "tokens.txt"),
  };
}

function createLocalSherpaService(config: SttConfig): SpeechToTextService {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sherpa = require("sherpa-onnx-node") as {
    OfflineRecognizer: new (config: Record<string, unknown>) => {
      createStream(): { acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void };
      decode(stream: unknown): void;
      getResult(stream: unknown): { text: string };
    };
  };

  const modelDir = config.modelDir;
  if (!modelDir || !existsSync(modelDir)) {
    logger.warn(
      { modelDir },
      "STT model directory not found — local sherpa transcription will return empty results",
    );
    return { transcribe: async () => ({ text: "" }) };
  }

  const files = resolveModelFiles(modelDir);
  for (const [key, path] of Object.entries(files)) {
    if (!existsSync(path)) {
      logger.warn({ key, path }, "STT model file not found");
      return { transcribe: async () => ({ text: "" }) };
    }
  }

  const recognizer = new sherpa.OfflineRecognizer({
    modelConfig: {
      transducer: {
        encoder: files.encoder,
        decoder: files.decoder,
        joiner: files.joiner,
      },
      tokens: files.tokens,
      numThreads: config.numThreads ?? 2,
      debug: false,
    },
  });

  logger.info({ modelDir, numThreads: config.numThreads ?? 2 }, "Local Parakeet STT initialized");

  async function transcribe(
    audioBuffer: Buffer,
    _mimeType?: string,
  ): Promise<TranscriptionResult> {
    if (audioBuffer.length === 0) {
      logger.warn("STT transcription skipped: empty audio buffer");
      return { text: "" };
    }

    if (audioBuffer.length > MAX_AUDIO_SIZE_BYTES) {
      logger.warn(
        { size: audioBuffer.length, maxSize: MAX_AUDIO_SIZE_BYTES },
        "STT transcription skipped: audio file too large",
      );
      return { text: "" };
    }

    try {
      const samples = await convertAudioToPcm(audioBuffer);

      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples, sampleRate: 16000 });
      recognizer.decode(stream);
      const result = recognizer.getResult(stream);
      const text = typeof result.text === "string" ? result.text.trim() : "";

      logger.info({ textLength: text.length }, "Local STT transcription completed");
      return { text };
    } catch (err) {
      logger.warn({ err }, "Local STT transcription failed");
      return { text: "" };
    }
  }

  return { transcribe };
}

function createNvidiaApiService(config: SttConfig): SpeechToTextService {
  async function transcribe(
    audioBuffer: Buffer,
    mimeType?: string,
  ): Promise<TranscriptionResult> {
    if (!config.nvidiaApiKey) {
      logger.warn("STT transcription skipped: no NVIDIA API key configured");
      return { text: "" };
    }

    if (audioBuffer.length === 0) {
      logger.warn("STT transcription skipped: empty audio buffer");
      return { text: "" };
    }

    if (audioBuffer.length > MAX_AUDIO_SIZE_BYTES) {
      logger.warn(
        { size: audioBuffer.length, maxSize: MAX_AUDIO_SIZE_BYTES },
        "STT transcription skipped: audio file too large",
      );
      return { text: "" };
    }

    try {
      const ext = mimeType === "audio/ogg" ? "ogg" : "ogg";
      const filename = `voice.${ext}`;

      const blob = new Blob([audioBuffer.buffer.slice(audioBuffer.byteOffset, audioBuffer.byteOffset + audioBuffer.byteLength) as ArrayBuffer], { type: mimeType ?? "audio/ogg" });

      const formData = new FormData();
      formData.append("file", blob, filename);
      formData.append("model", config.nvidiaModel);
      formData.append("response_format", "json");
      formData.append("language", "en");

      const url = `${config.nvidiaBaseUrl}/audio/transcriptions`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.nvidiaApiKey}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        logger.warn(
          { status: response.status, body: errorText },
          "NVIDIA Parakeet STT API returned error",
        );
        return { text: "" };
      }

      const result = (await response.json()) as { text?: string };
      const text = typeof result.text === "string" ? result.text.trim() : "";

      logger.info(
        { textLength: text.length, model: config.nvidiaModel },
        "STT transcription completed",
      );

      return { text };
    } catch (err) {
      logger.warn({ err }, "STT transcription failed");
      return { text: "" };
    }
  }

  return { transcribe };
}

export function createSpeechToTextService(config: SttConfig): SpeechToTextService {
  if (config.provider === "local_sherpa") {
    return createLocalSherpaService(config);
  }
  return createNvidiaApiService(config);
}
