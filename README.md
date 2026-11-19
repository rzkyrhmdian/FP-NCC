# FP-NCC: Real-time Deno Chat App dengan Room dan Polling

## Latar Belakang Masalah
Komunikasi tim kecil atau kelompok belajar membutuhkan:
- Percakapan real-time tanpa refresh halaman.
- Pemisahan topik diskusi per room lengkap dengan riwayat pesan.
- Voting cepat per room yang tetap terlihat selama percakapan berlangsung.

## Fitur Utama
- **Multi-room chat terisolasi**: Default room `#global`, pembuatan room baru dengan normalisasi slug, perpindahan room otomatis memuat riwayat 100 pesan terakhir, dan lencana aktivitas belum dibaca (`+N`) untuk room lain.
- **Kehadiran & indikator real-time**: Jumlah anggota per room, daftar pengguna online beserta room aktif masing-masing, indikator mengetik (`sedang mengetik...`), dan status koneksi WebSocket (`Terhubung` / `Menyambungkan` / `Terputus`).
- **Polling interaktif per room**:
  - Kartu `#pinned-poll` tersemat di atas percakapan dan dapat dilipat (`Tampilkan` / `Sembunyikan`).
  - Deduplikasi opsi otomatis (2 sampai 8 opsi unik).
  - Pengubah pilihan suara (*change vote*) selama polling berstatus terbuka.
  - Penutupan polling oleh pembuat (`Tutup Polling`) dengan penanda pemenang `[Terbanyak]`.
- **Persistensi otomatis**: Room, riwayat pesan, dan status polling disimpan ke `data/chat-state.json` secara atomik sehingga tidak hilang saat server restart.
- **Keamanan & ketahanan**: Static file serving terkunci pada direktori `public/`, validasi payload WebSocket, rate limiting per user, heartbeat `ping`/`pong`, endpoint `/health`, dan aksesibilitas keyboard WCAG 2.2 AA (focus trap modal, `:focus-visible`, target sentuh minimal `44px`).

## Arsitektur Singkat
- **Backend**: Deno 2 + Oak (`main.ts`, `ChatServer.ts`, `ChatStorage.ts`).
- **Frontend**: HTML semantik, CSS responsif 3 state (`< 640px`, `640px-1023px`, `>= 1024px`), JavaScript vanilla (`public/`).
- **Realtime channel**: WebSocket endpoint `/start_web_socket` dengan heartbeat `ping`/`pong`.
- **Healthcheck**: `GET /health` (mengembalikan uptime, jumlah user online, room, dan polling aktif).
- **Reverse proxy**: Nginx dengan dukungan upgrade WebSocket dan timeout `3600s` (`conf/nginx/http.conf`).

## Struktur Proyek
- `main.ts`: Entry point Oak, security headers, `/health`, routing WebSocket, dan static file server `public/`.
- `ChatServer.ts`: Logika WebSocket (user, room, chat, polling, typing, rate limiting, heartbeat).
- `ChatStorage.ts`: Abstraksi persistensi (`JsonFileStorage` atomik dan `MemoryStorage` untuk pengujian).
- `ChatServer_test.ts`: Suite pengujian otomatis menggunakan `@std/assert`.
- `public/`: Antarmuka pengguna (`index.html`, `style.css`, `app.js`).
- `Dockerfile`, `docker-compose.yml`, `conf/nginx/http.conf`: Konfigurasi container non-root dan reverse proxy.

## Cara Menjalankan Aplikasi

### Opsi A: Secara Lokal (tanpa Docker)
Prasyarat: Deno 2 terpasang.

1. Jalankan mode pengembangan (auto-reload):
```bash
deno task dev
```
Atau mode produksi:
```bash
deno task start
```
2. Buka browser ke `http://localhost:8080`.

### Opsi B: Menggunakan Docker Compose
Prasyarat: Docker dan Docker Compose terpasang.

1. Build dan jalankan service:
```bash
docker compose up --build
```
2. Akses aplikasi melalui Nginx di `http://localhost` (endpoint health: `http://localhost/health`).
3. Hentikan service:
```bash
docker compose down
```

## Pengujian & Pemeriksaan Kualitas
```bash
deno task test
deno task check
deno task lint
```
