from paddleocr import PaddleOCR
import tempfile
import os
import json
import uuid

ocr = PaddleOCR(
    use_doc_orientation_classify=False,
    use_doc_unwarping=False,
    use_textline_orientation=False,
    lang="en",
    ocr_version="PP-OCRv4"
)

def process_paddle_ocr(file_bytes: bytes) -> dict:
    is_pdf = file_bytes[:4] == b'%PDF'
    is_webp = file_bytes[:4] == b'RIFF' and file_bytes[8:12] == b'WEBP'
    suffix = ".pdf" if is_pdf else (".webp" if is_webp else ".png")
    
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(file_bytes)
        tmp_path = tmp.name

    try:
        results = ocr.predict(tmp_path)
        json_results = []
        full_text_parts = []
        
        for res in results:
            if hasattr(res, "json"):
                page_data = res.json
            else:
                out_prefix = os.path.join(tempfile.gettempdir(), f"paddle_out_{uuid.uuid4().hex}")
                res.save_to_json(out_prefix)
                
                saved_file = out_prefix + ".json"
                if not os.path.exists(saved_file):
                    saved_file = out_prefix
                    
                if os.path.exists(saved_file):
                    with open(saved_file, "r", encoding="utf-8") as f:
                        page_data = json.load(f)
                    try:
                        os.remove(saved_file)
                    except OSError:
                        pass
                else:
                    page_data = res

            if page_data and isinstance(page_data, dict):
                res_data = page_data.get("res", page_data)
                if isinstance(res_data, dict):
                    texts = res_data.get("rec_texts", [])
                    full_text_parts.extend(texts)

            json_results.append(page_data)
            
        return {"raw_text": "\n".join(full_text_parts), "ocr_details": json_results}
    finally:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except:
                pass
