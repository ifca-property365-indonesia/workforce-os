# Clay Ceria (`clay`)

Claymorphism pastel: sudut sangat membulat, bayangan lembut timbul, warna lavender dan pink. Untuk aplikasi penghuni, pelanggan, dan layanan yang ramah.

Mode utama: **terang**. Tag: playful, pastel, friendly.

## Karakter

Claymorphism yang ceria tapi tetap rapi: latar lavender (#F3EEFF), kartu putih "timbul" dengan bayangan ganda (gelap kanan-bawah, terang kiri-atas), sudut 24px, tombol pil yang terasa bisa ditekan.

Signature:
- Bayangan clay: outer lembut ungu + highlight putih + inner highlight; input justru "cekung" (inner shadow).
- Hover tombol sedikit naik dan membesar 2%; animasi lembut ≤ 200ms.
- Avatar dan aksen gradien ungu→pink; ilustrasi dan ikon bundar.

Layout: lega dan ramah; jarak 20–28px; satu tindakan utama per layar yang jelas. Cocok untuk aplikasi penghuni, booking fasilitas, keluhan, loyalti.
Kontras: teks #2E2A47 di putih; tombol utama ungu #6440E6 dengan teks putih (lolos AA).
Hindari: garis tegas, sudut tajam, tabel sangat padat (pakai daftar kartu di HP), lebih dari dua warna pastel per layar, bayangan hitam.

## Token utama

Semua token ada di `tokens.css` (salin ke CSS global aplikasi, atau petakan ke tema Tailwind). Ringkasan:

| Token | Nilai |
|---|---|
| `--ui-bg` | `#F3EEFF` |
| `--ui-surface` | `#FFFFFF` |
| `--ui-text` | `#2E2A47` |
| `--ui-muted` | `#5F5A7D` |
| `--ui-border` | `#E4DDF7` |
| `--ui-primary` | `#6440E6` |
| `--ui-primary-text` | `#FFFFFF` |
| `--ui-accent` | `#FF7AA2` |
| `--ui-success` | `#13784F` |
| `--ui-danger` | `#C7254E` |
| `--ui-radius` | `24px` |
| `--ui-radius-sm` | `16px` |
| `--ui-shadow` | `10px 10px 24px rgba(108,86,196,.16), -8px -8px 20px rgba(255,255,255,.9)` |

## Tipografi

- Judul: **Nunito** · Badan: **Nunito** · Angka/kode: **JetBrains Mono**
- Paket font (dibundel bersama aplikasi, jangan Google Fonts/CDN): `@fontsource-variable/jetbrains-mono`, `@fontsource-variable/nunito` — dependensi baru, jadi lewat persetujuan.
- Skala: judul halaman `--ui-title-size`, judul kartu 17–20px, badan 15px, label 13px, keterangan 12px.

## Komponen

Kontrak kelas sama di semua kit (lihat `../../base.css`): app shell (`ui-app`, `ui-sidebar`, `ui-nav`, `ui-topbar`, `ui-content`), `ui-card`, `ui-stat`, `ui-btn-*`, `ui-field`/`ui-input`, `ui-table`, `ui-badge-*`, `ui-tabs`, `ui-alert`, `ui-dialog`, `ui-empty`, `ui-skeleton`, `ui-auth`. Kepribadian kit ini ada di `kit.css`. Di React/Tailwind, buat komponen sendiri (Button, Card, Table, Badge, Field…) yang memakai token yang sama — jangan menyalin HTML pratinjau mentah-mentah.

Pratinjau semua layar (login, dasbor, daftar, form, detail): `../../preview.html` dengan token dan `kit.css` kit ini.
