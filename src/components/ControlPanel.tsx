import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import type { ConnectionStatus, KiwiServer } from "@/lib/constants";
import type { DisconnectReason } from "@/hooks/useKiwiSDR";
import { Radio, Wifi, WifiOff, Loader2, Volume2, AlertTriangle } from "lucide-react";

interface ControlPanelProps {
  status: ConnectionStatus;
  disconnectReason: DisconnectReason;
  audioLevel: number;
  error: string | null;
  selectedServer: KiwiServer | null;
  frequency: number;
  modulation: string;
  onFrequencyChange: (freq: number) => void;
  onRadioConnect: () => void;
  onRadioDisconnect: () => void;
  onVolumeChange: (vol: number) => void;
}

const STATUS_CONFIG = {
  disconnected: { color: "bg-destructive", label: "Disconnected", icon: WifiOff },
  connecting: { color: "bg-warning", label: "Connecting…", icon: Loader2 },
  connected: { color: "bg-success", label: "Connected", icon: Wifi },
};

const DISCONNECT_MESSAGES: Record<string, string> = {
  server: "Server is currently busy. Try another one",
  server_down: "Server is down",
  too_busy: "Server is too busy — try another server",
  timeout: "Connection timed out",
};

export default function ControlPanel({
  status,
  disconnectReason,
  audioLevel,
  error,
  selectedServer,
  frequency,
  modulation,
  onFrequencyChange,
  onRadioConnect,
  onRadioDisconnect,
  onVolumeChange,
}: ControlPanelProps) {
  const cfg = STATUS_CONFIG[status];
  const Icon = cfg.icon;

  const isRadioConnected = status === "connected";

  return (
    <div className="h-full flex flex-col gap-3 p-4 rounded-lg border border-border bg-card">
      {/* Connection buttons row */}
      <div className="flex items-center gap-3 flex-wrap">
        {/* Radio connect/disconnect */}
        <Button
          onClick={status === "disconnected" ? onRadioConnect : onRadioDisconnect}
          disabled={status === "connecting" || (!selectedServer && status === "disconnected")}
          variant={isRadioConnected ? "destructive" : "default"}
          className="min-w-[150px]"
        >
          {status === "connecting" ? <Loader2 className="animate-spin mr-1" /> : <Radio className="mr-1" />}
          {status === "disconnected" ? "Connect" : status === "connecting" ? "Connecting" : "Disconnect"}
        </Button>

        <div className="flex items-center gap-2">
          <div className={`w-3 h-3 rounded-full ${cfg.color} ${status === "connecting" ? "animate-pulse" : ""}`} />
          <span className="text-sm text-muted-foreground">
            <Icon className="inline w-4 h-4 mr-1" />
            Radio: {cfg.label}
          </span>
        </div>
      </div>

      {error && <div className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">{error}</div>}

      {status === "disconnected" &&
        disconnectReason &&
        disconnectReason !== "client" &&
        DISCONNECT_MESSAGES[disconnectReason] && (
          <div className="flex items-center gap-2 text-sm text-warning bg-warning/10 rounded-md px-3 py-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {DISCONNECT_MESSAGES[disconnectReason]}
          </div>
        )}

      {/* Frequency + modulation */}
      <div className="flex gap-3 items-end">
        <div>
          <Label className="text-xs text-muted-foreground mb-1 block">Frequency (kHz)</Label>
          <Input
            type="number"
            value={frequency}
            onChange={(e) => onFrequencyChange(Number(e.target.value))}
            min={0}
            max={30000}
            step={0.1}
            disabled={isRadioConnected}
            className="font-mono min-w-[150px] w-[150px]"
          />
        </div>
        <div className="flex items-end pb-2">
          <Badge variant="secondary" className="font-mono text-sm">
            {modulation.toUpperCase()}
          </Badge>
        </div>
      </div>

      {/* Meters */}
      <div className="space-y-2">
        <div>
          <Label className="text-xs text-muted-foreground">Audio Level</Label>
          <div className="h-3 w-full bg-secondary rounded-full overflow-hidden mt-1">
            <div className="h-full bg-primary transition-all duration-75" style={{ width: `${audioLevel * 100}%` }} />
          </div>
        </div>
      </div>

      {/* Volume */}
      <div className="flex items-center gap-2">
        <Volume2 className="w-4 h-4 text-muted-foreground shrink-0" />
        <Slider
          defaultValue={[0.7]}
          max={1}
          step={0.01}
          onValueChange={([v]) => onVolumeChange(v)}
          className="flex-1"
        />
      </div>
    </div>
  );
}
