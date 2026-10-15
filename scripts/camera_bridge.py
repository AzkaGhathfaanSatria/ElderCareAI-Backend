#!/usr/bin/env python3
"""
Penghubung kamera -> ElderCare AI (POST /ingest/camera).

Mengambil gambar dari kamera sungguhan, mengecilkannya, lalu mengirim satu frame per request
dengan device key kamera. Frame TIDAK pernah ditulis ke disk oleh program ini.

Pasang:   pip install opencv-python requests
Contoh:
  webcam laptop      python camera_bridge.py --key ecc_xxx --source 0
  kamera IP (RTSP)   python camera_bridge.py --key ecc_xxx --source rtsp://user:pass@192.168.1.10:554/stream1
  HP (app IP Webcam) python camera_bridge.py --key ecc_xxx --source http://192.168.1.20:8080/video
  uji dari file      python camera_bridge.py --key ecc_xxx --source rekaman.mp4 --count 20

Opsi: --url (default http://localhost:4000)  --fps (default 1)  --width (default 640, 0 = asli)
      --quality JPEG 1-100 (default 80)  --count berhenti setelah N frame (default 0 = terus)  --preview tampilkan jendela
Key juga bisa lewat variabel lingkungan DEVICE_KEY.
"""
import argparse
import os
import sys
import threading
import time

try:
    import cv2
    import requests
except ImportError:
    sys.exit("Pasang dulu: pip install opencv-python requests")


def parse_args():
    p = argparse.ArgumentParser(description="Kirim frame kamera ke ElderCare AI")
    p.add_argument("--key", default=os.environ.get("DEVICE_KEY"), help="device key kamera (ecc_...)")
    p.add_argument("--source", default="0", help="indeks webcam, URL RTSP/HTTP, atau path file video")
    p.add_argument("--url", default="http://localhost:4000")
    p.add_argument("--fps", type=float, default=1.0, help="frame per detik yang dikirim (1-2 disarankan)")
    p.add_argument("--width", type=int, default=640)
    p.add_argument("--quality", type=int, default=80)
    p.add_argument("--count", type=int, default=0)
    p.add_argument("--preview", action="store_true")
    a = p.parse_args()
    if not a.key:
        p.error("--key wajib (didapat saat mendaftarkan kamera)")
    if a.fps <= 0:
        p.error("--fps harus > 0")
    return a


def open_capture(source):
    if source.isdigit():
        idx = int(source)
        return cv2.VideoCapture(idx, cv2.CAP_DSHOW) if os.name == "nt" else cv2.VideoCapture(idx)
    return cv2.VideoCapture(source)


class LatestFrame:
    """Baca kamera terus-menerus di thread, simpan hanya frame terbaru (buang antrean usang pada RTSP)."""

    def __init__(self, source):
        self.source, self.cap = source, open_capture(source)
        self.frame, self.lock, self.stop = None, threading.Lock(), False
        self.last_ok = time.time()
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        while not self.stop:
            if not self.cap.isOpened():
                self._reopen()
                continue
            ok, frame = self.cap.read()
            if ok:
                with self.lock:
                    self.frame = frame
                self.last_ok = time.time()
            else:
                time.sleep(0.2)
                if time.time() - self.last_ok > 10:  # kamera putus > 10 detik: sambungkan ulang
                    self._reopen()

    def _reopen(self):
        print("! Kamera terputus, mencoba menyambung ulang...", flush=True)
        self.cap.release()
        time.sleep(3)
        self.cap = open_capture(self.source)
        self.last_ok = time.time()

    def get(self):
        with self.lock:
            f, self.frame = self.frame, None
        return f


def encode(frame, width, quality):
    h, w = frame.shape[:2]
    if width and w > width:
        frame = cv2.resize(frame, (width, int(h * width / w)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return buf.tobytes() if ok else None


def main():
    a = parse_args()
    endpoint = a.url.rstrip("/") + "/ingest/camera"
    headers = {"Content-Type": "image/jpeg", "X-Device-Key": a.key}
    period = 1.0 / a.fps
    is_file = os.path.isfile(a.source)
    if not is_file and not a.source.isdigit() and "://" not in a.source:
        sys.exit(f"File tidak ditemukan: {a.source}")

    cap = None if not is_file else open_capture(a.source)
    live = None if is_file else LatestFrame(a.source)
    if is_file and not cap.isOpened():
        sys.exit(f"Tidak bisa membuka file: {a.source}")
    video_fps = (cap.get(cv2.CAP_PROP_FPS) or 25) if is_file else 0
    step = max(1, round(video_fps / a.fps)) if is_file else 1

    sent = falls = alerts = errors = 0
    total_latency = 0.0
    print(f"Mengirim ke {endpoint} setiap {period:.1f} dtk dari '{a.source}' - Ctrl+C untuk berhenti", flush=True)

    try:
        while a.count == 0 or sent < a.count:
            started = time.time()
            if is_file:
                frame = None
                for _ in range(step):
                    ok, f = cap.read()
                    if not ok:
                        print("File video selesai.")
                        raise KeyboardInterrupt
                    frame = f
            else:
                frame = live.get()
                if frame is None:  # belum ada frame baru
                    time.sleep(0.2)
                    if time.time() - live.last_ok > 15:
                        print("! Belum ada gambar dari kamera. Periksa --source.", flush=True)
                    continue

            jpg = encode(frame, a.width, a.quality)
            if jpg is None:
                continue
            if a.preview:
                cv2.imshow("camera_bridge (q = keluar)", frame)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    raise KeyboardInterrupt

            try:
                t0 = time.time()
                r = requests.post(endpoint, data=jpg, headers=headers, timeout=20)
                lat = time.time() - t0
            except requests.RequestException as e:
                errors += 1
                print(f"! Gagal mengirim ({type(e).__name__}); mencoba lagi...", flush=True)
                time.sleep(min(5, period * 2))
                continue

            if r.status_code == 401:
                sys.exit("Device key ditolak (401). Periksa --key atau buat key baru di aplikasi.")
            if r.status_code != 200:
                errors += 1
                msg = r.json().get("message", "") if r.headers.get("content-type", "").startswith("application/json") else ""
                print(f"! Server membalas {r.status_code} {msg}", flush=True)
                time.sleep(min(5, period * 2))
                continue

            sent += 1
            total_latency += lat
            body = r.json()
            if body.get("fall"):
                falls += 1
            if body.get("alertRaised"):
                alerts += 1
            kelas = ", ".join(f"{d['kelas']} {d['confidence']}" for d in body.get("deteksi", [])) or "tidak ada orang terdeteksi"
            tag = f"JATUH {body['fallFrames']}/{body['required']}" if body.get("fall") else "aman"
            print(f"#{sent:<4} {tag:<12} {lat:.2f}s  [{kelas}]{'  >>> ALERT DIKIRIM' if body.get('alertRaised') else ''}", flush=True)
            if lat > period:
                print(f"  (pengiriman {lat:.1f}s lebih lambat dari {period:.1f}s; turunkan --fps atau --width)", flush=True)

            time.sleep(max(0.0, period - (time.time() - started)))
    except KeyboardInterrupt:
        pass
    finally:
        if live:
            live.stop = True
        if cap:
            cap.release()
        if a.preview:
            cv2.destroyAllWindows()
        avg = total_latency / sent if sent else 0
        print(f"\nSelesai: {sent} frame terkirim, {falls} frame jatuh, {alerts} alert, {errors} error, rata-rata {avg:.2f}s/frame")


if __name__ == "__main__":
    main()
