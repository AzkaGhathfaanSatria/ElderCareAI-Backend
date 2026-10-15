"""
ElderCare AI - layanan inferensi (Flask).
Mengikuti KONTRAK.md dari notebook Hari 3: rumus fitur harus IDENTIK dengan saat training,
kalau beda hasilnya salah tanpa pesan error.

Endpoint:
  GET  /health
  POST /infer/sensor   -> deteksi jatuh (Random Forest) + baseline anomali, status gabungan JATUH/ANOMALI/NORMAL
  POST /baseline/train -> baseline per lansia dari riwayatnya (median + MAD)
  POST /baseline/score -> skor penyimpangan satu pembacaan terhadap baseline lansia
  POST /infer/pose     -> deteksi jatuh visual (YOLOv8n-Pose), frame hanya diproses di memori (NFR-06)

Hanya boleh diakses dari backend Express (jaringan internal), jangan dibuka ke publik.
"""
import base64
import hashlib
import io
import logging
import os
import pickle
import threading

import numpy as np
import pandas as pd
import sklearn
from flask import Flask, jsonify, request

log = logging.getLogger("ai-service")
logging.basicConfig(level=logging.INFO)

BASE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.environ.get("MODEL_DIR", os.path.join(BASE, "..", "models"))
SENSOR_PATH = os.path.join(MODEL_DIR, "model_final.pkl")
POSE_PATH = os.path.join(MODEL_DIR, "best.pt")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024  # frame maks 8 MB


def _sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        h.update(f.read())
    return h.hexdigest()[:8]


# ---------------------------------------------------------------- model sensor
# File .pkl hanya dibuka dari folder models milik sendiri (trusted).
with open(SENSOR_PATH, "rb") as f:
    PAKET = pickle.load(f)
SENSOR_VERSION = f"model_final.pkl:{_sha(SENSOR_PATH)}"
SKLEARN_MATCH = sklearn.__version__ == PAKET.get("versi_sklearn")
if not SKLEARN_MATCH:
    log.warning("scikit-learn %s != %s (versi training). Hasil bisa salah!", sklearn.__version__, PAKET.get("versi_sklearn"))

MENTAH = ["heart_rate", "oxygen_level", "temperature", "acceleration_magnitude", "gyro_magnitude", "heart_rate_variability"]


def hitung_fitur(baca, riwayat_gyro):
    hr = baca["heart_rate"]
    kategori = "Bradikardia" if hr < 60 else "Normal" if hr <= 100 else "Takikardia Ringan" if hr <= 120 else "Takikardia Berat"
    r = list(riwayat_gyro)
    row = {
        "heart_rate": hr,
        "oxygen_level": baca["oxygen_level"],
        "temperature": baca["temperature"],
        "acceleration_magnitude": baca["acceleration_magnitude"],
        "gyro_magnitude": baca["gyro_magnitude"],
        "heart_rate_variability": baca["heart_rate_variability"],
        "motion_instability_index": baca["gyro_magnitude"] / baca["acceleration_magnitude"],
        "gyro_magnitude_lag1": r[-1] if len(r) >= 1 else np.nan,
        "gyro_magnitude_rolling3": float(np.mean(r[-3:])) if len(r) >= 3 else np.nan,
        "kategori_heart_rate": kategori,
        "spo2_risk_flag": int(baca["oxygen_level"] < 90),
    }
    return pd.DataFrame([row])[PAKET["fitur_num"] + PAKET["fitur_kat"]]


def prediksi_jatuh(baca, riwayat_gyro):
    x = hitung_fitur(baca, riwayat_gyro)
    p = float(PAKET["model"].predict_proba(x)[0, 1])
    return p, ("Jatuh" if p >= PAKET["threshold"] else "Tidak Jatuh")


def cek_anomali(baca, pola=None):
    """Anomali = skor z maksimum > ambang. `pola` (baseline per lansia) menggantikan baseline umum bila ada."""
    b = PAKET["baseline_anomali"]
    sumber = pola if pola else b
    z = {f: abs(baca[f] - sumber["median"][f]) / sumber["skala"][f] for f in b["fitur"]}
    penyebab = max(z, key=z.get)
    skor_iso = float(b["iso_model"].score_samples(pd.DataFrame([{f: baca[f] for f in b["fitur"]}]))[0])
    return {
        "anomali": bool(z[penyebab] > sumber["z_threshold"]),
        "skor_z": round(z[penyebab], 2),
        "fitur_penyebab": penyebab,
        "skor_iso": round(skor_iso, 4),  # informasi saja; keputusan memakai skor z
        "z_threshold": round(float(sumber["z_threshold"]), 3),
        "baseline": "lansia" if pola else "umum",
    }


