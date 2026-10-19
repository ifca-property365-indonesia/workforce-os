# Editorial (`editorial`)

Gaya majalah: judul serif besar, kertas hangat, aksen burgundy, garis tipis. Untuk aplikasi laporan, legal, dan portal manajemen yang ingin berwibawa.

Mode utama: **terang**. Tag: serif, editorial, elegant.

## Karakter

Majalah bisnis yang berwibawa: kertas hangat (#FAF7F0), judul serif besar (Fraunces, optical size tinggi), badan sans yang mudah dibaca (Source Sans 3), satu aksen burgundy (#7F1D1D).

Signature:
- Judul halaman 44px dengan garis ganda di bawahnya; eyebrow small-caps burgundy.
- Garis tipis 1px dan pemisah ganda menggantikan bayangan; sudut nyaris tajam (2–4px).
- Header tabel miring (italic), bukan kapital; angka di kolom kanan, tabular.

Layout: lebar baca terbatas (paragraf ≤ 72 karakter); margin lega; sidebar kertas lebih gelap dengan garis ganda.
Cocok untuk laporan, notulen, dokumen hukum, dasbor direksi: banyak teks, sedikit dekorasi.
Hindari: warna cerah, gradien, ikon besar berwarna, sudut membulat besar, serif untuk teks tabel atau form (hanya judul).

## Token utama

Semua token ada di `tokens.css` (salin ke CSS global aplikasi, atau petakan ke tema Tailwind). Ringkasan:

| Token | Nilai |
|---|---|
| `--ui-bg` | `#FAF7F0` |
| `--ui-surface` | `#FFFDF8` |
| `--ui-text` | `#1C1917` |
| `--ui-muted` | `#57534E` |
| `--ui-border` | `#D6D3D1` |
| `--ui-primary` | `#7F1D1D` |
| `--ui-primary-text` | `#FFFFFF` |
| `--ui-accent` | `#B45309` |
| `--ui-success` | `#166534` |
| `--ui-danger` | `#B91C1C` |
| `--ui-radius` | `4px` |
| `--ui-radius-sm` | `2px` |
| `--ui-shadow` | `none` |

## Tipografi

- Judul: **Fraunces** · Badan: **Source Sans 3** · Angka/kode: **IBM Plex Mono**
- Paket font (dibundel bersama aplikasi, jangan Google Fonts/CDN): `@fontsource-variable/fraunces`, `@fontsource-variable/source-sans-3`, `@fontsource/ibm-plex-mono` — dependensi baru, jadi lewat persetujuan.
- Skala: judul halaman `--ui-title-size`, judul kartu 17–20px, badan 15px, label 13px, keterangan 12px.

## Komponen

Kontrak kelas sama di semua kit (lihat `../../base.css`): app shell (`ui-app`, `ui-sidebar`, `ui-nav`, `ui-topbar`, `ui-content`), `ui-card`, `ui-stat`, `ui-btn-*`, `ui-field`/`ui-input`, `ui-table`, `ui-badge-*`, `ui-tabs`, `ui-alert`, `ui-dialog`, `ui-empty`, `ui-skeleton`, `ui-auth`. Kepribadian kit ini ada di `kit.css`. Di React/Tailwind, buat komponen sendiri (Button, Card, Table, Badge, Field…) yang memakai token yang sama — jangan menyalin HTML pratinjau mentah-mentah.

Pratinjau semua layar (login, dasbor, daftar, form, detail): `../../preview.html` dengan token dan `kit.css` kit ini.
