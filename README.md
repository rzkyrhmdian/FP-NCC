# FP-NCC - Real-time Deno Chat App dengan Room dan Polling

## Latar Belakang Masalah
Komunikasi tim atau komunitas sering membutuhkan:
- Percakapan real-time tanpa refresh halaman.
- Pemisahan topik diskusi per room.
- Fitur voting cepat untuk pengambilan keputusan sederhana.

Pada praktiknya, banyak solusi chat sederhana belum menyediakan kombinasi room + polling secara langsung dalam satu aplikasi yang ringan dan mudah dijalankan untuk kebutuhan pembelajaran/proyek internal.

## Solusi yang Dibangun
Proyek ini adalah aplikasi chat real-time berbasis Deno + Oak + WebSocket yang menyediakan:
- Multi-room chat (default room: global).
- Daftar user online.
- Pembuatan polling per room.
- Voting 1 kali per user untuk setiap polling aktif.
- Deployment containerized dengan Docker dan reverse proxy Nginx.

## Fitur Utama
- Realtime messaging menggunakan WebSocket.
- Create room dan switch room.
- Broadcast user online.
- Polling interaktif:
  - Buat pertanyaan dan opsi polling.
  - Tampilkan jumlah vote per opsi.
  - Tampilkan daftar voter per opsi.

## Arsitektur Singkat
- Backend: Deno + Oak.
- Frontend: HTML, CSS, JavaScript vanilla.
- Realtime channel: WebSocket endpoint pada /start_web_socket.
- Reverse proxy: Nginx (opsional, via Docker Compose).

## Struktur Proyek
- main.ts: Entry point server Oak dan routing.
- ChatServer.ts: Logika WebSocket (user, room, chat, polling).
- public/: UI utama aplikasi dan logika interaksi client dan event Websocket.
- docker-compose.yml: Orkestrasi service app + nginx.
- Dockerfile: Image aplikasi Deno.
- conf/nginx/http.conf: Konfigurasi reverse proxy Nginx.

## Cara Menjalankan Aplikasi

### Opsi A - Secara Lokal (tanpa Docker)
Prasyarat:
- Deno terpasang.

Langkah:
1. Jalankan:

```bash
deno task dev
```

2. Buka browser:
- http://localhost:8080

### Opsi B - Menggunakan Docker Compose
Prasyarat:
- Docker dan Docker Compose terpasang.

Langkah:
1. Build dan jalankan container:

```bash
docker compose up --build
```

2. Akses aplikasi:
- Melalui Nginx: http://localhost
- Direct app container: http://localhost:8080

3. Hentikan service:

```bash
docker compose down
```

## Cara Menggunakan
1. Saat halaman dibuka, masukkan username.
2. Kirim pesan dari form chat.
3. Buat room baru dari panel Rooms.
4. Klik room untuk berpindah konteks percakapan.
5. Klik tombol Create Poll untuk membuat polling.
6. Vote pada opsi yang tersedia (1 user hanya 1 vote).

## Catatan
- Proyek ini ditujukan untuk pembelajaran dan demonstrasi konsep realtime app.
- Saat ini sistem polling menyimpan 1 polling aktif pada satu waktu di sisi server.
- History chat pada room tidak tersimpan untuk user baru.
- Room bersifat permanen dan tidak dapat diedit.