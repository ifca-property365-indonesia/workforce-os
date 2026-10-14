import { isLocale, type Locale } from "@wfos/shared";

/**
 * Bilingual notification texts for app deploys (same shape and {name} placeholders as @wfos/shared/messages; kept
 * here until they move into the shared catalog).
 */
const MESSAGES = {
  en: {
    "app.deployed": "Preview updated: {name}",
    "app.deployedLive": "LIVE updated: {name}",
    "app.deployedText": "{name} now runs {commit} ({subject}).\nOpen it at {url}",
    "app.deployFailed": "Deploy failed: {name}",
    "app.deployFailedText": "The deploy of {commit} failed at the {step} step: {error}\n{state}",
    "app.stateOldRuns": "The previous version keeps running.",
    "app.stateNothingRuns": "No version of the app is running now.",
    "app.rolledBack": "Deploy rolled back: {name}",
    "app.rolledBackText": "{commit} was switched on but failed at the {step} step ({error}). The previous version ({previous}) runs again at {url}",
    "app.unhealthy": "{name} is not answering",
    "app.unhealthyText": "The hourly health check of {name} failed ({detail}). Open the Apps window to look at it, or deploy a fix.",
    "app.liveRemoved": "LIVE removed: {name}",
    "app.liveRemovedText": "The LIVE environment of {name} ({domain}) was removed from server {server}. Its database was saved first to {path} on that server (kept 30 days).",
    "app.liveRemovedNoDumpText": "The LIVE environment of {name} ({domain}) was removed from server {server}. The server reported no database dump (the app may have had no database).",
    "app.idleStopped": "Preview stopped: {name}",
    "app.idleStoppedText": "{name} had no new release for {days} days and was stopped to free the server. Start it again from the Apps window.",
  },
  id: {
    "app.deployed": "Preview diperbarui: {name}",
    "app.deployedLive": "LIVE diperbarui: {name}",
    "app.deployedText": "{name} sekarang menjalankan {commit} ({subject}).\nBuka di {url}",
    "app.deployFailed": "Deploy gagal: {name}",
    "app.deployFailedText": "Deploy {commit} gagal di langkah {step}: {error}\n{state}",
    "app.stateOldRuns": "Versi sebelumnya tetap berjalan.",
    "app.stateNothingRuns": "Saat ini tidak ada versi aplikasi yang berjalan.",
    "app.rolledBack": "Deploy dibatalkan: {name}",
    "app.rolledBackText": "{commit} sempat dinyalakan tetapi gagal di langkah {step} ({error}). Versi sebelumnya ({previous}) kembali berjalan di {url}",
    "app.unhealthy": "{name} tidak merespons",
    "app.unhealthyText": "Pemeriksaan kesehatan per jam untuk {name} gagal ({detail}). Buka jendela Aplikasi untuk memeriksanya, atau deploy perbaikan.",
    "app.liveRemoved": "LIVE dihapus: {name}",
    "app.liveRemovedText": "Lingkungan LIVE {name} ({domain}) telah dihapus dari server {server}. Database-nya lebih dulu disimpan ke {path} di server itu (disimpan 30 hari).",
    "app.liveRemovedNoDumpText": "Lingkungan LIVE {name} ({domain}) telah dihapus dari server {server}. Server tidak melaporkan cadangan database (mungkin aplikasinya tidak punya database).",
    "app.idleStopped": "Preview dihentikan: {name}",
    "app.idleStoppedText": "{name} tidak punya rilis baru selama {days} hari dan dihentikan supaya server lega. Jalankan lagi dari jendela Aplikasi.",
  },
} satisfies Record<Locale, Record<string, string>>;

export type AppMessageKey = keyof (typeof MESSAGES)["en"];

export function appMsg(locale: string | null | undefined, key: AppMessageKey, values: Record<string, string | number> = {}): string {
  const l: Locale = isLocale(locale) ? locale : "en";
  return MESSAGES[l][key].replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}
