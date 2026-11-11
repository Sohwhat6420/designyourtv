"""Write plates/<id>.subj.webp: the BiRefNet subject alone (no ground, no clouds), cut from the plate.
Usage: python -I subj_only.py <project dir> [id ...]   (no ids = every plate.webp)"""
import sys
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image

proj = Path(sys.argv[1])
sys.path.insert(0, str(proj / "tools"))
import depth_pipeline as dp  # noqa: E402

plates = proj / "plates"
ids = sys.argv[2:] or sorted(p.name.split(".")[0] for p in plates.glob("*.plate.webp"))
so = ort.SessionOptions(); so.log_severity_level = 3
seg = ort.InferenceSession(str(proj / "models" / "birefnet-lite.onnx"), so, providers=["CPUExecutionProvider"])
for n, pid in enumerate(ids, 1):
    im = Image.open(plates / f"{pid}.plate.webp").convert("RGB")
    dp.W, dp.H = im.size
    rgb = np.asarray(im)
    m = dp.subject_mask(seg, rgb)
    m = np.clip((m - .35) / .3, 0, 1)                       # firm the edge a little: BiRefNet-lite is soft
    m = cv2.GaussianBlur(m, (0, 0), max(.8, im.width / 1920 * 1.2))
    Image.fromarray(np.dstack([rgb, (m * 255).astype(np.uint8)]), "RGBA").save(plates / f"{pid}.subj.webp", quality=84, alpha_quality=90, method=6)
    print(f"{n}/{len(ids)} {pid} cover={m.mean():.3f}", flush=True)
