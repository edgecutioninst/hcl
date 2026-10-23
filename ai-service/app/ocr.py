"""OCR: OpenCV preprocessing (grayscale -> upscale -> denoise -> adaptive threshold -> deskew) + Tesseract."""
from __future__ import annotations

import cv2
import fitz  # PyMuPDF
import numpy as np
import pytesseract


def preprocess(img: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    h, w = gray.shape
    if max(h, w) < 1600:  # small scans: upscale so glyphs are ~30 px tall
        f = 1600 / max(h, w)
        gray = cv2.resize(gray, None, fx=f, fy=f, interpolation=cv2.INTER_CUBIC)
    gray = cv2.fastNlMeansDenoising(gray, None, h=10, templateWindowSize=7, searchWindowSize=21)
    bw = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 15)
    return deskew(bw)


def deskew(bw: np.ndarray) -> np.ndarray:
    ink = np.column_stack(np.where(bw < 128))
    if len(ink) < 50:
        return bw
    angle = cv2.minAreaRect(ink[:, ::-1].astype(np.float32))[-1]
    if angle > 45:
        angle -= 90
    if abs(angle) < 0.3 or abs(angle) > 15:  # nothing to fix / implausible estimate
        return bw
    h, w = bw.shape
    m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    return cv2.warpAffine(bw, m, (w, h), flags=cv2.INTER_CUBIC, borderValue=255)


def decode(data: bytes, content_type: str | None) -> list[np.ndarray]:
    """Bytes -> list of BGR page images. PDFs are rasterised at 300 dpi (max 5 pages)."""
    if data[:5] == b"%PDF-" or content_type == "application/pdf":
        pages = []
        with fitz.open(stream=data, filetype="pdf") as doc:
            for page in list(doc)[:5]:
                pix = page.get_pixmap(dpi=300)
                arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.h, pix.w, pix.n)
                pages.append(cv2.cvtColor(arr, cv2.COLOR_RGBA2BGR if pix.n == 4 else cv2.COLOR_RGB2BGR))
        return pages
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("not a decodable image")
    return [img]


def ocr(data: bytes, content_type: str | None = None) -> dict:
    texts, confs = [], []
    for page in decode(data, content_type):
        prep = preprocess(page)
        d = pytesseract.image_to_data(prep, config="--oem 1 --psm 6", output_type=pytesseract.Output.DICT)
        lines: dict[tuple, list[str]] = {}
        for i, word in enumerate(d["text"]):
            c = float(d["conf"][i])
            if word.strip() and c >= 0:
                lines.setdefault((d["block_num"][i], d["par_num"][i], d["line_num"][i]), []).append(word)
                confs.append(c)
        texts.append("\n".join(" ".join(ws) for ws in lines.values()))
    mean = (sum(confs) / len(confs) / 100) if confs else 0.0
    return {"text": "\n".join(texts) + "\n", "ocr_confidence": round(mean, 2), "words": len(confs)}
