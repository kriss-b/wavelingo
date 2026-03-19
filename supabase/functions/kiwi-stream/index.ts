import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { encode as base64Encode } from "https://deno.land/std@0.168.0/encoding/base64.ts";

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
    console.log(`Connecting to KiwiSDR: ${wsUrl}`);

    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";

    let sendSeq = 0;
    const wsSend = (msg: string) => {
      console.log(`[TX #${sendSeq++}] ${msg}`);
      ws.send(msg);
    };

    // SSE stream
    let clientCancelled = false;

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        let sampleRate = 12000;
        let keepaliveInterval: number | undefined;
        let closed = false;
        let connectTimeout: number | undefined;

        let sseSeq = 0;
        const sendSSE = (event: string, data: string) => {
          if (closed) return;
          if (sseSeq < 5) {
            console.log(`[SSE #${sseSeq} ${Date.now()}] Enqueuing event=${event} (${data.length} chars)`);
          }
          sseSeq++;
          try {
            controller.enqueue(encoder.encode(`event: ${event}\n` + `data: ${data}\n\n`));
          } catch {
            closed = true;
          }
        };

        // 10-second connection timeout
        connectTimeout = setTimeout(() => {
          console.error("KiwiSDR connection timeout (10s)");
          sendSSE("error", JSON.stringify({ type: "timeout", message: "Connection timed out (server unreachable)" }));
          closed = true;
          if (keepaliveInterval) clearInterval(keepaliveInterval);
          try {
            ws.close(1000, "Going Away");
          } catch {
            /* ignore */
          }
          try {
            controller.close();
          } catch {
            /* ignore */
          }
        }, 10000) as unknown as number;

        ws.onopen = () => {
          console.log("WebSocket connected to KiwiSDR");
          if (connectTimeout) clearTimeout(connectTimeout);
          // Auth handshake
          wsSend("SET auth t=kiwi p=");
        };

        ws.onmessage = (event) => {
          const data = event.data;

          if (typeof data === "string") {
            console.log("KiwiSDR unexpected text message:", data);
          } else if (data instanceof ArrayBuffer) {
            // Binary message
            const bytes = new Uint8Array(data);
            if (bytes.length < 3) return;

            const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2]);

            if (tag === "SND" && bytes.length >= 7) {
              // SND format: flags(1) + seq(4 LE) + smeter(2 BE) + audio data
              const flags = bytes[3];
              const smeter = (bytes[8] << 8) | bytes[9]; // big-endian uint16 at offset 8-9
              // Wait — let me re-check. After the 3-byte tag: body starts.
              // body[0] = flags, body[1..4] = seq (LE uint32), body[5..6] = smeter (BE uint16), body[7..] = audio
              // So absolute offsets: tag=0..2, flags=3, seq=4..7, smeter=8..9, audio=10..
              const rssi = 0.1 * smeter - 127;
              const audioData = bytes.slice(10);

              if (audioData.length > 0) {
                // audioData is 16-bit signed big-endian PCM (no compression)
                const b64 = base64Encode(audioData);
                sendSSE("snd", JSON.stringify({ rssi, sampleRate, audio: b64, len: audioData.length }));
              }
            } else if (tag === "MSG") {
              // Binary MSG — skip first byte after tag, rest is text
              const text = new TextDecoder().decode(bytes.slice(4));
              console.log("KiwiSDR MSG (binary):", text);
              if (text) {
                const pairs = text.split(" ");
                for (const pair of pairs) {
                  const eqIdx = pair.indexOf("=");
                  const name = eqIdx >= 0 ? pair.substring(0, eqIdx) : pair;
                  const value = eqIdx >= 0 ? pair.substring(eqIdx + 1) : null;

                  if (name === "down") {
                    console.warn("KiwiSDR server down (binary)");
                    sendSSE("error", JSON.stringify({ type: "server_down", message: "Server is down" }));
                    ws.close(1000, "Going Away");
                    return;
                  }

                  if (name === "too_busy") {
                    sendSSE(
                      "error",
                      JSON.stringify({
                        type: "server_busy",
                        message: "Server is too busy. Try later, or another server",
                      }),
                    );
                    ws.close(1000, "Going Away");
                    return;
                  }

                  if (name === "version_maj" && value) {
                    sendSSE("msg", JSON.stringify({ type: "version_maj", value: parseInt(value) }));
                  }

                  if (name === "version_min" && value) {
                    sendSSE("msg", JSON.stringify({ type: "version_min", value: parseInt(value) }));
                  }

                  if (name === "audio_rate" && value) {
                    wsSend(`SET AR OK in=${parseInt(value)} out=44100`);
                  }

                  if (name === "sample_rate" && value) {
                    sampleRate = parseFloat(value);
                    sendSSE("msg", JSON.stringify({ type: "sample_rate", value: sampleRate }));
                    wsSend("SET squelch=0 max=0");
                    wsSend("SET genattn=0");
                    wsSend("SET gen=0 mix=-1");
                    wsSend(`SET mod=${mod} low_cut=${lc} high_cut=${hc} freq=${freq}`);
                    wsSend("SET agc=1 hang=0 thresh=-100 slope=6 decay=1000 manGain=50");
                    wsSend("SET compression=0");
                    wsSend("SET ident_user=F4DAN");
                    wsSend("SET keepalive");

                    sendSSE("status", JSON.stringify({ state: "connected", sampleRate }));

                    keepaliveInterval = setInterval(() => {
                      try {
                        if (ws.readyState === WebSocket.OPEN) {
                          wsSend("SET keepalive");
                        }
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

        ws.onerror = (e) => {
          if (closed) return;
          console.error("WebSocket error:", e);
          sendSSE("error", JSON.stringify({ type: "ws_error", message: "WebSocket connection error" }));
        };

        ws.onclose = () => {
          if (closed) return;
          const reason = clientCancelled ? "client" : "server";
          console.log(`WebSocket closed (reason: ${reason})`);
          if (keepaliveInterval) clearInterval(keepaliveInterval);
          sendSSE("closed", JSON.stringify({ message: "Connection closed", reason }));
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
      },
      cancel() {
        clientCancelled = true;
        try {
          ws.close(1000, "Going Away");
        } catch {
          // ignore
        }
      },
    });

    console.log(`[kiwi-stream ${Date.now()}] Returning SSE Response object to platform`);
    return new Response(stream, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (e) {
    console.error("kiwi-stream error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
