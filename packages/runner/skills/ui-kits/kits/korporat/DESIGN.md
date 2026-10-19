# Korporat (`korporat`)

Enterprise modern yang hangat: indigo ke violet, bayangan berwarna, kartu yang terangkat saat disentuh. Cocok untuk portal pelanggan dan ERP yang ingin terasa premium.

Mode utama: **terang**. Tag: enterprise, saas, gradient.

## Karakter

Enterprise yang hangat dan tepercaya. Struktur bersih dan tipografi tegas memberi rasa aman; gradien indigo→violet dan bayangan berwarna memberi energi. Bukan korporat yang dingin.

Signature (pakai, jangan berlebihan):
- Bayangan bertinta indigo (bukan abu-abu) pada kartu dan tombol utama; kartu naik 2px saat hover.
- Gradien indigo→violet hanya di tombol utama, tanda merek, dan judul halaman (teks gradien). Sisanya putih dan slate.
- Satu "blob" cahaya violet buram di belakang konten halaman; tidak pernah di belakang tabel atau form.

Layout: sidebar putih dengan menu aktif berlatar indigo muda; konten maksimal 1280px; jarak antar bagian 24px; angka statistik besar (800) berwarna indigo tua.
Tabel: header huruf kecil kapital abu, baris bersih tanpa zebra, hover slate-100; angka rata kanan, tabular.
Form: label semibold slate-700, input radius 10px, fokus cincin indigo 3px. Tombol utama pil gradien; sekunder putih bergaris.
Status: hijau (lunas/aktif), kuning (jatuh tempo), merah (tunggakan/gagal), indigo (info/baru) — selalu lencana pil dengan teks, jangan hanya warna.
Hindari: gradien di latar tabel/form, lebih dari satu blob per layar, bayangan abu-abu netral, teks gradien di paragraf.

## Token utama

Semua token ada di `tokens.css` (salin ke CSS global aplikasi, atau petakan ke tema Tailwind). Ringkasan:

| Token | Nilai |
|---|---|
| `--ui-bg` | `#F8FAFC` |
| `--ui-surface` | `#FFFFFF` |
| `--ui-text` | `#0F172A` |
| `--ui-muted` | `#5B6478` |
| `--ui-border` | `#E2E8F0` |
| `--ui-primary` | `#4F46E5` |
| `--ui-primary-text` | `#FFFFFF` |
| `--ui-accent` | `#7C3AED` |
| `--ui-success` | `#047857` |
| `--ui-danger` | `#DC2626` |
| `--ui-radius` | `14px` |
| `--ui-radius-sm` | `10px` |
| `--ui-shadow` | `0 4px 20px -2px rgba(79,70,229,.10)` |

## Tipografi

- Judul: **Plus Jakarta Sans** · Badan: **Plus Jakarta Sans** · Angka/kode: **JetBrains Mono**
- Paket font (dibundel bersama aplikasi, jangan Google Fonts/CDN): `@fontsource-variable/jetbrains-mono`, `@fontsource-variable/plus-jakarta-sans` — dependensi baru, jadi lewat persetujuan.
- Skala: judul halaman `--ui-title-size`, judul kartu 17–20px, badan 15px, label 13px, keterangan 12px.

## Komponen

Kontrak kelas sama di semua kit (lihat `../../base.css`): app shell (`ui-app`, `ui-sidebar`, `ui-nav`, `ui-topbar`, `ui-content`), `ui-card`, `ui-stat`, `ui-btn-*`, `ui-field`/`ui-input`, `ui-table`, `ui-badge-*`, `ui-tabs`, `ui-alert`, `ui-dialog`, `ui-empty`, `ui-skeleton`, `ui-auth`. Kepribadian kit ini ada di `kit.css`. Di React/Tailwind, buat komponen sendiri (Button, Card, Table, Badge, Field…) yang memakai token yang sama — jangan menyalin HTML pratinjau mentah-mentah.

Pratinjau semua layar (login, dasbor, daftar, form, detail): `../../preview.html` dengan token dan `kit.css` kit ini.
