import { useState, useEffect, useRef, useCallback } from "react";
import type { TranscriptSegment, LanguageCode } from "@/lib/constants";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

export function useTranslation(
  committedTranscripts: TranscriptSegment[],
  targetLanguage: LanguageCode
) {
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const processedRef = useRef<Set<string>>(new Set());

  const translateSegment = useCallback(
    async (segment: TranscriptSegment, lang: LanguageCode) => {
      try {
        const response = await fetch(`${SUPABASE_URL}/functions/v1/translate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: segment.text,
            targetLanguage: lang,
            segmentId: segment.id,
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          setErrors((prev) => ({ ...prev, [segment.id]: data.error || "Translation failed" }));
          return;
        }

        setTranslations((prev) => ({ ...prev, [segment.id]: data.translation }));
      } catch (e: any) {
        setErrors((prev) => ({ ...prev, [segment.id]: e.message || "Network error" }));
      }
    },
    []
  );

  useEffect(() => {
    if (committedTranscripts.length === 0) {
      setTranslations({});
      setErrors({});
      processedRef.current.clear();
      return;
    }
    for (const segment of committedTranscripts) {
      const key = `${segment.id}:${targetLanguage}`;
      if (!processedRef.current.has(key)) {
        processedRef.current.add(key);
        translateSegment(segment, targetLanguage);
      }
    }
  }, [committedTranscripts, targetLanguage, translateSegment]);

  // Reset when language changes
  const prevLangRef = useRef(targetLanguage);
  useEffect(() => {
    if (prevLangRef.current !== targetLanguage) {
      prevLangRef.current = targetLanguage;
      setTranslations({});
      setErrors({});
      // Re-translate all existing segments
      for (const segment of committedTranscripts) {
        const key = `${segment.id}:${targetLanguage}`;
        processedRef.current.add(key);
        translateSegment(segment, targetLanguage);
      }
    }
  }, [targetLanguage, committedTranscripts, translateSegment]);

  return { translations, errors };
}
