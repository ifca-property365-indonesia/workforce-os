# Dasbor Malam (`malam`)

Gelap untuk ruang kontrol: navy pekat, angka monospace, aksen cyan dan lime yang menyala. Untuk dasbor monitoring, operasional 24 jam, dan NOC.

Mode utama: **gelap**. Tag: dark, dashboard, data.

## Karakter

Ruang kontrol malam: latar navy pekat (#0B1020), permukaan sedikit lebih terang, teks hampir putih. Data adalah pahlawan: angka monospace (JetBrains Mono), aksen cyan (#22D3EE) untuk aksi dan data utama, lime (#A3E635) untuk seri kedua dan "sehat".

Signature:
- Cahaya, bukan bayangan: tombol utama dan batang grafik berpendar lembut; menu aktif punya garis cyan di kiri.
- Kartu bergradien vertikal sangat halus; tepi 1px biru gelap.
- Lencana monospace huruf kapital di atas latar transparan berwarna.

Layout: padat informasi; grid 4 kolom statistik; grafik besar di atas, tabel di bawah. Mode gelap adalah mode utama — jangan buat versi terang kecuali diminta.
Kontras: teks utama #E6EDF7, sekunder #94A3B8 (lolos 4.5:1 di permukaan). Teks di tombol cyan selalu gelap (#04222A).
Hindari: putih murni sebagai latar apa pun, pendar di teks paragraf, lebih dari dua warna aksen per grafik, merah selain untuk alarm.

## Token utama

Semua token ada di `tokens.css` (salin ke CSS global aplikasi, atau petakan ke tema Tailwind). Ringkasan:

| Token | Nilai |
|---|---|
| `--ui-bg` | `#0B1020` |
| `--ui-surface` | `#121A2E` |
| `--ui-text` | `#E6EDF7` |
| `--ui-muted` | `#94A3B8` |
| `--ui-border` | `#24304A` |
| `--ui-primary` | `#22D3EE` |
| `--ui-primary-text` | `#04222A` |
| `--ui-accent` | `#A3E635` |
| `--ui-success` | `#34D399` |
| `--ui-danger` | `#F87171` |
| `--ui-radius` | `12px` |
| `--ui-radius-sm` | `8px` |
| `--ui-shadow` | `0 0 0 1px rgba(34,211,238,.04), 0 10px 30px -12px rgba(0,0,0,.6)` |

## Tipografi

- Judul: **Sora** · Badan: **Inter** · Angka/kode: **JetBrains Mono**
- Paket font (dibundel bersama aplikasi, jangan Google Fonts/CDN): `@fontsource-variable/inter`, `@fontsource-variable/jetbrains-mono`, `@fontsource-variable/sora` — dependensi baru, jadi lewat persetujuan.
- Skala: judul halaman `--ui-title-size`, judul kartu 17–20px, badan 15px, label 13px, keterangan 12px.

## Komponen

Kontrak kelas sama di semua kit (lihat `../../base.css`): app shell (`ui-app`, `ui-sidebar`, `ui-nav`, `ui-topbar`, `ui-content`), `ui-card`, `ui-stat`, `ui-btn-*`, `ui-field`/`ui-input`, `ui-table`, `ui-badge-*`, `ui-tabs`, `ui-alert`, `ui-dialog`, `ui-empty`, `ui-skeleton`, `ui-auth`. Kepribadian kit ini ada di `kit.css`. Di React/Tailwind, buat komponen sendiri (Button, Card, Table, Badge, Field…) yang memakai token yang sama — jangan menyalin HTML pratinjau mentah-mentah.

Pratinjau semua layar (login, dasbor, daftar, form, detail): `../../preview.html` dengan token dan `kit.css` kit ini.
