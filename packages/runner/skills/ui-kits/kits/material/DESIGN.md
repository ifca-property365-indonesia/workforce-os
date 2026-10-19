# Material Lembut (`material`)

Terinspirasi Material 3: permukaan bertonal teal, tombol pil, elevasi lembut. Familiar untuk pengguna Android; cocok untuk aplikasi operasional harian.

Mode utama: **terang**. Tag: material, friendly, tonal.

## Karakter

Material 3 yang tenang: warna bertonal dari satu teal (#00696B), permukaan berlapis lembut, sudut 12–16px, tombol pil. Terasa familiar dan ramah untuk staf lapangan dan admin.

Signature:
- Tonal, bukan garis: kartu tanpa border di atas latar sedikit lebih gelap; elevasi lewat bayangan tipis.
- Menu aktif = pil teal muda (#CCE8E7) dengan teks teal sangat gelap.
- Input "filled": latar tonal, garis bawah, fokus garis bawah 2px teal.
- Tombol sekunder = tonal (latar teal muda), bukan bergaris.

Layout: navigation rail/sidebar tonal, top app bar menyatu dengan latar; jarak 8px grid; ikon outline 20–24px.
Tabel: header berlatar tonal, huruf biasa (bukan kapital); baris 48px; aksi baris berupa ikon-tombol bulat.
Ramah sentuh: target minimal 44px, FAB untuk aksi utama di HP.
Hindari: garis tebal, gradien, warna di luar palet tonal, bayangan besar.

## Token utama

Semua token ada di `tokens.css` (salin ke CSS global aplikasi, atau petakan ke tema Tailwind). Ringkasan:

| Token | Nilai |
|---|---|
| `--ui-bg` | `#F4F8F7` |
| `--ui-surface` | `#FBFDFC` |
| `--ui-text` | `#191C1C` |
| `--ui-muted` | `#3F4948` |
| `--ui-border` | `#BFC8C7` |
| `--ui-primary` | `#00696B` |
| `--ui-primary-text` | `#FFFFFF` |
| `--ui-accent` | `#4A6363` |
| `--ui-success` | `#2E7D32` |
| `--ui-danger` | `#BA1A1A` |
| `--ui-radius` | `16px` |
| `--ui-radius-sm` | `12px` |
| `--ui-shadow` | `0 1px 2px rgba(0,0,0,.08), 0 1px 3px 1px rgba(0,0,0,.05)` |

## Tipografi

- Judul: **Roboto Flex** · Badan: **Roboto Flex** · Angka/kode: **Roboto Mono**
- Paket font (dibundel bersama aplikasi, jangan Google Fonts/CDN): `@fontsource-variable/roboto-flex`, `@fontsource-variable/roboto-mono` — dependensi baru, jadi lewat persetujuan.
- Skala: judul halaman `--ui-title-size`, judul kartu 17–20px, badan 15px, label 13px, keterangan 12px.

## Komponen

Kontrak kelas sama di semua kit (lihat `../../base.css`): app shell (`ui-app`, `ui-sidebar`, `ui-nav`, `ui-topbar`, `ui-content`), `ui-card`, `ui-stat`, `ui-btn-*`, `ui-field`/`ui-input`, `ui-table`, `ui-badge-*`, `ui-tabs`, `ui-alert`, `ui-dialog`, `ui-empty`, `ui-skeleton`, `ui-auth`. Kepribadian kit ini ada di `kit.css`. Di React/Tailwind, buat komponen sendiri (Button, Card, Table, Badge, Field…) yang memakai token yang sama — jangan menyalin HTML pratinjau mentah-mentah.

Pratinjau semua layar (login, dasbor, daftar, form, detail): `../../preview.html` dengan token dan `kit.css` kit ini.
