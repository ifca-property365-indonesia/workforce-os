---
name: docx
description: Create or edit Word documents (.docx) as deliverables — reports, letters, proposals, SOPs. Use when the user asks for a Word/DOCX file.
---

# Word documents (.docx)

Tools in the sandbox: `python3` with `python-docx` (in `/opt/wfos-tools/venv`), `pandoc`, LibreOffice (`soffice --headless`).

1. Simple structured text: write Markdown, then `pandoc report.md -o report.docx` (add `--reference-doc=template.docx` for a house style).
2. Precise layout (tables, headers, styles): a Python script with `python-docx`:
   ```python
   from docx import Document
   doc = Document()
   doc.add_heading("Laporan Bulanan", 1)
   t = doc.add_table(rows=1, cols=3); t.style = "Light Grid Accent 1"
   doc.save("laporan.docx")
   ```
3. Check the result: `soffice --headless --convert-to pdf laporan.docx` and `pdftotext laporan.pdf - | head`.
4. Save the file in the workspace and mention its path in your summary; dates and money follow the task language (e.g. `Rp 1.234.567`).
