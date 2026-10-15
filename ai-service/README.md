# AI service (Flask)

Layanan internal untuk model AI. Hanya Express yang memanggilnya; jangan dibuka ke publik.

## Jalankan (development)
    cd ai-service
    python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
    pip install -r requirements.txt                          # sensor saja (ringan)
    pip install -r requirements-pose.txt                     # opsional: kamera/YOLO (berat)
    flask --app app.main run --port 5000
Produksi: `gunicorn -w 2 -b 0.0.0.0:5000 app.main:app`

Lalu di backend `.env`:  `AI_SERVICE_URL=http://localhost:5000`
(Tanpa variabel ini backend melewati AI dan hanya memakai aturan ambang detak jantung.)

## Endpoint
- `GET /health`
- `POST /infer/sensor` body: heart_rate, oxygen_level, temperature, acceleration_magnitude, gyro_magnitude,
  heart_rate_variability, riwayat_gyro_magnitude (maks 3 terakhir, lama->baru, boleh kosong)
  -> { status: JATUH|ANOMALI|NORMAL, peluang_jatuh, anomali, skor_z, fitur_penyebab, skor_iso, versi_model }
- `POST /baseline/train` body: readings[] (>= 50 pembacaan 6 metrik) -> pola_normal (median, skala, z_threshold)
- `POST /baseline/score` body: 6 metrik + pola_normal -> skor penyimpangan
  (`/infer/sensor` juga menerima `pola_normal` opsional; tanpa itu dipakai baseline umum)
- `POST /infer/pose` multipart `image` atau JSON `image_base64`
  -> { jatuh_terdeteksi, deteksi:[{kelas, confidence, kotak_xyxy, keypoints}], versi_model }
  Hanya kelas `Fall` yang berarti jatuh; `Non-Fall` tidak memicu alarm.

## Catatan penting
- scikit-learn harus 1.8.0 (sama dengan training). `/health` menampilkan `sklearn_cocok`.
- Model sensor dilatih dari data simulasi (17 subjek); skor F1 = 1.0 BUKAN performa dunia nyata.
- Di laptop CPU, YOLO sebaiknya 1-2 fps dan frame di-resize.
