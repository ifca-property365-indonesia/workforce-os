# Industri (`industri`)

Industrial/terminal: grafit gelap, aksen amber, huruf monospace kapital, sudut tajam. Untuk aplikasi teknik, gudang, maintenance, dan alat internal developer.

Mode utama: **gelap**. Tag: dark, mono, technical.

## Karakter

Panel kontrol industri: grafit gelap (#16181D), amber (#F5A524) untuk aksi dan nilai penting, teal (#4FD1C5) sebagai aksen sekunder. Judul, label, menu, dan tabel memakai IBM Plex Mono huruf kapital; teks panjang memakai IBM Plex Sans.

Signature:
- Sudut tajam (2px), tanpa bayangan; kartu punya garis kiri 3px yang menyala amber saat hover.
- Tombol utama bergaris diagonal (tanda bahaya halus); menu aktif ditandai ▸ amber.
- Lencana status = "LED": titik bercahaya + garis tepi, latar transparan.
- Tabel monospace 13px dengan zebra sangat halus — terasa seperti log mesin.

Layout: padat dan fungsional; cocok untuk gudang, maintenance, IoT, alat internal. Mode gelap adalah mode utama.
Kontras: teks #E8E6E3, sekunder #A3A09A; teks di tombol amber selalu gelap (#1A1300).
Hindari: sudut membulat besar, gradien warna-warni, font dekoratif, warna pastel.

## Token utama

Semua token ada di `tokens.css` (salin ke CSS global aplikasi, atau petakan ke tema Tailwind). Ringkasan:

| Token | Nilai |
|---|---|
| `--ui-bg` | `#16181D` |
| `--ui-surface` | `#1E2128` |
| `--ui-text` | `#E8E6E3` |
| `--ui-muted` | `#A3A09A` |
| `--ui-border` | `#3A3F4A` |
| `--ui-primary` | `#F5A524` |
| `--ui-primary-text` | `#1A1300` |
| `--ui-accent` | `#4FD1C5` |
| `--ui-success` | `#4ADE80` |
| `--ui-danger` | `#F87171` |
| `--ui-radius` | `2px` |
| `--ui-radius-sm` | `2px` |
| `--ui-shadow` | `none` |

## Tipografi

- Judul: **IBM Plex Mono** · Badan: **IBM Plex Sans** · Angka/kode: **IBM Plex Mono**
- Paket font (dibundel bersama aplikasi, jangan Google Fonts/CDN): `@fontsource/ibm-plex-mono`, `@fontsource/ibm-plex-sans` — dependensi baru, jadi lewat persetujuan.
- Skala: judul halaman `--ui-title-size`, judul kartu 17–20px, badan 15px, label 13px, keterangan 12px.

## Komponen

Kontrak kelas sama di semua kit (lihat `../../base.css`): app shell (`ui-app`, `ui-sidebar`, `ui-nav`, `ui-topbar`, `ui-content`), `ui-card`, `ui-stat`, `ui-btn-*`, `ui-field`/`ui-input`, `ui-table`, `ui-badge-*`, `ui-tabs`, `ui-alert`, `ui-dialog`, `ui-empty`, `ui-skeleton`, `ui-auth`. Kepribadian kit ini ada di `kit.css`. Di React/Tailwind, buat komponen sendiri (Button, Card, Table, Badge, Field…) yang memakai token yang sama — jangan menyalin HTML pratinjau mentah-mentah.

Pratinjau semua layar (login, dasbor, daftar, form, detail): `../../preview.html` dengan token dan `kit.css` kit ini.
