# SmartCV Screening — Product Design

**Date:** 2026-09-29  
**Status:** Draft for user review  
**Scope:** Demo-data MVP, not a production hiring system

## 1. Problem and product intent

Recruiters spend significant time comparing CVs against role requirements. SmartCV should reduce that manual effort by organizing job-related evidence into a transparent scorecard and ranking candidates for review. It is a screening assistant: the recruiter, not the AI, makes shortlist and hiring decisions.

## 2. MVP goals

- Let a recruiter define role criteria in a guided form.
- Let Jev suggest criterion weights, which the recruiter must review and confirm before CV screening.
- Process a batch of 25–200 PDF or DOCX CVs using synthetic or rigorously de-identified demo data.
- Show each completed CV in the dashboard as soon as its own processing finishes; do not wait for the full batch.
- Show per-criterion points, match status, and source-backed CV evidence, then calculate a transparent weighted ranking.
- Let the recruiter inspect the evidence and decide whom to shortlist.

## 3. Out of scope for the MVP

- Automatic rejection, candidate communication, or autonomous hiring decisions.
- Job-board import, ATS integration, interview scheduling, or a full recruitment pipeline.
- Production use with real applicant data.
- OCR for scanned/image-only CVs. Such files are shown as needing manual attention rather than silently scored.
- Learning recruiter preferences from prior decisions.

## 4. User workflow and data flow

1. **Create a role.** The recruiter enters each criterion and its job-related description in a guided form. Jev may suggest relative importance weights. The recruiter can edit and must confirm the weights before uploading CVs.
2. **Upload a batch.** The recruiter uploads 25–200 PDF or DOCX files. Each file is tracked independently so one failure does not stop the rest of the batch.
3. **Extract source text.** Parse PDFs with page references. Normalize DOCX to a stable page-based preview before extraction so evidence can point to a page consistently. Create candidate evidence spans linked to the source; if extraction or page mapping fails, mark the file for manual attention instead of assigning zero points.
4. **Judge each criterion.** Jev evaluates each CV against each confirmed criterion using a structured, consistent rubric. The CV evidence and criterion are kept together as the judgment context. Independent criterion judgments can be run in parallel.
5. **Calculate points in code.** Application code maps the criterion judgments to points and applies the recruiter-approved weights. The model does not generate the final total or decide whom to reject.
6. **Stream results.** As soon as one CV has completed its extraction and criterion evaluations, the server pushes its scorecard to the dashboard. The table inserts the candidate and re-sorts immediately. A live rank is explicitly labeled provisional and is a rank among completed CVs only; positions may change as other CVs finish. Once every file has reached a terminal processing state (scored, needs review, or failed), the system shows the final order for scoreable CVs and keeps failed files visible in an exception state.
7. **Review and shortlist.** The recruiter opens score evidence, corrects or questions the assessment, and makes the shortlist decision. SmartCV does not automatically reject or advance a candidate.

A one-way server-pushed event stream is the preferred interaction for progress and completed results; the exact transport should fit the implementation stack.

## 5. Scorecard and scoring rules

The dashboard is a candidate-by-criterion table: one row per CV, one column per role criterion, plus total points, rank, and processing/review status. Selecting a criterion result opens a short, verbatim CV excerpt and its page location.

Every role criterion contributes to the ranked total; the MVP has no automatic hard-gate exclusion. The following point mapping and weight scale are proposed defaults for review:

- **Strong evidence:** the CV directly supports the requirement or clearly describes an equivalent qualification; use 1.0 of the criterion's weight.
- **Partial evidence:** relevant evidence exists but does not fully establish the requirement; use 0.5 of the criterion's weight.
- **Not found:** no relevant CV evidence was found; use 0 points and show a “not found” flag. This describes the CV, not whether the candidate actually has the qualification.
- **Needs review:** evidence is ambiguous, conflicting, or the model is uncertain. Show the best estimated match level and its provisional points with a prominent review flag; do not silently convert uncertainty into “not found.”

Jev may suggest an integer importance weight from 1 (lower importance) to 5 (higher importance), but the recruiter must confirm it before screening. Code calculates the score as `100 × sum(weight × evidence_fraction) / sum(weight)`, using the same mapping for every candidate for that role. A “needs review” result uses the model's best estimate for provisional points and remains visibly flagged; the recruiter can inspect or adjust it. Confidence can trigger a review flag, but must never by itself hide or reject a candidate. Any confidence threshold used for highlighting must be selected against the demo set.

Evidence must come from the source CV, not generated prose. The extraction step associates text spans with page locations; Jev selects relevant evidence from those spans or returns no match. The application verifies a displayed excerpt against the extracted source before presenting it. If no relevant span is found, the result is “not found.”

Only explicit, job-related criteria may affect points. The system must not infer personality or score candidates on protected or demographic characteristics.

## 6. Processing states and failure behavior

Each CV has its own status, such as queued, extracting, evaluating, complete, needs review, or failed. A parse failure, unreadable file, or model/service error affects that CV only. The rest of the batch continues, and the recruiter can retry an individual failure without restarting the batch. Failed or unreadable files remain visible but do not receive a fabricated score or rank.

Uncertain criterion evaluations remain visible with their best estimate and a review flag. The recruiter can inspect the evidence and adjust the assessment; any resulting point and rank changes are reflected in the scorecard.

## 7. Privacy and responsible use

The demo uses synthetic or rigorously de-identified CVs only. Identifiable real applicant data must not be used until access controls, storage and deletion/retention rules, model-provider data terms, and relevant legal requirements have been reviewed. Raw CV text should not be written to application logs. The evaluation context should be limited to role criteria and relevant CV content.

The ranking is decision support, not a hiring decision. Recruiters retain control, and SmartCV does not send candidate communications or take irreversible hiring actions.

## 8. Validation plan

Build a human-reviewed demo set covering direct matches, equivalent wording, partial evidence, missing evidence, ambiguous statements, contradictory CV content, and unreadable files. Validate:

- That every displayed excerpt is present in the source and points to the correct page.
- Agreement between criterion judgments and human-reviewed labels.
- Whether recruiters find the top-ranked candidates useful for a shortlist.
- Time from upload to the first result, full batch completion, and a recruiter-prepared shortlist.
- Correct provisional ranking updates, finalization, and per-file failure isolation.

Model confidence is a signal for review, not proof of correctness. Results should be measured on the demo set before presenting any accuracy or time-saving claim.

## 9. Design rationale

A Jev-first hybrid fits the scorecard workflow: ordinary application code handles file state, source locations, confirmed weights, arithmetic, sorting, and side effects; Jev handles narrow semantic judgments about whether CV evidence supports each job criterion. A general LLM can be considered later for a specific need such as optional summaries, but it is not required to calculate the MVP ranking.

This follows TypeSafe’s documented System One pattern of keeping workflow control in code and composing structured judgments, including its recruiting and composite resume-scoring examples. Those examples support architectural fit, not a guarantee of accuracy for SmartCV; SmartCV must validate against its own reviewed CV set.

## 10. Implementation decisions to confirm later

The approved product behaviors are the recruiter-confirmed weights, source-backed evidence, independent CV processing, live provisional ranking, and no automatic rejection. The numeric defaults in Section 5 (weights from 1–5 and evidence fractions of 1.0, 0.5, and 0) are proposals for this spec review, not finalized decisions. Before implementation, select a review-highlighting threshold using the demo set; it may add a review flag but cannot hide or reject a CV. The implementation plan must also choose the application stack, extraction libraries, storage, event-stream transport, and demo dataset language while preserving the approved product behaviors.
