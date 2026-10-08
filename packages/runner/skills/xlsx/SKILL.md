---
name: xlsx
description: Create or update Excel workbooks (.xlsx) with formulas, formatting and charts — cash-flow, invoices, reports. Use when the user asks for a spreadsheet.
---

# Excel workbooks (.xlsx)

Use `openpyxl` (in `/opt/wfos-tools/venv`). Keep formulas as formulas so the workbook stays live:

```python
from openpyxl import Workbook
from openpyxl.styles import Font
wb = Workbook(); ws = wb.active; ws.title = "Arus Kas"
ws.append(["Bulan", "Masuk", "Keluar", "Saldo"]); ws["A1"].font = Font(bold=True)
ws.append(["Jan", 1500000, 900000, "=B2-C2"])
ws["B2"].number_format = '"Rp" #,##0'
wb.save("arus-kas.xlsx")
```

- Read existing data with `openpyxl.load_workbook(path, data_only=False)`; never overwrite the original — write a new file.
- Recalculate/verify: `soffice --headless --convert-to pdf arus-kas.xlsx`, then `pdftotext`.
- Rupiah format: `'"Rp" #,##0'`; dates: ISO in cells, formatted with `number_format = "DD/MM/YYYY"`.
