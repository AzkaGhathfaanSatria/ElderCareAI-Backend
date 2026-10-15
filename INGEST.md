# Ingest wearable + simulator

## 1. Dapatkan device key
Daftarkan wearable di halaman **Perangkat** (frontend). Device key (`ecw_...`) tampil **sekali** di pesan sukses.
Hilang / wearable lama? `POST /devices/w-<id>/rotate-key` (pakai token login) -> key baru.

## 2. Kirim data
POST /ingest/wearable   Header: X-Device-Key: ecw_xxx
{ "readings": [ { "timestamp": "2026-10-10T08:00:00Z", "heartRate": 72, "sleepHours": 7.2, "battery": 90, "moving": true } ] }
- 1-500 data per request, minimal salah satu dari heartRate / sleepHours / moving
- Idempoten: timestamp yang sama untuk wearable yang sama tidak disimpan dua kali
- Balasan 202: { accepted, duplicates, rejected }

## 3. Simulator
npm run simulate -- --key ecw_xxx --backfill 7      # isi riwayat 7 hari (aman diulang)
npm run simulate -- --key ecw_xxx                   # data live tiap 10 detik
npm run simulate -- --key ecw_xxx --anomaly         # sesekali detak jantung tinggi -> memicu alert

## Aturan alert (src/modules/alerts/alert.engine.ts)
HR > 120 (atau < 45) pada 3 pembacaan berturut-turut -> alert sedang; > 140 (atau < 40) -> tinggi.
Cooldown 30 menit per jenis. Ambang bisa diubah lewat .env: ALERT_HR_HIGH, ALERT_HR_LOW,
ALERT_HR_CRIT_HIGH, ALERT_HR_CRIT_LOW, ALERT_CONSECUTIVE, ALERT_COOLDOWN_MIN.
Notifikasi (kanal dashboard) dibuat untuk keluarga + tenaga medis berizin, sesuai level minimum masing-masing.

## Metrik untuk model AI (langkah 5)
Selain heartRate/sleepHours/battery/moving, satu pembacaan boleh membawa 5 metrik tambahan:
`oxygenLevel` (SpO2 %), `temperature` (C), `accelerationMagnitude`, `gyroMagnitude` (norma vektor x,y,z), `heartRateVariability`.
Pembacaan terbaru yang memuat **keenam metrik** (heartRate + 5 di atas) dikirim ke layanan AI (`AI_SERVICE_URL`):
- status JATUH   -> alert "Jatuh terdeteksi (sensor)", tingkat tinggi
- status ANOMALI -> alert "Anomali tanda vital: <fitur>", tingkat sedang (baseline umum, ~1% pembacaan normal bisa ikut ditandai)
- status NORMAL  -> tidak ada alert
Fitur riwayat (gyro_lag1, rolling3) dihitung dari 3 pembacaan sebelumnya wearable yang sama.
Jika layanan AI mati/tidak diset, ingest tetap berjalan; hanya aturan ambang detak jantung yang aktif.

## Migrasi database
    npx prisma migrate deploy --config prisma7.config.ts
(menambah 5 kolom ke tb_data_wearable). Client Prisma di src/generated sudah ikut diperbarui di zip.

## Menjalankan semuanya
1. PostgreSQL + `npm run dev` (backend)      2. `ai-service`: lihat ai-service/README.md      3. `npm run simulate -- --key ecw_xxx --fall`

## Kamera (langkah 6)
Daftarkan kamera di halaman Perangkat atau form registrasi lansia: device key kamera (`ecc_...`) tampil sekali.
POST /ingest/camera   Header: X-Device-Key: ecc_xxx   Content-Type: image/jpeg | image/png | image/webp
Badan request = bytes gambar mentah (maks 8 MB), satu frame per request. Disarankan 1-2 fps.
- Frame hanya dikirim ke layanan AI (/infer/pose) dari memori; TIDAK disimpan di disk/DB/log (NFR-06).
- Hanya deteksi kelas `Fall` (confidence >= 0.5) yang disimpan ke tb_deteksi_yolo (bbox + 12 keypoint). Frame normal tidak disimpan.
- Alert "Jatuh terdeteksi (kamera)" dibuat bila >= 3 deteksi Fall dari kamera yang sama dalam 10 detik.
  Ubah lewat .env: FALL_FRAMES_REQUIRED, FALL_WINDOW_SEC, FALL_MIN_CONF, AI_POSE_TIMEOUT_MS.