MIN_BASELINE_ROWS = int(os.environ.get("MIN_BASELINE_ROWS", 50))


def _validasi_pola(pola):
    """Baseline per lansia dari backend: {median:{fitur:float}, skala:{fitur:float>0}, z_threshold:float}."""
    fitur = PAKET["baseline_anomali"]["fitur"]
    try:
        ok = all(
            isinstance(pola["median"][f], (int, float)) and isinstance(pola["skala"][f], (int, float)) and pola["skala"][f] > 0
            for f in fitur
        ) and isinstance(pola["z_threshold"], (int, float)) and pola["z_threshold"] > 0
    except (KeyError, TypeError):
        ok = False
    return pola if ok else None


def latih_baseline(rows):
    """
    Bentuk pola normal satu lansia dari riwayatnya: median + skala robust (MAD x 1.4826).
    - Skala diberi lantai 50% dari skala umum agar variasi kecil tidak membuat skor z meledak.
    - Ambang = max(ambang umum, persentil-99 skor z data lansia itu sendiri), jadi ~1% data normal
      miliknya akan ditandai, dan tidak pernah lebih sensitif dari baseline umum.
    """
    g = PAKET["baseline_anomali"]
    df = pd.DataFrame(rows)[g["fitur"]].astype(float)
    med = df.median()
    mad = (df - med).abs().median() * 1.4826
    skala = {f: max(float(mad[f]), 0.5 * float(g["skala"][f])) for f in g["fitur"]}
    z = pd.concat([(df[f] - med[f]).abs() / skala[f] for f in g["fitur"]], axis=1).max(axis=1)
    thr = max(float(g["z_threshold"]), float(np.percentile(z, 99)))
    return {
        "median": {f: round(float(med[f]), 4) for f in g["fitur"]},
        "skala": {f: round(skala[f], 4) for f in g["fitur"]},
        "z_threshold": round(thr, 3),
        "n": int(len(df)),
    }


def _validasi_sensor(data):
    if not isinstance(data, dict):
        return None, "Body harus berupa objek JSON"
    kurang = [k for k in MENTAH if k not in data]
    if kurang:
        return None, f"Field wajib tidak ada: {', '.join(kurang)}"
    baca = {}
    for k in MENTAH:
        v = data[k]
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not np.isfinite(v):
            return None, f"{k} harus berupa angka"
        baca[k] = float(v)
    if baca["acceleration_magnitude"] <= 0:
        return None, "acceleration_magnitude harus > 0"
    riwayat = data.get("riwayat_gyro_magnitude", [])
    if not isinstance(riwayat, list) or any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in riwayat):
        return None, "riwayat_gyro_magnitude harus berupa daftar angka (lama -> baru)"
    return (baca, [float(v) for v in riwayat][-3:]), None


@app.post("/infer/sensor")
def infer_sensor():
    parsed, err = _validasi_sensor(request.get_json(silent=True))
    if err:
        return jsonify({"error": err}), 400
    baca, riwayat = parsed
    pola = _validasi_pola((request.get_json(silent=True) or {}).get("pola_normal"))
    p, hasil = prediksi_jatuh(baca, riwayat)
    a = cek_anomali(baca, pola)
    status = "JATUH" if hasil == "Jatuh" else "ANOMALI" if a["anomali"] else "NORMAL"
    return jsonify({"status": status, "peluang_jatuh": round(p, 3), "threshold": PAKET["threshold"], **a, "versi_model": SENSOR_VERSION})


@app.post("/baseline/train")
def baseline_train():
    """Riwayat satu lansia (daftar pembacaan 6 metrik) -> pola_normal."""
    data = request.get_json(silent=True)
    rows = data.get("readings") if isinstance(data, dict) else None
    if not isinstance(rows, list) or len(rows) < MIN_BASELINE_ROWS:
        return jsonify({"error": f"Butuh minimal {MIN_BASELINE_ROWS} pembacaan"}), 400
    bersih = []
    for r in rows:
        parsed, err = _validasi_sensor(r)
        if err:
            return jsonify({"error": f"Pembacaan tidak valid: {err}"}), 400
        bersih.append(parsed[0])
    return jsonify({"pola_normal": latih_baseline(bersih), "versi_model": f"baseline|{SENSOR_VERSION}"})


