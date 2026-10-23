"""OnboardIQ AI service: POST /ocr, POST /extract, POST /summary. The AI never decides approval."""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Optional

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from pydantic import BaseModel, Field

from . import extractor, llm
from .extractor import RULES_VERSION, extract

log = logging.getLogger("ai-service")
app = FastAPI(title="OnboardIQ AI service", version="1.0")
SERVICE_KEY = os.environ.get("SERVICE_KEY", "")
TIMEOUT_S = float(os.environ.get("EXTRACT_TIMEOUT_S", "10"))
MAX_BYTES = 5 * 1024 * 1024


def service_key(x_service_key: Optional[str] = Header(None)):
    if SERVICE_KEY and x_service_key != SERVICE_KEY:
        raise HTTPException(401, "bad service key")


class ExtractIn(BaseModel):
    doc_id: str = Field(max_length=64)
    text: str = Field(max_length=200_000)
    ocr_confidence: Optional[float] = Field(None, ge=0, le=1)


class SummaryIn(BaseModel):
    application_id: str
    reason_codes: list[str] = []
    rule_details: dict = {}
    fields: list[dict] = []


def _failed(version: str) -> dict:
    return {"doc_type": "OTHER", "doc_type_confidence": 0.0, "fields": [], "extractor_version": version}


def _merge_llm(res: extractor.Result, text: str) -> str:
    """Fill fields the rules could not read with LLM values, re-normalised and capped below auto-trust when unverified."""
    out = llm.llm_extract(text)
    have = {f.field_name for f in res.fields}
    if res.doc_type == "OTHER" or "PROMPT_INJECTION_TEXT" in res.flags:
        return f"{RULES_VERSION}+llm:{llm.PROMPT_VERSION}"  # rules decide OTHER; LLM cannot upgrade it
    for name in ["name", "dob", "gender", "pan_number", "aadhaar_last4", "address", "pincode", "document_date", "valid_until"]:
        f = getattr(out, name)
        if name in have or not f or not f.value:
            continue
        v = f.value.strip()
        if name in ("dob", "document_date", "valid_until"):
            v = extractor.norm_date(v)[0]
        elif name == "pan_number":
            v = extractor.fix_pan(v.replace(" ", ""))[0]
        elif name in ("pincode", "aadhaar_last4"):
            v = extractor.digits(v)[0][-6 if name == "pincode" else -4:]
        if v:
            res.fields.append(extractor.Field(name, v, min(f.confidence, 0.79)))  # LLM-only values always go to an officer
    return f"{RULES_VERSION}+llm:{llm.provider()}:{llm.PROMPT_VERSION}"


def _run_extract(body: ExtractIn) -> dict:
    res = extract(body.text, body.ocr_confidence)
    version = RULES_VERSION
    if llm.enabled():
        try:
            version = _merge_llm(res, body.text)
        except Exception as e:  # LLM failure never blocks the rules result
            log.warning("llm failed for %s: %s", body.doc_id, type(e).__name__)
    return {"doc_id": body.doc_id, "doc_type": res.doc_type, "doc_type_confidence": round(res.doc_type_confidence, 2),
            "fields": [f.out() for f in res.fields], "flags": res.flags, "extractor_version": version}


@app.get("/health")
def health():
    return {"ok": True, "extractor": RULES_VERSION, "llm": llm.provider() if llm.enabled() else "none"}


@app.post("/extract", dependencies=[Depends(service_key)])
async def extract_endpoint(body: ExtractIn):
    try:
        return await asyncio.wait_for(asyncio.to_thread(_run_extract, body), timeout=TIMEOUT_S)
    except Exception as e:  # timeout or any error: OTHER with confidence 0 (case goes to REVIEW)
        log.warning("extract failed for %s: %s", body.doc_id, type(e).__name__)
        return {"doc_id": body.doc_id, **_failed(f"{RULES_VERSION}:error:{type(e).__name__}")}


@app.post("/ocr", dependencies=[Depends(service_key)])
async def ocr_endpoint(file: UploadFile = File(...)):
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "file larger than 5 MB")
    if not (data[:8] == b"\x89PNG\r\n\x1a\n" or data[:3] == b"\xff\xd8\xff" or data[:5] == b"%PDF-"):
        raise HTTPException(415, "only PNG, JPEG or PDF")
    from .ocr import ocr
    try:
        return await asyncio.wait_for(asyncio.to_thread(ocr, data, file.content_type), timeout=30)
    except asyncio.TimeoutError:
        raise HTTPException(504, "OCR timed out")
    except ValueError as e:
        raise HTTPException(422, str(e))


@app.post("/summary", dependencies=[Depends(service_key)])
def summary_endpoint(body: SummaryIn):
    text, version = llm.summary(body.application_id, body.reason_codes, body.rule_details, body.fields)
    return {"application_id": body.application_id, "summary": text, "label": "AI-generated", "generator": version, "words": len(text.split())}
