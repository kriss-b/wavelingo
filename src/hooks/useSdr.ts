import { useState, useCallback, useRef, useEffect } from "react";
import type { SdrServer, ConnectionStatus } from "@/lib/constants";
import type { SdrTransport, Tuning } from "@/hooks/sdr/types";
import type { SdrEvent } from "@/lib/sdr-protocol";
import { TRANSPORT_REGISTRY } from "@/hooks/sdr/registry";

/**
 * Disconnect reason exposed to the UI. Mapped from the unified
 * `SdrEvent` stream — UI strings live in ControlPanel.
 */
export type DisconnectReason =
  | null
  | "client"
  | "server"
  | "server_down"
  | "too_busy"
  | "timeout"
  | "hard_limit";

interface UseSdrOptions {
  onAudioData?: (pcmFloat32: Float32Array, sampleRate: number) => void;
}

/**
 * Public, transport-agnostic SDR hook.
 *
 * Selects a transport (Kiwi, OpenWebRX, ...) based on `server.kind` and
 * exposes a single API for connect / disconnect / volume / S-meter / audio.
 * The downstream pipeline (transcription, translation, AI voice) sees the
 * exact same shape regardless of which SDR backend is active.
 */
export function useSdr(options: UseSdrOptions = {}) {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [rssi, setRssi] = useState<number>(-127);
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [disconnectReason, setDisconnectReason] = useState<DisconnectReason>(null);
  const [sampleRate, setSampleRate] = useState<number>(12000);

  const transportRef = useRef<SdrTransport | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  const onAudioDataRef = useRef(options.onAudioData);
  const muteOriginalRef = useRef(false);
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timeoutClearedRef = useRef(false);
  const isConnectingRef = useRef(false);
  const sampleRateRef = useRef<number>(12000);

  useEffect(() => {
    onAudioDataRef.current = options.onAudioData;
  }, [options.onAudioData]);

  const setVolume = useCallback((vol: number) => {
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = vol;
    }
  }, []);

  const setMuteOriginal = useCallback((muted: boolean) => {
    muteOriginalRef.current = muted;
  }, []);

  const processAudio = useCallback((pcmBase64: string) => {
    const binaryStr = atob(pcmBase64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    const numSamples = Math.floor(bytes.length / 2);
    const float32 = new Float32Array(numSamples);
    const view = new DataView(bytes.buffer);

    let sumSquares = 0;
    for (let i = 0; i < numSamples; i++) {
      const sample16 = view.getInt16(i * 2, false); // big-endian
      const f = sample16 / 32768;
      float32[i] = f;
      sumSquares += f * f;
    }

    const rms = Math.sqrt(sumSquares / numSamples);
    setAudioLevel(Math.min(1, rms * 5));

    const sr = sampleRateRef.current;

    if (onAudioDataRef.current) {
      onAudioDataRef.current(float32, sr);
    }

    if (!muteOriginalRef.current) {
      const ctx = audioCtxRef.current;
      const gain = gainNodeRef.current;
      if (!ctx || !gain) return;

      // Short fade in/out (~1ms) on each chunk to mask boundary discontinuities
      // between consecutive AudioBufferSource nodes.
      const fadeLen = Math.min(12, numSamples >> 1);
      for (let i = 0; i < fadeLen; i++) {
        const g = i / fadeLen;
        float32[i] *= g;
        float32[numSamples - 1 - i] *= g;
      }

      const audioBuffer = ctx.createBuffer(1, numSamples, sr);
      audioBuffer.getChannelData(0).set(float32);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(gain);

      const now = ctx.currentTime;
      // Larger prebuffer (200ms) to absorb jitter on backends that send big
      // audio frames (e.g. OpenWebRX at ~4-5 Hz). Smaller cushions caused
      // periodic underruns audible as regular clicks.
      if (nextPlayTimeRef.current < now) {
        nextPlayTimeRef.current = now + 0.2;
      }
      source.start(nextPlayTimeRef.current);
      nextPlayTimeRef.current += audioBuffer.duration;
    }
  }, []);

  const handleEvent = useCallback((event: SdrEvent) => {
    // First non-keepalive event clears the connection timeout.
    if (!timeoutClearedRef.current && event.type !== "keepalive" && connectTimeoutRef.current) {
      clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
      timeoutClearedRef.current = true;
    }

    switch (event.type) {
      case "ready":
        sampleRateRef.current = event.sampleRate;
        setSampleRate(event.sampleRate);
        setStatus("connected");
        break;
      case "audio":
        processAudio(event.pcm);
        break;
      case "rssi":
        setRssi(event.dbm);
        break;
      case "keepalive":
        break;
      case "error":
        setError(event.message);
        if (event.code === "server_down") setDisconnectReason("server_down");
        else if (event.code === "server_busy" || event.code === "too_many_clients") setDisconnectReason("too_busy");
        else if (event.code === "timeout") setDisconnectReason("timeout");
        break;
      case "closed":
        setDisconnectReason((prev) => prev ?? (event.reason === "hard_limit" ? "timeout" : event.reason));
        setStatus("disconnected");
        isConnectingRef.current = false;
        break;
    }
  }, [processAudio]);

  const connect = useCallback(async (server: SdrServer, frequency: number, modulation: string = "usb") => {
    if (isConnectingRef.current) {
      console.warn(`[useSdr] BLOCKED duplicate connect call`);
      return;
    }
    isConnectingRef.current = true;

    if (transportRef.current) {
      transportRef.current.disconnect();
      transportRef.current = null;
    }

    setStatus("connecting");
    setError(null);
    setDisconnectReason(null);
    timeoutClearedRef.current = false;

    if (connectTimeoutRef.current) {
      clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }

    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      audioCtxRef.current = new AudioContext({ sampleRate: 44100 });
      gainNodeRef.current = audioCtxRef.current.createGain();
      gainNodeRef.current.connect(audioCtxRef.current.destination);
    }
    if (audioCtxRef.current.state === "suspended") {
      await audioCtxRef.current.resume();
    }
    nextPlayTimeRef.current = 0;

    connectTimeoutRef.current = setTimeout(() => {
      console.error(`[useSdr] Client-side connection timeout fired`);
      if (transportRef.current) {
        transportRef.current.disconnect();
        transportRef.current = null;
      }
      setError("Connection timed out — server may be unreachable");
      setDisconnectReason("timeout");
      setStatus("disconnected");
      isConnectingRef.current = false;
    }, 15000);

    const factory = TRANSPORT_REGISTRY[server.kind];
    if (!factory) {
      setError(`Unsupported SDR kind: ${server.kind}`);
      setStatus("disconnected");
      isConnectingRef.current = false;
      return;
    }
    const transport = factory();
    transportRef.current = transport;

    const tuning: Tuning = { frequency, modulation };

    try {
      await transport.connect(server, tuning, handleEvent);
    } catch (e: unknown) {
      const err = e as { name?: string; message?: string };
      if (err.name !== "AbortError") {
        console.error("[useSdr] connect error:", e);
        setError(err.message || "Connection failed");
        setStatus("disconnected");
      }
      isConnectingRef.current = false;
    }
  }, [handleEvent]);

  const disconnect = useCallback(() => {
    isConnectingRef.current = false;
    if (connectTimeoutRef.current) {
      clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
    if (transportRef.current) {
      transportRef.current.disconnect();
      transportRef.current = null;
    }
    setStatus("disconnected");
    setDisconnectReason("client");
    setRssi(-127);
    setAudioLevel(0);
    setError(null);
  }, []);

  return {
    status,
    rssi,
    audioLevel,
    error,
    disconnectReason,
    sampleRate,
    connect,
    disconnect,
    setVolume,
    setMuteOriginal,
  };
}
