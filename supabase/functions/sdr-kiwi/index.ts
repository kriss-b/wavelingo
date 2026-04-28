// SDR transport: KiwiSDR.
//
// Bridges browser → KiwiSDR (ws://) and emits the unified SSE protocol
// defined in `_shared/sdr-protocol.ts`. Renamed from `kiwi-stream`.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { encode as base64Encode } from "https://deno.land/std@0.168.0/encoding/base64.ts";
import { encodeSdrEvent, type SdrEvent } from "../_shared/sdr-protocol.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { server, port, frequency, modulation } = await req.json();
    if (!server || !port) {
      return new Response(JSON.stringify({ error: "Missing server or port" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const freq = frequency || 7200; // default 7200 kHz
    const mod = modulation || "lsb";

    // Passband defaults
    const passbands: Record<string, [number, number]> = {
      am: [-4900, 4900],
      amn: [-2500, 2500],
      lsb: [-2700, -300],
      usb: [300, 2700],
      cw: [300, 700],
      nbfm: [-6000, 6000],
    };
    const [lc, hc] = passbands[mod] || [300, 2700];

    const wsUrl = `ws://${server}:${port}/0/SND`;
    const wsCreatedAt = Date.now();
    console.log(`[sdr-kiwi ${wsCreatedAt}] Connecting to KiwiSDR: ${wsUrl}`);

    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";

    let sendSeq = 0;
    const wsSend = (msg: string) => {
      console.log(`[sdr-kiwi TX #${sendSeq++}] ${msg}`);
      ws.send(msg);
    };

    let clientCancelled = false;

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        let sampleRate = 12000;
        let keepaliveInterval: number | undefined;
        let closed = false;
        let connectTimeout: number | undefined;
        let hardLimitTimer: number | undefined;
        let readyEmitted = false;

        const emit = (event: SdrEvent) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(encodeSdrEvent(event)));
          } catch {
            closed = true;
          }
        };

        // 10-second connection timeout
        connectTimeout = setTimeout(() => {
          console.error(`[sdr-kiwi] connection timeout (10s) elapsed=${Date.now() - wsCreatedAt}ms`);
          emit({ type: "error", code: "timeout", message: "Connection timed out (server unreachable)" });
          emit({ type: "closed", reason: "server" });
          closed = true;
          if (keepaliveInterval) clearInterval(keepaliveInterval);
          if (hardLimitTimer) clearTimeout(hardLimitTimer);
          try { ws.close(1000, "Going Away"); } catch { /* ignore */ }
          try { controller.close(); } catch { /* ignore */ }
        }, 10000) as unknown as number;

        ws.onopen = () => {
          console.log(`[sdr-kiwi] WebSocket connected in ${Date.now() - wsCreatedAt}ms`);
          if (connectTimeout) clearTimeout(connectTimeout);
          wsSend("SET auth t=kiwi p=");
        };

        ws.onmessage = (event) => {
          const data = event.data;

          if (typeof data === "string") {
            console.log("[sdr-kiwi] unexpected text:", data);
          } else if (data instanceof ArrayBuffer) {
            const bytes = new Uint8Array(data);
            if (bytes.length < 3) return;

            const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2]);

            if (tag === "SND" && bytes.length >= 10) {
              // body[0]=flags, body[1..4]=seq LE, body[5..6]=smeter BE, body[7..]=audio
              // absolute offsets: tag=0..2, flags=3, seq=4..7, smeter=8..9, audio=10..
              const smeter = (bytes[8] << 8) | bytes[9];
              const dbm = 0.1 * smeter - 127;
              const audioData = bytes.slice(10);

              if (audioData.length > 0) {
                emit({ type: "rssi", dbm });
                emit({ type: "audio", pcm: base64Encode(audioData), len: audioData.length });
              }
            } else if (tag === "MSG") {
              const text = new TextDecoder().decode(bytes.slice(4));
              console.log("[sdr-kiwi] MSG:", text);
              if (text) {
                const pairs = text.split(" ");
                for (const pair of pairs) {
                  const eqIdx = pair.indexOf("=");
                  const name = eqIdx >= 0 ? pair.substring(0, eqIdx) : pair;
                  const value = eqIdx >= 0 ? pair.substring(eqIdx + 1) : null;

                  if (name === "down") {
                    console.warn("[sdr-kiwi] server down");
                    emit({ type: "error", code: "server_down", message: "Server is down" });
                    emit({ type: "closed", reason: "server" });
                    ws.close(1000, "Going Away");
                    return;
                  }

                  if (name === "too_busy") {
                    emit({ type: "error", code: "server_busy", message: "Server is too busy. Try later, or another server" });
                    emit({ type: "closed", reason: "server" });
                    ws.close(1000, "Going Away");
                    return;
                  }

                  if (name === "audio_rate" && value) {
                    wsSend(`SET AR OK in=${parseInt(value)} out=44100`);
                  }

                  if (name === "sample_rate" && value) {
                    sampleRate = parseFloat(value);
                    wsSend("SET squelch=0 max=0");
                    wsSend("SET genattn=0");
                    wsSend("SET gen=0 mix=-1");
                    wsSend(`SET mod=${mod} low_cut=${lc} high_cut=${hc} freq=${freq}`);
                    wsSend("SET agc=1 hang=0 thresh=-100 slope=6 decay=1000 manGain=50");
                    wsSend("SET compression=0");
                    wsSend("SET ident_user=F4DAN");
                    wsSend("SET keepalive");

                    if (!readyEmitted) {
                      emit({ type: "ready", sampleRate });
                      readyEmitted = true;
                    }

                    // Hard 600s server-side limit
                    hardLimitTimer = setTimeout(() => {
                      console.log(`[sdr-kiwi] hard 600s limit reached`);
                      emit({ type: "closed", reason: "hard_limit" });
                      closed = true;
                      if (keepaliveInterval) clearInterval(keepaliveInterval);
                      try { ws.close(1000, "Going Away"); } catch { /* ignore */ }
                      try { controller.close(); } catch { /* ignore */ }
                    }, 600_000) as unknown as number;

                    keepaliveInterval = setInterval(() => {
                      try {
                        if (ws.readyState === WebSocket.OPEN) wsSend("SET keepalive");
                      } catch {
                        // ignore
                      }
                    }, 5000);
                  }
                }
              }
            }
          }
        };

        ws.onerror = (e: Event & { message?: string }) => {
          if (closed) return;
          console.error(`[sdr-kiwi] WebSocket error type=${e.type} message=${e.message || "N/A"}`);
          emit({ type: "error", code: "ws_error", message: "WebSocket connection error" });
        };

        ws.onclose = (ev: CloseEvent) => {
          if (closed) return;
          const reason: SdrEvent extends { reason: infer R } ? R : never = clientCancelled ? "client" : "server";
          console.log(`[sdr-kiwi] WebSocket closed code=${ev.code} reason="${ev.reason}" trigger=${reason}`);
          if (keepaliveInterval) clearInterval(keepaliveInterval);
          if (hardLimitTimer) clearTimeout(hardLimitTimer);
          emit({ type: "closed", reason });
          closed = true;
          try { controller.close(); } catch { /* already closed */ }
        };
      },
      cancel() {
        console.log(`[sdr-kiwi] SSE stream cancelled by client after ${Date.now() - wsCreatedAt}ms`);
        clientCancelled = true;
        try { ws.close(1000, "Going Away"); } catch { /* ignore */ }
      },
    });

    return new Response(stream, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (e) {
    console.error("[sdr-kiwi] error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
