import { useState, useCallback, useRef, useEffect } from "react";
import type { KiwiServer, ConnectionStatus } from "@/lib/constants";

export type DisconnectReason = null | "client" | "server" | "server_down" | "too_busy" | "timeout";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

interface UseKiwiSDROptions {
  onAudioData?: (pcmFloat32: Float32Array, sampleRate: number) => void;
}

export function useKiwiSDR(options: UseKiwiSDROptions = {}) {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [rssi, setRssi] = useState<number>(-127);
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [disconnectReason, setDisconnectReason] = useState<DisconnectReason>(null);
  const [sampleRate, setSampleRate] = useState<number>(12000);

  const abortRef = useRef<AbortController | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  const onAudioDataRef = useRef(options.onAudioData);
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timeoutClearedRef = useRef(false);
  const isConnectingRef = useRef(false);

  useEffect(() => {
    onAudioDataRef.current = options.onAudioData;
  }, [options.onAudioData]);

  const setVolume = useCallback((vol: number) => {
    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = vol;
    }
  }, []);

  const connect = useCallback(async (server: KiwiServer, frequency: number, modulation: string = "usb") => {
    // Guard against duplicate concurrent calls
    console.log(`[KiwiSDR ${Date.now()}] connect() called, isConnecting=${isConnectingRef.current}, server=${server.host}`);
    if (isConnectingRef.current) {
      console.warn(`[KiwiSDR ${Date.now()}] BLOCKED duplicate connect call`);
      return;
    }
    isConnectingRef.current = true;

    // Cleanup previous
    if (abortRef.current) abortRef.current.abort();

    setStatus("connecting");
    setError(null);
    setDisconnectReason(null);
    timeoutClearedRef.current = false;

    // Clear any existing connect timeout
    if (connectTimeoutRef.current) {
      clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }

    const abort = new AbortController();
    abortRef.current = abort;

    // Init Web Audio
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      audioCtxRef.current = new AudioContext({ sampleRate: 44100 });
      gainNodeRef.current = audioCtxRef.current.createGain();
      gainNodeRef.current.connect(audioCtxRef.current.destination);
    }
    if (audioCtxRef.current.state === "suspended") {
      await audioCtxRef.current.resume();
    }
    nextPlayTimeRef.current = 0;

    // 15-second client-side connection timeout
    const timeoutStarted = Date.now();
    console.log(`[KiwiSDR ${timeoutStarted}] Starting 15s timeout`);
    connectTimeoutRef.current = setTimeout(() => {
      console.error(`[KiwiSDR ${Date.now()}] Client-side connection timeout fired (started ${timeoutStarted}, elapsed ${Date.now() - timeoutStarted}ms)`);
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
      setError("Connection timed out — server may be unreachable");
      setDisconnectReason("timeout");
      setStatus("disconnected");
    }, 15000);

    try {
      const fetchStart = Date.now();
      console.log(`[KiwiSDR ${fetchStart}] Starting fetch to kiwi-stream`);
      const response = await fetch(`${SUPABASE_URL}/functions/v1/kiwi-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          server: server.host,
          port: server.port,
          frequency,
          modulation,
        }),
        signal: abort.signal,
      });

      console.log(`[KiwiSDR ${Date.now()}] Fetch response received: HTTP ${response.status} (took ${Date.now() - fetchStart}ms)`);

      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      let firstSSELine = true;
      const processLine = (line: string) => {
        if (firstSSELine) {
          console.log(`[KiwiSDR ${Date.now()}] First SSE line parsed: "${line.slice(0, 80)}"`);
          firstSSELine = false;
        }
        if (line.startsWith("event: ")) {
          // store event type for next data line
          (processLine as any).__event = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          const eventType = (processLine as any).__event || "msg";
          const jsonStr = line.slice(6).trim();
          try {
            const data = JSON.parse(jsonStr);
            handleSSEEvent(eventType, data);
          } catch {
            // ignore parse errors
          }
        }
      };

      const handleSSEEvent = (event: string, data: any) => {
        // Clear timeout on first SSE event — stream is flowing, errors will come through it
        if (!timeoutClearedRef.current && connectTimeoutRef.current) {
          clearTimeout(connectTimeoutRef.current);
          connectTimeoutRef.current = null;
          timeoutClearedRef.current = true;
        }

        switch (event) {
          case "status":
            if (data.state === "connected") {
              setStatus("connected");
              if (data.sampleRate) setSampleRate(data.sampleRate);
            }
            break;
          case "snd":
            processAudio(data);
            break;
          case "error":
            setError(data.message || "Unknown error");
            if (data.type === "too_busy") {
              setDisconnectReason("too_busy");
              setStatus("disconnected");
            } else if (data.type === "server_down") {
              setDisconnectReason("server_down");
              setStatus("disconnected");
            } else if (data.type === "timeout") {
              setDisconnectReason("timeout");
              setStatus("disconnected");
            }
            break;
          case "closed":
            setDisconnectReason(data.reason === "client" ? "client" : "server");
            setStatus("disconnected");
            break;
          case "msg":
            if (data.type === "sample_rate") {
              setSampleRate(data.value);
            }
            break;
        }
      };

      const processAudio = (data: { rssi: number; sampleRate: number; audio: string; len: number }) => {
        setRssi(data.rssi);

        // Decode base64 audio (16-bit big-endian PCM)
        const binaryStr = atob(data.audio);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }

        // Convert big-endian 16-bit PCM to Float32
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

        // Audio level (RMS)
        const rms = Math.sqrt(sumSquares / numSamples);
        setAudioLevel(Math.min(1, rms * 5)); // scale up for visibility

        // Callback for transcription (raw 12kHz PCM)
        if (onAudioDataRef.current) {
          onAudioDataRef.current(float32, data.sampleRate || 12000);
        }

        // Play through Web Audio (resample from server rate to 44100)
        const ctx = audioCtxRef.current;
        const gain = gainNodeRef.current;
        if (!ctx || !gain) return;

        const srcRate = data.sampleRate || 12000;
        const audioBuffer = ctx.createBuffer(1, numSamples, srcRate);
        audioBuffer.getChannelData(0).set(float32);

        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(gain);

        const now = ctx.currentTime;
        if (nextPlayTimeRef.current < now) {
          nextPlayTimeRef.current = now + 0.05; // small buffer
        }
        source.start(nextPlayTimeRef.current);
        nextPlayTimeRef.current += audioBuffer.duration;
      };

      // Read SSE stream
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (line) processLine(line);
        }
      }
    } catch (e: any) {
      if (e.name !== "AbortError") {
        console.error("KiwiSDR connection error:", e);
        setError(e.message || "Connection failed");
      }
    } finally {
      isConnectingRef.current = false;
      if (!abort.signal.aborted) {
        setStatus("disconnected");
      }
    }
  }, []);

  const disconnect = useCallback(() => {
    isConnectingRef.current = false;
    if (connectTimeoutRef.current) {
      clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
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
  };
}