- Jatuh dari kamera dan dari sensor memakai satu kejadian + satu alert per cooldown 30 menit (tidak ganda).
- Layanan AI mati -> 503 (kamera sebaiknya mengirim ulang). Kamera mati -> status "Terputus" setelah 15 menit.
- Keluarga/medis menjawab "Ya, benar jatuh" / "Alarm palsu" di kartu peringatan (tb_kejadian_jatuh.konfirmasi / false_alarm).
Uji: npm run simulate-camera -- --key ecc_xxx --image orang_jatuh.jpg --count 5 --fps 2
Layanan AI untuk pose butuh: pip install -r ai-service/requirements-pose.txt (PyTorch, berat).

## Baseline per lansia (langkah 7, FR-04)
Awalnya (cold start) anomali dinilai dengan baseline UMUM bawaan model. Setelah data wearable lansia cukup
(>= 7 hari dan >= 100 pembacaan lengkap 6 metrik), sistem membentuk pola normal lansia itu sendiri:
median + skala robust (MAD) tiap metrik, dan ambang z yang dikalibrasi dari data lansia itu (tidak pernah lebih
sensitif dari baseline umum). Hasilnya disimpan di tb_baseline_perilaku dan dipakai otomatis oleh analisis AI.
- Penjadwal di dalam server melatih ulang tiap 6 jam bagi lansia yang punya data baru dan baseline > 24 jam.
- Pembacaan di sekitar alert (±10 menit) dibuang dari data latih agar kejadian abnormal tidak jadi "normal".
- API: GET /elders/:id/baseline (status + perbandingan nilai terakhir), POST /elders/:id/baseline/train (keluarga/admin).
- Alert yang berasal dari baseline lansia bertuliskan "(di luar pola normal lansia)" dan menautkan id_baseline.
- Keterbatasan: pola belum dipisah per jam (siang vs tidur); satu median untuk seluruh hari.
- Dedup alert anomali kini per jenis (demam tidak tertahan alert detak jantung).
Flask: POST /baseline/train, POST /baseline/score; /infer/sensor menerima field opsional pola_normal.

## Menguji dengan kamera sungguhan (scripts/camera_bridge.py)
Kamera CCTV/webcam tidak bisa langsung memanggil API ini, jadi pakai program penghubung (Python):
    pip install opencv-python requests
    python scripts/camera_bridge.py --key ecc_xxx --source 0                              # webcam laptop
    python scripts/camera_bridge.py --key ecc_xxx --source rtsp://user:pass@192.168.1.10:554/stream1   # kamera IP
    python scripts/camera_bridge.py --key ecc_xxx --source http://192.168.1.20:8080/video # HP (app "IP Webcam")
    python scripts/camera_bridge.py --key ecc_xxx --source rekaman.mp4 --count 20         # uji dari file video
Opsi: --fps (default 1, maks disarankan 2)  --width (default 640)  --url  --preview (jendela pratinjau)
Program mengirim frame terbaru saja, menyambung ulang jika kamera putus, dan terus mencoba jika server/AI sempat mati.
Frame tidak ditulis ke disk. Key kamera (ecc_...) didapat saat mendaftarkan kamera.

Tips agar hasil baik:
- Pasang kamera sehingga SELURUH tubuh terlihat (bukan close-up). Pada uji foto close-up dua orang berdiri, model
  menjawab "Fall" dengan confidence 0.28; ambang FALL_MIN_CONF=0.5 menyaringnya. Jangan turunkan ambang tanpa data uji.
- Kamera/sudut/pencahayaan yang berbeda dari data latih bisa menurunkan akurasi. Uji dulu dengan skenario terkontrol
  (orang berbaring di kasur/matras), lihat angka "JATUH n/3", baru sesuaikan FALL_FRAMES_REQUIRED / FALL_WINDOW_SEC.
- Di laptop CPU (mis. i3) inferensi lebih lambat dari 0.12 dtk; mulai dari --fps 1. Program akan memberi peringatan
  jika pengiriman lebih lambat dari interval.
- Model dimuat saat Flask menyala (POSE_WARMUP=1) sehingga frame pertama tidak lambat; set 0 untuk menonaktifkan.
