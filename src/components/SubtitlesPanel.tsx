import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { LANGUAGES, type LanguageCode, type TranscriptSegment } from "@/lib/constants";
import { Mic, MicOff, Loader2 } from "lucide-react";

function renderBoldMarkdown(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-bold text-green-500">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return part;
  });
}

interface SubtitlesPanelProps {
  committedTranscripts: TranscriptSegment[];
  partialTranscript: string;
  translations: Record<string, string>;
  translationErrors: Record<string, string>;
  targetLanguage: LanguageCode;
  onLanguageChange: (lang: LanguageCode) => void;
  transcriptionConnecting: boolean;
  transcriptionConnected: boolean;
  onTranscriptionToggle: () => void;
  isRadioConnected: boolean;
  detectedLanguage: string | null;
}

export default function SubtitlesPanel({
  committedTranscripts,
  partialTranscript,
  translations,
  translationErrors,
  targetLanguage,
  onLanguageChange,
  transcriptionConnected,
  transcriptionConnecting,
  onTranscriptionToggle,
  isRadioConnected,
  detectedLanguage,
}: SubtitlesPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottom = useRef<boolean>(true);

  const handleScroll = () => {
    if (scrollRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
      isAtBottom.current = scrollTop + clientHeight >= scrollHeight - 30;
    }
  };

  useEffect(() => {
    if (scrollRef.current && isAtBottom.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [committedTranscripts, partialTranscript, translations]);

  return (
    <div className="h-full flex flex-col rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-b border-border">
        <div className="flex items-center gap-3">
          <Button
            onClick={onTranscriptionToggle}
            disabled={!isRadioConnected || transcriptionConnecting}
            variant={transcriptionConnected ? "destructive" : "default"}
            size="sm"
            className="min-w-[140px]"
          >
            {transcriptionConnecting ? (
              <Loader2 className="mr-1 w-4 h-4 animate-spin" />
            ) : transcriptionConnected ? (
              <MicOff className="mr-1 w-4 h-4" />
            ) : (
              <Mic className="mr-1 w-4 h-4" />
            )}
            {transcriptionConnecting ? "Connecting…" : transcriptionConnected ? "Stop" : "Translate"}
          </Button>
          <div className="flex items-center gap-1.5">
            <div className={`w-2.5 h-2.5 rounded-full ${transcriptionConnected ? "bg-success" : "bg-destructive"}`} />
            <span className="text-xs text-muted-foreground">{transcriptionConnected ? "Active" : "Off"}</span>
          </div>
          {detectedLanguage && (
            <span className="text-xs text-muted-foreground">Detected: {detectedLanguage}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground">To:</Label>
          <Select value={targetLanguage} onValueChange={(v) => onLanguageChange(v as LanguageCode)}>
            <SelectTrigger className="w-[120px] h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map((lang) => (
                <SelectItem key={lang.code} value={lang.code}>
                  {lang.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4 space-y-4">
        {committedTranscripts.length === 0 && !partialTranscript && (
          <div className="flex flex-col h-full">
            <div className="text-muted-foreground text-sm text-center space-y-1.5 pt-6 pb-6">
              <p>1/ Select KiwiSDR on map</p>
              <p>2/ Select frequency and click on Connect</p>
              <p>3/ Click on Translate</p>
              <p className="pt-1 italic">Translations will appear here …</p>
            </div>
            <div className="space-y-4 px-1">
              {[0.75, 0.58, 0.42, 0.28, 0.16].map((opacity, i) => (
                <div key={i} className="space-y-1.5" style={{ opacity }}>
                  <div className="h-3 rounded bg-muted" style={{ width: `${[95, 75, 88, 80, 70][i]}%` }} />
                  <div className="h-3 rounded bg-muted ml-4" style={{ width: `${[60, 70, 50, 65, 45][i]}%` }} />
                </div>
              ))}
            </div>
          </div>
        )}

        {committedTranscripts.map((segment) => (
          <div key={segment.id} className="space-y-1">
            <p className="text-sm leading-relaxed">{segment.text}</p>
            {translations[segment.id] ? (
              <p className="text-sm text-primary leading-relaxed">↳ {renderBoldMarkdown(translations[segment.id])}</p>
            ) : translationErrors[segment.id] ? (
              <p className="text-xs text-destructive">⚠ {translationErrors[segment.id]}</p>
            ) : (
              <p className="text-xs text-muted-foreground italic">Translating…</p>
            )}
          </div>
        ))}

        {partialTranscript && (
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground italic leading-relaxed">{partialTranscript}</p>
          </div>
        )}
      </div>
    </div>
  );
}
