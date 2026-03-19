import { useCallback, useRef, useState } from "react";
import { useScribe, CommitStrategy, AudioFormat } from "@elevenlabs/react";
import type { TranscriptSegment } from "@/lib/constants";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;


export function useTranscription() {
  const [committedTranscripts, setCommittedTranscripts] = useState<TranscriptSegment[]>([]);
  const [detectedLanguage, setDetectedLanguage] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const segmentCounterRef = useRef(0);

  const scribe = useScribe({
    modelId: "scribe_v2_realtime",
    commitStrategy: CommitStrategy.VAD,
    onCommittedTranscript: (data) => {
      const text = data.text?.trim();
      if (text) {
        segmentCounterRef.current++;
        const segment: TranscriptSegment = {
          id: `seg-${segmentCounterRef.current}-${Date.now()}`,
          text,
          timestamp: Date.now(),
        };
        setCommittedTranscripts((prev) => [...prev, segment]);
      }
    },
    onError: (error) => {
      console.error("Scribe error:", error);
    },
  });

  const scribeRef = useRef(scribe);
  scribeRef.current = scribe;

  const connect = useCallback(async () => {
    setCommittedTranscripts([]);
    segmentCounterRef.current = 0;
    setIsConnecting(true);
    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/elevenlabs-scribe-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        throw new Error("Failed to get scribe token");
      }

      const { token } = await response.json();
      await scribeRef.current.connect({ token, audioFormat: AudioFormat.PCM_16000, sampleRate: 16000 });
    } catch (e) {
      console.error("Transcription connect error:", e);
      throw e;
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    scribeRef.current.disconnect();
    setDetectedLanguage(null);
  }, []);

  const sendAudio = useCallback(
    (pcmFloat32: Float32Array, sourceSampleRate: number) => {
      if (!scribeRef.current.isConnected) return;

      const targetRate = 16000;
      const ratio = targetRate / sourceSampleRate;

      const outputLength = Math.ceil(pcmFloat32.length * ratio);
      const resampled = new Int16Array(outputLength);

      for (let i = 0; i < outputLength; i++) {
        const srcIdx = i / ratio;
        const idx0 = Math.floor(srcIdx);
        const idx1 = Math.min(idx0 + 1, pcmFloat32.length - 1);
        const frac = srcIdx - idx0;
        const sample = pcmFloat32[idx0] * (1 - frac) + pcmFloat32[idx1] * frac;
        resampled[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
      }

      const bytes = new Uint8Array(resampled.buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const b64 = btoa(binary);

      scribeRef.current.sendAudio(b64);
    },
    []
  );

  return {
    partialTranscript: scribe.partialTranscript || "",
    committedTranscripts,
    detectedLanguage,
    isConnected: scribe.isConnected,
    isConnecting,
    connect,
    disconnect,
    sendAudio,
  };
}