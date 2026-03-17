import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import {
  createSpeechToTextService,
  convertAudioToPcm,
  type SttConfig,
} from "../services/speech-to-text.js";

function nvidiaConfig(overrides?: Partial<SttConfig>): SttConfig {
  return {
    provider: "nvidia_parakeet",
    nvidiaApiKey: "test-api-key",
    nvidiaModel: "nvidia/parakeet-tdt-0.6b-v2",
    nvidiaBaseUrl: "https://integrate.api.nvidia.com/v1",
    ...overrides,
  };
}

describe("NVIDIA Parakeet cloud provider", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty text when no API key is configured", async () => {
    const svc = createSpeechToTextService(nvidiaConfig({ nvidiaApiKey: undefined }));
    const result = await svc.transcribe(Buffer.from("audio-data"), "audio/ogg");
    expect(result).toEqual({ text: "" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns empty text for empty audio buffer", async () => {
    const svc = createSpeechToTextService(nvidiaConfig());
    const result = await svc.transcribe(Buffer.alloc(0), "audio/ogg");
    expect(result).toEqual({ text: "" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns empty text when audio exceeds max size", async () => {
    const svc = createSpeechToTextService(nvidiaConfig());
    const largeBuffer = Buffer.alloc(21 * 1024 * 1024); // 21 MB
    const result = await svc.transcribe(largeBuffer, "audio/ogg");
    expect(result).toEqual({ text: "" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("transcribes audio successfully", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ text: "Hello world" }),
    }));
    vi.stubGlobal("fetch", mockFetch);

    const svc = createSpeechToTextService(nvidiaConfig());
    const result = await svc.transcribe(Buffer.from("fake-audio"), "audio/ogg");

    expect(result).toEqual({ text: "Hello world" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://integrate.api.nvidia.com/v1/audio/transcriptions");
    expect(opts.method).toBe("POST");
    expect((opts.headers as Record<string, string>).Authorization).toBe("Bearer test-api-key");
  });

  it("trims whitespace from transcription result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ text: "  hello  " }),
      })),
    );

    const svc = createSpeechToTextService(nvidiaConfig());
    const result = await svc.transcribe(Buffer.from("fake-audio"), "audio/ogg");
    expect(result.text).toBe("hello");
  });

  it("returns empty text on API error response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      })),
    );

    const svc = createSpeechToTextService(nvidiaConfig());
    const result = await svc.transcribe(Buffer.from("fake-audio"), "audio/ogg");
    expect(result).toEqual({ text: "" });
  });

  it("returns empty text on network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Network error");
      }),
    );

    const svc = createSpeechToTextService(nvidiaConfig());
    const result = await svc.transcribe(Buffer.from("fake-audio"), "audio/ogg");
    expect(result).toEqual({ text: "" });
  });

  it("uses custom model and base URL from config", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ text: "custom model result" }),
    }));
    vi.stubGlobal("fetch", mockFetch);

    const svc = createSpeechToTextService(
      nvidiaConfig({
        nvidiaModel: "nvidia/custom-model",
        nvidiaBaseUrl: "https://custom.api.example.com/v1",
      }),
    );
    const result = await svc.transcribe(Buffer.from("fake-audio"), "audio/ogg");

    expect(result.text).toBe("custom model result");
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe("https://custom.api.example.com/v1/audio/transcriptions");
  });
});

describe("local sherpa provider", () => {
  it("returns empty text when model directory is missing", async () => {
    const svc = createSpeechToTextService({
      provider: "local_sherpa",
      modelDir: "/nonexistent/model/dir",
      nvidiaModel: "",
      nvidiaBaseUrl: "",
    });
    const result = await svc.transcribe(Buffer.from("audio-data"), "audio/ogg");
    expect(result).toEqual({ text: "" });
  });

  it("returns empty text when model directory is undefined", async () => {
    const svc = createSpeechToTextService({
      provider: "local_sherpa",
      modelDir: undefined,
      nvidiaModel: "",
      nvidiaBaseUrl: "",
    });
    const result = await svc.transcribe(Buffer.from("audio-data"), "audio/ogg");
    expect(result).toEqual({ text: "" });
  });
});

describe("convertAudioToPcm", () => {
  it("converts valid audio buffer to Float32Array", async () => {
    // Generate a tiny valid WAV file (silence) for ffmpeg to process
    const sampleRate = 16000;
    const numSamples = 160; // 10ms of audio
    const wavHeader = Buffer.alloc(44);
    const dataSize = numSamples * 2; // 16-bit PCM
    const fileSize = 36 + dataSize;

    // WAV header
    wavHeader.write("RIFF", 0);
    wavHeader.writeUInt32LE(fileSize, 4);
    wavHeader.write("WAVE", 8);
    wavHeader.write("fmt ", 12);
    wavHeader.writeUInt32LE(16, 16); // chunk size
    wavHeader.writeUInt16LE(1, 20); // PCM format
    wavHeader.writeUInt16LE(1, 22); // mono
    wavHeader.writeUInt32LE(sampleRate, 24);
    wavHeader.writeUInt32LE(sampleRate * 2, 28); // byte rate
    wavHeader.writeUInt16LE(2, 32); // block align
    wavHeader.writeUInt16LE(16, 34); // bits per sample
    wavHeader.write("data", 36);
    wavHeader.writeUInt32LE(dataSize, 40);

    const audioData = Buffer.alloc(dataSize); // silence
    const wavBuffer = Buffer.concat([wavHeader, audioData]);

    const result = await convertAudioToPcm(wavBuffer);
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBeGreaterThan(0);
  });

  it("rejects on invalid audio data", async () => {
    await expect(convertAudioToPcm(Buffer.from("not-audio"))).rejects.toThrow();
  });
});

// Integration test — runs only when the Parakeet model is downloaded locally
const MODEL_DIR = join(process.env.HOME ?? "", ".paperclip/models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8");
const modelAvailable = existsSync(join(MODEL_DIR, "encoder.int8.onnx"));

describe.skipIf(!modelAvailable)("local sherpa integration (real model)", () => {
  it("transcribes a WAV file through the full pipeline", async () => {
    const testWav = join(MODEL_DIR, "test_wavs", "0.wav");
    // Convert WAV to OGG to simulate a Telegram voice message
    const oggPath = join("/tmp", "stt-test-voice.ogg");
    execFileSync("ffmpeg", ["-i", testWav, "-c:a", "libopus", "-f", "ogg", oggPath, "-y"], { stdio: "pipe" });
    const oggBuffer = readFileSync(oggPath);

    const svc = createSpeechToTextService({
      provider: "local_sherpa",
      modelDir: MODEL_DIR,
      numThreads: 2,
      nvidiaModel: "",
      nvidiaBaseUrl: "",
    });

    const result = await svc.transcribe(oggBuffer, "audio/ogg");

    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text.toLowerCase()).toContain("portrait");
  }, 30_000);
});
