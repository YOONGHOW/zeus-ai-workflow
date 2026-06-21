import os
import uuid
from fpdf import FPDF
from dbconfig.db import SessionLocal, FileTable

class PDFReport(FPDF):
    def header(self):
        self.set_font("helvetica", "B", 15)
        self.cell(0, 10, "Zeus AI Generated Report", border=False, align="C")
        self.ln(10)
        self.set_draw_color(180, 180, 180)
        self.line(10, 20, 200, 20)
        self.ln(5)

    def footer(self):
        self.set_y(-15)
        self.set_font("helvetica", "I", 8)
        self.cell(0, 10, f"Page {self.page_no()}/{{nb}}", align="C")

def generate_pdf_report(content: str, filename: str, session_id: str = None, userid: int = None) -> dict:
    cleaned_content = content.replace('\u2019', "'").replace('\u2018', "'").replace('\u201c', '"').replace('\u201d', '"').replace('\u2013', '-').replace('\u2014', '-')
    
    pdf = PDFReport()
    pdf.alias_nb_pages()
    pdf.add_page()
    pdf.set_font("helvetica", size=11)
    
    lines = cleaned_content.split('\n')
    table_buffer = []

    def flush_table():
        if not table_buffer:
            return
        html = '<table width="100%" border="1">'
        for i, t_line in enumerate(table_buffer):
            stripped = t_line.replace('|', '').replace('-', '').replace(':', '').replace(' ', '')
            if not stripped:
                continue
            html += '<tr>'
            cells = [c.strip() for c in t_line.strip('|').split('|') if c.strip() or t_line.strip('|').split('|').index(c) > 0]
            for cell in cells:
                cell = cell.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
                if i == 0:
                    html += f'<th align="center"><b>{cell}</b></th>'
                else:
                    html += f'<td>{cell}</td>'
            html += '</tr>'
        html += '</table>'
        pdf.write_html(html)
        table_buffer.clear()

    for line in lines:
        cleaned_line = line.strip()
        
        is_table_row = cleaned_line.startswith('|') and cleaned_line.endswith('|')
        
        if is_table_row:
            table_buffer.append(cleaned_line)
            continue
        else:
            flush_table()

        if not cleaned_line:
            pdf.ln(4)
            continue
        
        if cleaned_line.startswith('### '):
            pdf.set_font("helvetica", "B", 12)
            pdf.cell(0, 8, cleaned_line[4:], ln=1)
            pdf.set_font("helvetica", size=11)
        elif cleaned_line.startswith('## '):
            pdf.set_font("helvetica", "B", 14)
            pdf.cell(0, 10, cleaned_line[3:], ln=1)
            pdf.set_font("helvetica", size=11)
        elif cleaned_line.startswith('# '):
            pdf.set_font("helvetica", "B", 16)
            pdf.cell(0, 12, cleaned_line[2:], ln=1)
            pdf.set_font("helvetica", size=11)
        else:
            ascii_line = line.encode('latin-1', 'replace').decode('latin-1')
            pdf.multi_cell(0, 6, ascii_line)
            pdf.set_x(pdf.l_margin)
            
    flush_table()
            
    pdf_bytes = pdf.output()
    if isinstance(pdf_bytes, str):
        pdf_bytes = pdf_bytes.encode('latin1')
    
    db = SessionLocal()
    try:
        file_id = str(uuid.uuid4())
        if not filename.endswith('.pdf'):
            filename += '.pdf'
            
        new_file = FileTable(
            file_id=file_id,
            filename=filename,
            file_data=pdf_bytes,
            mime_type="application/pdf",
            status="generated_report",
            session_id=session_id,
            userid=userid
        )
        db.add(new_file)
        db.commit()
        return {
            "success": True,
            "file_id": file_id,
            "filename": filename
        }
    except Exception as e:
        db.rollback()
        import traceback
        traceback.print_exc()
        return {
            "success": False,
            "error": str(e)
        }
    finally:
        db.close()
