# Model card: OnboardIQ document extractor

| Item | Value |
|---|---|
| Name / version | `rules-1.3` (recorded as `extractor_version` on every document) |
| Type | Deterministic classifier + field extractor: weighted fuzzy keywords with structural anchors, regular expressions, OCR-error repair, reference-lexicon name repair. Optional LangChain LLM fill-in (`+llm:<provider>:extract-p1`). |
| Image path | OpenCV (grayscale, upscale, non-local-means denoise, adaptive threshold, deskew) + Tesseract 5 LSTM (`--oem 1 --psm 6`); PDF pages rasterised at 300 dpi with PyMuPDF. |
| Inputs | OCR text of one document (or a PNG/JPEG/PDF for `/ocr`). Declared document type is **not** an input. |
| Outputs | `doc_type`, `doc_type_confidence`, fields (name, dob, gender, pan_number, aadhaar_last4, address, pincode, document_date, valid_until) with confidence 0-1 and `source_span`. |
| Intended use | Feed the KYC rules engine. **It never decides approval**; fields below 0.80 are ignored by identity rules and send the case to a KYC officer. |
| LLM provider | None by default (`LLM_PROVIDER=none`). When configured: OpenAI-compatible chat model via `langchain-openai`, temperature 0, 8 s timeout. Only the document text is sent; prompts are not logged. |

## Data

Developed on the 178 sample documents and `case_02_document_truth_sample_V1.0.csv`. The name lexicon comes only from reference
data the bank already holds (existing customers, sanctions and PEP lists), never from the truth file or the applicant's declared
values, so the extractor cannot copy the declared name into the "read" name.

## Performance

See `evaluation_report.md` (sample set: classification and field accuracy, clean vs poor scans, precision at the 0.80 threshold,
regex-only and keyword baselines). On the evaluation set, where no truth is provided, 98.6% of our values agree with the mock
extraction where the mock is itself confident (>= 0.80); nearly all disagreements are OCR misreads in the mock (e.g. `8engaluru`)
that our repair fixes.

Limitations: names and addresses on poor scans are repaired from lexicons and get confidence <= 0.84 (unknown words on noisy scans
0.70 so an officer checks them). Unfamiliar names on clean scans are kept as printed (0.86). Real OCR on images can misread
characters (seen: `Q` -> `0` at the end of a PAN); a repaired PAN is scored 0.84 x OCR confidence, which falls below 0.80 and goes
to review rather than causing a PAN_MISMATCH rejection. Template coverage is limited to the five document layouts in the pack.

## Responsible AI

- **Human oversight:** outputs are inputs to rules; every REVIEW and HIGH-risk case needs a maker and a different checker; officers
  can override any field with a reason (stored as `source=OFFICER`, confidence 1.00, kept as labelled feedback).
- **Prompt injection:** document text is data. Instruction-like text ("ignore all previous instructions", "approve this applicant",
  "note for AI assistants") classifies the document OTHER with flag `PROMPT_INJECTION_TEXT` before any LLM is consulted; in the LLM
  path text is wrapped in `<document>` tags, the closing tag is neutralised, output is validated against a Pydantic schema, the
  LLM cannot change the rules' doc_type and LLM-only values are capped at 0.79. Eval doc D3000486 -> OTHER; A2100100 stays REVIEW
  `DOCUMENT_MISSING|DOCUMENT_TYPE_MISMATCH`.
- **Failure:** any exception or > 10 s -> `doc_type OTHER`, confidence 0 -> R3 LOW_EXTRACTION_CONFIDENCE -> officer.
- **Privacy:** synthetic data only; only Aadhaar last 4 digits are ever extracted; no full Aadhaar capture.
- **Fairness:** the same name normalisation for everyone; NAME_MISMATCH_MINOR share by gender is reported in the evaluation report.
- **Summary:** `/summary` lists discrepancies only from rule results, max 80 words, labelled "AI-generated"; output containing
  approve/reject/recommend language is replaced by the deterministic template.
