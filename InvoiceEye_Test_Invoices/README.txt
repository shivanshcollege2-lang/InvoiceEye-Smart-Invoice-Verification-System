InvoiceEye Test Invoice Pack

Current MVP upload support:
- The current InvoiceEye MVP accepts text-based invoice extracts (.txt, and the upload UI also permits .csv/.json).
- Use the files in the text/ folder for immediate testing.
- The current MVP does NOT yet parse PDF invoices with OCR. The PDFs in pdfs/ are realistic visual test documents for the next OCR/document-extraction phase.

Suggested test order:
1. 01_clean_accepted.txt
2. 02_quantity_mismatch.txt
3. 03_price_mismatch.txt
4. 04_duplicate_invoice.txt
5. 05_unknown_purchase_order.txt
6. 06_total_mismatch.txt

Expected intent of each case:
01 -> clean invoice / accepted
02 -> quantity mismatch / needs review
03 -> higher unit price / reject
04 -> duplicate invoice number / reject
05 -> unmatched PO / needs review
06 -> arithmetic total mismatch / should trigger review; current verifier may require hardening of this rule
