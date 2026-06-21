Analyze the following OCR-extracted text from a document and identify all key-value fields and their data values (for example: Name: Lawrence, Class: 3A5, CGPA: 3.42, etc.).
Return a strictly valid JSON object where keys are the field names (normalized in lowercase with underscores, e.g., 'name', 'class', 'cgpa') and values are the exact text string values of those fields as they appear in the document text.
Extract all relevant fields present in the text. Do not include markdown code blocks (like ```json), just output the raw JSON object.

Document Text:
{raw_text}
