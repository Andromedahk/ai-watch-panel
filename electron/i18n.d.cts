export type Language = 'system' | 'zh-CN' | 'zh-HK' | 'zh-TW' | 'en' | 'ja' | 'ko' | 'ru' | 'uk' | 'es' | 'pt' | 'fr' | 'de' | 'it' | 'vi' | 'hi' | 'he' | 'ar';
export type I18n = { language: Exclude<Language, 'system'>; dir: 'ltr' | 'rtl'; t(key: string, params?: Record<string, unknown>): string; label(value: string): string; number(value: number | string, options?: Intl.NumberFormatOptions): string; percent(value: number): string; date(value: string, options?: Intl.DateTimeFormatOptions): string; isolate(value: string): string };
export const languages: { id: Exclude<Language, 'system'>; name: string; dir: 'ltr' | 'rtl' }[];
export function isLanguage(value: unknown): value is Language;
export function resolveLanguage(value: unknown, system?: string | string[]): Exclude<Language, 'system'>;
export function createI18n(language: unknown, system?: string | string[]): I18n;
export const catalogs: Record<string, Record<string, string>>;
