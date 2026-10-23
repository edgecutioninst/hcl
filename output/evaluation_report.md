# OnboardIQ extraction evaluation

Extractor `rules-1.3` (deterministic rules + OCR repair + reference-lexicon name repair; no LLM). Development and scoring on the 178 sample documents with `case_02_document_truth_sample_V1.0.csv`. The evaluation set has no truth, so only its outputs are produced.

## AI-1 Classification

| Method | Accuracy |
|---|---|
| Declared doc type (customer choice) | 98.3% |
| Single-keyword rule baseline | 82.6% |
| **OnboardIQ classifier** | **100.0%** |

Confusion matrix (rows = truth, columns = predicted):

| truth \ pred | PAN_CARD | AADHAAR_CARD | ELECTRICITY_BILL | BANK_STATEMENT | DRIVING_LICENCE | OTHER |
|---|---|---|---|---|---|---|
| PAN_CARD | 60 | 0 | 0 | 0 | 0 | 0 |
| AADHAAR_CARD | 0 | 57 | 0 | 0 | 0 | 0 |
| ELECTRICITY_BILL | 0 | 0 | 22 | 0 | 0 | 0 |
| BANK_STATEMENT | 0 | 0 | 0 | 27 | 0 | 0 |
| DRIVING_LICENCE | 0 | 0 | 0 | 0 | 10 | 0 |
| OTHER | 0 | 0 | 0 | 0 | 0 | 2 |

Prompt-injection document(s) in the evaluation set: D3000486 -> classified OTHER (flag PROMPT_INJECTION_TEXT). A2100100 AI decision: `REVIEW` `DOCUMENT_MISSING|DOCUMENT_TYPE_MISMATCH`.

## AI-2 Field extraction (exact match after normalisation)

| Field | All | Clean scans | Poor scans | Regex-only v1 |
|---|---|---|---|---|
| name | 100.0% (176) | 100.0% | 100.0% | 50.0% |
| dob | 100.0% (127) | 100.0% | 100.0% | 91.3% |
| gender | 100.0% (57) | 100.0% | 100.0% | 100.0% |
| pan_number | 100.0% (60) | 100.0% | 100.0% | 98.3% |
| aadhaar_last4 | 100.0% (57) | 100.0% | 100.0% | 96.5% |
| address | 100.0% (116) | 100.0% | 100.0% | 0.0% |
| pincode | 100.0% (116) | 100.0% | 100.0% | 95.7% |
| document_date | 100.0% (49) | 100.0% | 100.0% | 93.9% |
| valid_until | 100.0% (10) | 100.0% | n/a | 80.0% |
| **overall** | **100.0%** (768) | 100.0% | 100.0% | 70.3% |

Poor scans = documents whose specimen banner is damaged by OCR (13 of 178).

## AI-4 Confidence calibration

| Confidence band | Fields | Correct | Precision |
|---|---|---|---|
| >= 0.80 (used by rules) | 755 | 755 | 100.0% |
| < 0.80 (sent to officer) | 13 | 13 | 100.0% |

Officer corrections are stored as `ExtractedField` rows with `source = OFFICER`, `reason`, `createdBy` and the superseded value kept inactive; `SELECT count(*) FILTER (WHERE source='OFFICER') / count(DISTINCT "documentId")` gives the correction rate per document for re-training.

## Decisions with AI extraction

Sample set: 56/60 applications get the same decision as the expected (mock-extraction) column. Differences:

| Application | Expected (mock) | AI extraction |
|---|---|---|
| A2000009 | REVIEW LOW_EXTRACTION_CONFIDENCE | APPROVE  |
| A2000013 | REVIEW LOW_EXTRACTION_CONFIDENCE | APPROVE  |
| A2000017 | REVIEW LOW_EXTRACTION_CONFIDENCE | APPROVE  |
| A2000047 | REVIEW LOW_EXTRACTION_CONFIDENCE | APPROVE  |

Evaluation set: 3/100 decisions differ between the mock extraction (`decisions_output.csv`) and our extraction (`ai_decisions_output.csv`).

## Fairness: NAME_MISMATCH_MINOR by gender (evaluation set, AI decisions)

| Gender | Applications | NAME_MISMATCH_MINOR | Share |
|---|---|---|---|
| F | 50 | 1 | 2.0% |
| M | 50 | 1 | 2.0% |

Name normalisation is identical for everyone (titles removed, token order ignored). Flagged cases:

- A2100012 (M): declared `Rahul Nath Pillai`, document shows `Rahul N Pillai` (score 0.8235)
- A2100048 (F): declared `Ananya Devi Sharma`, document shows `Ananya D Sharma` (score 0.8333)

## Held-out sanity check (evaluation set)

The sample scores above are on the development set the rules were tuned on, so they overstate expected accuracy. On the evaluation set (not used for tuning, no truth file) our values agree with 1532/1554 (98.6%) of the mock extraction's own confident (>= 0.80) values; inspected disagreements are mostly OCR misreads in the mock (e.g. `8engaluru`, `Flat 1Z`) that our repair corrects, plus a few poor-scan addresses we score below 0.80.
