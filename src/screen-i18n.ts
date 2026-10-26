import { useI18n } from './i18n';

// The existing panel keeps its complete locale catalog. The new hardware
// controls ship Chinese with an explicit English fallback for other locales.
export function useScreenText() {
  const { language } = useI18n();
  return (chinese: string, english: string) => language.startsWith('zh') ? chinese : english;
}
