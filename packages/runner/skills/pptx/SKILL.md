---
name: pptx
description: Build PowerPoint decks (.pptx) — pitch decks, proposals, status reviews. Use when the user asks for slides or a presentation.
---

# PowerPoint decks (.pptx)

Use `python-pptx` (in `/opt/wfos-tools/venv`):

```python
from pptx import Presentation
from pptx.util import Pt
prs = Presentation()
s = prs.slides.add_slide(prs.slide_layouts[1])
s.shapes.title.text = "Proposal Proyek"
s.placeholders[1].text = "Ruang lingkup\nJadwal\nBiaya"
prs.save("proposal.pptx")
```

- One idea per slide, at most 5 bullets, short sentences.
- Preview: `soffice --headless --convert-to pdf proposal.pptx` and check page count with `pdfinfo`.
