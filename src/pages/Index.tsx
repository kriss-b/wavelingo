import { useState, useCallback, useRef, useEffect } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIsMobile } from "@/hooks/use-mobile";
import { useKiwiSDR } from "@/hooks/useKiwiSDR";
import { useTranscription } from "@/hooks/useTranscription";
import { useTranslation } from "@/hooks/useTranslation";
import MapPanel from "@/components/MapPanel";
import ControlPanel from "@/components/ControlPanel";
import SubtitlesPanel from "@/components/SubtitlesPanel";
import { KIWI_SERVERS, type KiwiServer, type LanguageCode } from "@/lib/constants";
import { Map, Settings, Subtitles, Radio, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import ThemeToggle from "@/components/ThemeToggle";

const Index = () => {
  const isMobile = useIsMobile();
  const [betaTimeoutOpen, setBetaTimeoutOpen] = useState(false);
  const [selectedServer, setSelectedServer] = useState<KiwiServer | null>(
    KIWI_SERVERS[Math.floor(Math.random() * KIWI_SERVERS.length)],
  );
  const [frequency, setFrequency] = useState(7200);
  const modulation = frequency < 10000 ? "lsb" : "usb";
  const [targetLanguage, setTargetLanguage] = useState<LanguageCode>("EN");

  const transcription = useTranscription();

  // Store sendAudio in a ref so the kiwi onAudioData callback is stable
  const sendAudioRef = useRef(transcription.sendAudio);
  sendAudioRef.current = transcription.sendAudio;

  // Track transcription connected state in a ref for the audio callback
  const transcriptionConnectedRef = useRef(false);
  transcriptionConnectedRef.current = transcription.isConnected;

  const onAudioData = useCallback((pcmFloat32: Float32Array, sampleRate: number) => {
    // Only forward audio when transcription is active
    if (transcriptionConnectedRef.current) {
      sendAudioRef.current(pcmFloat32, sampleRate);
    }
  }, []);

  const kiwi = useKiwiSDR({ onAudioData });

  const { translations, errors: translationErrors } = useTranslation(
    transcription.committedTranscripts,
    targetLanguage,
  );

  // --- Independent handlers ---
  const handleRadioConnect = useCallback(async () => {
    if (!selectedServer) return;
    await kiwi.connect(selectedServer, frequency, modulation);
  }, [selectedServer, frequency, modulation, kiwi.connect]);

  const handleRadioDisconnect = useCallback(() => {
    // Also stop transcription if radio disconnects
    if (transcription.isConnected) {
      transcription.disconnect();
    }
    kiwi.disconnect();
  }, [kiwi.disconnect, transcription.isConnected, transcription.disconnect]);

  const handleTranscriptionToggle = useCallback(() => {
    if (transcription.isConnected) {
      transcription.disconnect();
    } else {
      transcription.connect();
    }
  }, [transcription.isConnected, transcription.connect, transcription.disconnect]);

  const handleVolumeChange = useCallback(
    (vol: number) => {
      kiwi.setVolume(vol);
    },
    [kiwi.setVolume],
  );

  const controlPanelProps = {
    status: kiwi.status,
    disconnectReason: kiwi.disconnectReason,
    audioLevel: kiwi.audioLevel,
    error: kiwi.error,
    selectedServer,
    frequency,
    modulation,
    onFrequencyChange: setFrequency,
    onRadioConnect: handleRadioConnect,
    onRadioDisconnect: handleRadioDisconnect,
    onVolumeChange: handleVolumeChange,
  };

  // Beta timeout: 60s limit on transcription
  useEffect(() => {
    if (!transcription.isConnected) return;
    const timer = setTimeout(() => {
      handleRadioDisconnect();
      setBetaTimeoutOpen(true);
    }, 60_000);
    return () => clearTimeout(timer);
  }, [transcription.isConnected, handleRadioDisconnect]);

  const betaModal = (
    <Dialog open={betaTimeoutOpen} onOpenChange={setBetaTimeoutOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Beta Limitation</DialogTitle>
          <DialogDescription>
            This app is in beta mode and limited to 60-second translations. Join the Telegram group to be informed of updates or ask any question.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button asChild>
            <a href="https://t.me/+l5Y_cyYFsXBhODBk" target="_blank" rel="noopener noreferrer">
              <Send className="w-4 h-4 mr-1" /> Join Telegram
            </a>
          </Button>
          <Button variant="outline" onClick={() => setBetaTimeoutOpen(false)}>OK</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  // Mobile: tabbed layout
  if (isMobile) {
    return (
      <div className="h-screen flex flex-col bg-background">
        <header className="px-4 py-2 border-b border-border bg-card flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <h1 className="text-lg font-bold text-primary">Wavelingo</h1>
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">beta</Badge>
          </div>
           <div className="flex items-center gap-2">
            <a href="https://t.me/+l5Y_cyYFsXBhODBk" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors">
              <Send className="w-3 h-3" />
            </a>
            <span className="text-xs text-muted-foreground">by F4DAN</span>
            <ThemeToggle />
          </div>
        </header>
        <Tabs defaultValue="map" className="flex-1 flex flex-col min-h-0">
          <TabsList className="mx-4 mt-2">
            <TabsTrigger value="map" className="flex items-center gap-1">
              <Map className="w-4 h-4" /> Map
            </TabsTrigger>
            <TabsTrigger value="controls" className="flex items-center gap-1">
              <Settings className="w-4 h-4" /> Controls
            </TabsTrigger>
            <TabsTrigger value="subtitles" className="flex items-center gap-1">
              <Subtitles className="w-4 h-4" /> Translations
            </TabsTrigger>
          </TabsList>
          <TabsContent value="map" className="flex-1 px-4 pb-4 h-full min-h-0">
            <MapPanel selectedServer={selectedServer} onSelectServer={setSelectedServer} />
          </TabsContent>
          <TabsContent value="controls" className="flex-1 px-4 pb-4">
            <ControlPanel {...controlPanelProps} />
          </TabsContent>
          <TabsContent value="subtitles" className="flex-1 px-4 pb-4">
            <SubtitlesPanel
              committedTranscripts={transcription.committedTranscripts}
              partialTranscript={transcription.partialTranscript}
              translations={translations}
              translationErrors={translationErrors}
              targetLanguage={targetLanguage}
              onLanguageChange={setTargetLanguage}
              transcriptionConnected={transcription.isConnected}
              transcriptionConnecting={transcription.isConnecting}
              onTranscriptionToggle={handleTranscriptionToggle}
              isRadioConnected={kiwi.status === "connected"}
              detectedLanguage={transcription.detectedLanguage}
            />
          </TabsContent>
        </Tabs>
        {betaModal}
      </div>
    );
  }

  // Desktop: grid layout
  return (
    <div className="h-screen flex flex-col bg-background">
      <header className="px-6 py-3 border-b border-border bg-card flex items-center gap-3">
        <Radio className="w-5 h-5 text-primary" />
        <h1 className="text-lg font-bold">Wavelingo</h1>
        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">beta</Badge>
        <a href="https://t.me/+l5Y_cyYFsXBhODBk" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors ml-auto">
          <Send className="w-3.5 h-3.5" /> Join Telegram
        </a>
        <span className="text-xs text-muted-foreground">by F4DAN</span>
        <ThemeToggle />
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Left half: map + controls */}
        <div className="w-1/2 flex flex-col border-r border-border">
          <div className="flex-1 p-3">
            <MapPanel selectedServer={selectedServer} onSelectServer={setSelectedServer} />
          </div>
          <div className="p-3 pt-0">
            <ControlPanel {...controlPanelProps} />
          </div>
        </div>

        {/* Right half: subtitles */}
        <div className="w-1/2 p-3">
          <SubtitlesPanel
            committedTranscripts={transcription.committedTranscripts}
            partialTranscript={transcription.partialTranscript}
            translations={translations}
            translationErrors={translationErrors}
            targetLanguage={targetLanguage}
            onLanguageChange={setTargetLanguage}
            transcriptionConnected={transcription.isConnected}
            transcriptionConnecting={transcription.isConnecting}
            onTranscriptionToggle={handleTranscriptionToggle}
            isRadioConnected={kiwi.status === "connected"}
            detectedLanguage={transcription.detectedLanguage}
          />
        </div>
      </div>
      {betaModal}
    </div>
  );
};

export default Index;
