# Swiss Grid (`swiss`)

Gaya Swiss: grid ketat, hitam-putih dengan satu merah sinyal, tanpa sudut membulat. Untuk aplikasi data yang harus terasa presisi dan tenang.

Mode utama: **terang**. Tag: minimal, grid, typographic.

## Karakter

Presisi ala desain grafis Swiss: grid, hierarki tipografi, dan ruang kosong yang melakukan semua pekerjaan. Hitam di atas putih; merah sinyal (#D7000F) hanya untuk SATU hal terpenting per layar (tombol utama, status kritis, menu aktif).

Signature:
- Nol radius di mana pun. Tidak ada bayangan. Pemisah adalah garis 1px hitam; kartu punya garis atas 4px.
- Judul besar (40px, 800, tracking -0.035em, line-height 1); eyebrow merah huruf kapital berjarak lebar.
- Input bergaya garis bawah saja; fokus = garis bawah 2px (tetap terlihat jelas).
- Tombol dan menu huruf kapital kecil (12px, tracking .08em).

Layout: grid 12 kolom; semua tepi sejajar; sidebar hitam, menu aktif blok merah. Kepadatan sedang-tinggi: aplikasi data, banyak tabel.
Tabel: tanpa garis vertikal, header bergaris bawah 2px, angka mono rata kanan.
Status: lencana persegi huruf kapital; merah hanya untuk kritis, hijau gelap untuk selesai.
Hindari: warna tambahan, ikon dekoratif, gradien, sudut membulat, lebih dari satu elemen merah besar per layar.

## Token utama

Semua token ada di `tokens.css` (salin ke CSS global aplikasi, atau petakan ke tema Tailwind). Ringkasan:

| Token | Nilai |
|---|---|
| `--ui-bg` | `#FFFFFF` |
| `--ui-surface` | `#FFFFFF` |
| `--ui-text` | `#111111` |
| `--ui-muted` | `#5C5C5C` |
| `--ui-border` | `#111111` |
| `--ui-primary` | `#D7000F` |
| `--ui-primary-text` | `#FFFFFF` |
| `--ui-accent` | `#111111` |
| `--ui-success` | `#0A7A33` |
| `--ui-danger` | `#D7000F` |
| `--ui-radius` | `0px` |
| `--ui-radius-sm` | `0px` |
| `--ui-shadow` | `none` |

## Tipografi

- Judul: **Inter Tight** · Badan: **Inter** · Angka/kode: **JetBrains Mono**
- Paket font (dibundel bersama aplikasi, jangan Google Fonts/CDN): `@fontsource-variable/inter`, `@fontsource-variable/inter-tight`, `@fontsource-variable/jetbrains-mono` — dependensi baru, jadi lewat persetujuan.
- Skala: judul halaman `--ui-title-size`, judul kartu 17–20px, badan 15px, label 13px, keterangan 12px.

## Komponen

Kontrak kelas sama di semua kit (lihat `../../base.css`): app shell (`ui-app`, `ui-sidebar`, `ui-nav`, `ui-topbar`, `ui-content`), `ui-card`, `ui-stat`, `ui-btn-*`, `ui-field`/`ui-input`, `ui-table`, `ui-badge-*`, `ui-tabs`, `ui-alert`, `ui-dialog`, `ui-empty`, `ui-skeleton`, `ui-auth`. Kepribadian kit ini ada di `kit.css`. Di React/Tailwind, buat komponen sendiri (Button, Card, Table, Badge, Field…) yang memakai token yang sama — jangan menyalin HTML pratinjau mentah-mentah.

Pratinjau semua layar (login, dasbor, daftar, form, detail): `../../preview.html` dengan token dan `kit.css` kit ini.
