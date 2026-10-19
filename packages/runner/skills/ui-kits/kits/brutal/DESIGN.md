# Neo Brutal (`brutal`)

Neo-brutalism: garis hitam tebal, bayangan keras, kuning dan pink berani. Untuk aplikasi internal yang ingin berani dan mudah diingat.

Mode utama: **terang**. Tag: bold, playful, brutalism.

## Karakter

Neo-brutalism: jujur, keras, menyenangkan. Garis hitam 3px di semua elemen, bayangan keras tanpa blur (5px 5px 0 #000), warna primer pekat: kuning #FFD23F, pink #FF6B9A, krem #FFF8E7.

Signature:
- Tombol "mekanis": hover bergeser -2px dan bayangan membesar; ditekan menempel ke bayangan.
- Kartu statistik boleh berganti warna latar (kuning, pink) — maksimal dua kartu berwarna per baris.
- Header tabel berblok pink dengan garis bawah tebal; setiap baris dipisah garis hitam 2px.
- Lencana bergaris hitam; fokus input = bayangan pink keras.

Layout: sidebar hitam, menu aktif blok kuning; elemen besar dan berani; ruang kosong cukup supaya garis tebal tidak sesak.
Teks selalu hitam di atas warna terang (kontras tinggi). Merah hanya untuk bahaya.
Hindari: gradien, blur, bayangan lembut, abu-abu pucat, lebih dari tiga warna aksen.

## Token utama

Semua token ada di `tokens.css` (salin ke CSS global aplikasi, atau petakan ke tema Tailwind). Ringkasan:

| Token | Nilai |
|---|---|
| `--ui-bg` | `#FFF8E7` |
| `--ui-surface` | `#FFFFFF` |
| `--ui-text` | `#000000` |
| `--ui-muted` | `#3D3D3D` |
| `--ui-border` | `#000000` |
| `--ui-primary` | `#FFD23F` |
| `--ui-primary-text` | `#000000` |
| `--ui-accent` | `#FF6B9A` |
| `--ui-success` | `#007A3D` |
| `--ui-danger` | `#D10028` |
| `--ui-radius` | `8px` |
| `--ui-radius-sm` | `6px` |
| `--ui-shadow` | `5px 5px 0 #000` |

## Tipografi

- Judul: **Space Grotesk** · Badan: **Space Grotesk** · Angka/kode: **Space Mono**
- Paket font (dibundel bersama aplikasi, jangan Google Fonts/CDN): `@fontsource-variable/space-grotesk`, `@fontsource/space-mono` — dependensi baru, jadi lewat persetujuan.
- Skala: judul halaman `--ui-title-size`, judul kartu 17–20px, badan 15px, label 13px, keterangan 12px.

## Komponen

Kontrak kelas sama di semua kit (lihat `../../base.css`): app shell (`ui-app`, `ui-sidebar`, `ui-nav`, `ui-topbar`, `ui-content`), `ui-card`, `ui-stat`, `ui-btn-*`, `ui-field`/`ui-input`, `ui-table`, `ui-badge-*`, `ui-tabs`, `ui-alert`, `ui-dialog`, `ui-empty`, `ui-skeleton`, `ui-auth`. Kepribadian kit ini ada di `kit.css`. Di React/Tailwind, buat komponen sendiri (Button, Card, Table, Badge, Field…) yang memakai token yang sama — jangan menyalin HTML pratinjau mentah-mentah.

Pratinjau semua layar (login, dasbor, daftar, form, detail): `../../preview.html` dengan token dan `kit.css` kit ini.
