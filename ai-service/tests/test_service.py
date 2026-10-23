"""Self-checks for the AI service: python -m tests.test_service (no network, no LLM key)."""
import io
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("SERVICE_KEY", "k")
from fastapi.testclient import TestClient  # noqa: E402

import app.main as main  # noqa: E402
from app import llm  # noqa: E402
from app.extractor import DATA_DIR  # noqa: E402

main.SERVICE_KEY = "k"
c = TestClient(main.app)
H = {"x-service-key": "k"}
texts = {j["doc_id"]: j["text"] for f in ("sample", "eval") for j in map(json.loads, (DATA_DIR / f"case_02_document_text_{f}_V1.0.jsonl").read_text().splitlines())}

# auth
assert c.post("/extract", json={"doc_id": "x", "text": "y"}).status_code == 401

# A2000009 poor-scan PAN read correctly at >= 0.80 (worked example 9)
r = c.post("/extract", json={"doc_id": "D3000025", "text": texts["D3000025"]}, headers=H).json()
f = {x["field_name"]: x for x in r["fields"]}
assert r["doc_type"] == "PAN_CARD" and f["pan_number"]["value"] == "ZZTPS9012Y" and min(f[k]["confidence"] for k in ("name", "dob", "pan_number")) >= 0.80, r
s = f["pan_number"]["source_span"]
assert texts["D3000025"][s["start"]:s["end"]] == "ZZTPS9012Y"

# prompt injection -> OTHER, no fields
r = c.post("/extract", json={"doc_id": "D3000486", "text": texts["D3000486"]}, headers=H).json()
assert r["doc_type"] == "OTHER" and r["fields"] == [] and "PROMPT_INJECTION_TEXT" in r["flags"], r

# any exception / timeout -> OTHER with confidence 0
orig = main.extract
main.extract = lambda *a: (_ for _ in ()).throw(RuntimeError("boom"))
r = c.post("/extract", json={"doc_id": "x", "text": "INCOME TAX"}, headers=H).json()
assert r["doc_type"] == "OTHER" and r["doc_type_confidence"] == 0, r
main.TIMEOUT_S = 0.2
main.extract = lambda *a: (time.sleep(1), orig(*a))[1]
r = c.post("/extract", json={"doc_id": "x", "text": texts["D3000001"]}, headers=H).json()
assert r["doc_type"] == "OTHER" and "TimeoutError" in r["extractor_version"], r
main.extract, main.TIMEOUT_S = orig, 10

# LLM path (stubbed, no network): cannot upgrade an injection doc; LLM-only values capped below 0.80
llm_on, llm_x = llm.enabled, llm.llm_extract
llm.enabled = lambda: True
llm.llm_extract = lambda t: llm.LlmExtraction(doc_type="AADHAAR_CARD", doc_type_confidence=1, aadhaar_last4=llm.LlmField(value="1234", confidence=1))
r = c.post("/extract", json={"doc_id": "D3000486", "text": texts["D3000486"]}, headers=H).json()
assert r["doc_type"] == "OTHER" and r["fields"] == [], r
pan_no_dob = texts["D3000001"].replace("15/05/1990", "")
llm.llm_extract = lambda t: llm.LlmExtraction(doc_type="PAN_CARD", doc_type_confidence=1, dob=llm.LlmField(value="15/05/1990", confidence=0.99))
r = c.post("/extract", json={"doc_id": "x", "text": pan_no_dob}, headers=H).json()
dob = next(x for x in r["fields"] if x["field_name"] == "dob")
assert dob["value"] == "1990-05-15" and dob["confidence"] == 0.79 and "+llm" in r["extractor_version"], r
llm.enabled, llm.llm_extract = llm_on, llm_x

# summary: <= 80 words, labelled, never recommends a decision
details = {"name": {"declared": "Ravi Kumar Sharma", "compared": [{"doc_id": "D3000010", "name": "Ravi K Sharma", "similarity": 0.7647}]}}
r = c.post("/summary", json={"application_id": "A2000004", "reason_codes": ["NAME_MISMATCH_MINOR"], "rule_details": details}, headers=H).json()
assert r["label"] == "AI-generated" and r["words"] <= 80 and "0.7647" in r["summary"] and not llm.BANNED.search(r["summary"]), r

# OCR: render a document to PNG and PDF, OCR it, extract
import cv2  # noqa: E402
import fitz  # noqa: E402
import numpy as np  # noqa: E402

if os.environ.get("SKIP_OCR") != "1":
    doc = fitz.open(); page = doc.new_page(width=420, height=300)
    page.insert_text((20, 30), texts["D3000001"], fontsize=11, fontname="cour")
    pdf = doc.tobytes()
    r = c.post("/ocr", files={"file": ("d.pdf", pdf, "application/pdf")}, headers=H).json()
    assert "ZZKPS1234Q" in r["text"] and r["ocr_confidence"] > 0.5, r
    pix = fitz.open("pdf", pdf)[0].get_pixmap(dpi=110)
    img = np.frombuffer(pix.samples, np.uint8).reshape(pix.h, pix.w, pix.n)
    rot = cv2.warpAffine(img, cv2.getRotationMatrix2D((pix.w / 2, pix.h / 2), 3, 1), (pix.w, pix.h), borderValue=(255, 255, 255))  # skewed scan
    png = cv2.imencode(".png", rot)[1].tobytes()
    o = c.post("/ocr", files={"file": ("d.png", png, "image/png")}, headers=H).json()
    e = c.post("/extract", json={"doc_id": "img", "text": o["text"], "ocr_confidence": o["ocr_confidence"]}, headers=H).json()
    fe = {x["field_name"]: x["value"] for x in e["fields"]}
    assert e["doc_type"] == "PAN_CARD" and fe.get("pan_number") == "ZZKPS1234Q" and fe.get("dob") == "1990-05-15", (o, e)
    assert c.post("/ocr", files={"file": ("x.png", b"MZ\x90\x00", "image/png")}, headers=H).status_code == 415
    print("ocr ok:", o["ocr_confidence"], e["doc_type_confidence"])
print("ai-service self-checks OK")