@app.post("/baseline/score")
def baseline_score():
    """Satu pembacaan + pola_normal -> skor penyimpangan (tanpa model jatuh)."""
    data = request.get_json(silent=True) or {}
    parsed, err = _validasi_sensor(data)
    if err:
        return jsonify({"error": err}), 400
    pola = _validasi_pola(data.get("pola_normal"))
    if not pola:
        return jsonify({"error": "pola_normal tidak valid"}), 400
    return jsonify({**cek_anomali(parsed[0], pola), "versi_model": f"baseline|{SENSOR_VERSION}"})


# ---------------------------------------------------------------- model visual
_pose_lock = threading.Lock()
_pose_model = None


def _load_pose():
    global _pose_model
    with _pose_lock:
        if _pose_model is None:
            from ultralytics import YOLO  # impor lambat/berat, hanya saat dibutuhkan
            _pose_model = YOLO(POSE_PATH)
        return _pose_model


def _adalah_jatuh(nama_kelas):
    n = nama_kelas.strip().lower().replace("_", "-")
    return "fall" in n and not n.startswith(("non", "no-", "not"))


def _baca_gambar():
    """Frame dibaca ke memori saja: tidak ditulis ke disk dan tidak dicatat di log (NFR-06)."""
    from PIL import Image
    if request.files.get("image"):
        raw = request.files["image"].read()
    else:
        b64 = (request.get_json(silent=True) or {}).get("image_base64")
        if not b64:
            return None
        raw = base64.b64decode(b64.split(",")[-1])
    return Image.open(io.BytesIO(raw)).convert("RGB")


@app.post("/infer/pose")
def infer_pose():
    try:
        img = _baca_gambar()
    except Exception:
        return jsonify({"error": "Gambar tidak valid"}), 400
    if img is None:
        return jsonify({"error": "Kirim gambar sebagai multipart 'image' atau JSON 'image_base64'"}), 400
    try:
        model = _load_pose()
    except ImportError:
        return jsonify({"error": "ultralytics belum terpasang (pip install -r requirements-pose.txt)"}), 503
    hasil = model.predict(source=np.array(img), imgsz=640, conf=0.25, verbose=False)[0]
    kpts = hasil.keypoints.data.cpu().numpy().tolist() if hasil.keypoints is not None else [None] * len(hasil.boxes)
    deteksi = [
        {
            "kelas": model.names[int(c)],
            "confidence": round(float(s), 2),
            "kotak_xyxy": [round(float(v), 1) for v in b],
            "keypoints": [[round(v, 1) for v in kp] for kp in k] if k else None,
        }
        for b, s, c, k in zip(hasil.boxes.xyxy, hasil.boxes.conf, hasil.boxes.cls, kpts)
    ]
    return jsonify({
        "jatuh_terdeteksi": any(_adalah_jatuh(d["kelas"]) for d in deteksi),
        "deteksi": deteksi,
        "versi_model": f"best.pt:{_sha(POSE_PATH)}",
    })


def _warmup_pose():
    """Muat model YOLO + satu inferensi dummy saat startup, supaya frame pertama kamera tidak lambat (~4 dtk)."""
    if os.environ.get("POSE_WARMUP", "1") != "1" or not os.path.exists(POSE_PATH):
        return
    try:
        model = _load_pose()
        model.predict(source=np.zeros((480, 640, 3), dtype=np.uint8), imgsz=640, verbose=False)
        log.info("Model pose siap (warm-up selesai)")
    except ImportError:
        log.info("ultralytics belum terpasang: /infer/pose dinonaktifkan")
    except Exception as e:  # warm-up tidak boleh membuat layanan sensor gagal
        log.warning("Warm-up pose gagal: %s", e)


threading.Thread(target=_warmup_pose, daemon=True).start()


@app.get("/health")
def health():
    return jsonify({
        "status": "ok",
        "sensor_model": {"versi": SENSOR_VERSION, "sklearn": sklearn.__version__, "sklearn_training": PAKET.get("versi_sklearn"), "sklearn_cocok": SKLEARN_MATCH},
        "pose_model": {"file_ada": os.path.exists(POSE_PATH), "dimuat": _pose_model is not None},
    })
