import sys
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='backslashreplace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='backslashreplace')
import os
import re
import json
from types import ModuleType
try:
    try:
        from langchain_core.documents import Document
    except ImportError:
        class Document:
            def __init__(self, page_content, metadata=None):
                self.page_content = page_content
                self.metadata = metadata or {}

    if 'langchain.docstore.document' not in sys.modules:
        doc_mod = ModuleType('langchain.docstore.document')
        doc_mod.Document = Document
        sys.modules['langchain.docstore.document'] = doc_mod

    if 'langchain.docstore' not in sys.modules:
        docstore_mod = ModuleType('langchain.docstore')
        docstore_mod.document = doc_mod
        sys.modules['langchain.docstore'] = docstore_mod
except Exception as e:
    print(f"[Warning] Failed to setup langchain compat layer: {e}")
import time
import uuid
import asyncio
import certifi
import httpx
from typing import List, Optional
from fastapi import FastAPI, APIRouter, Form, HTTPException, Body, UploadFile, File, Depends, Response, BackgroundTasks
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import or_
from dbconfig.firebase import upload_file_to_firebase, download_file_from_firebase, get_file_url
from dbconfig.db import (
    FileTable,
    Base,
    SessionLocal,
    engine,
    ApiConn,
    DbConn,
    UserConnectionPermission,
    UserTable,
    ChatSession,
    ChatHistory,
    ScheduledTask,
    OcrCorrection,
    TaskNotification,
    TrackError,
    WorkflowTask,
    get_db,
    save_to_history,
    log_error_to_db,
)
import hashlib
import traceback


sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
os.environ["DISABLE_MODEL_SOURCE_CHECK"] = "True"
os.environ["KMP_DUPLICATE_LIB_OK"] = "True"
os.environ["FLAGS_enable_pir_api"] = "0"
os.environ['GRPC_DEFAULT_SSL_ROOTS_FILE_PATH'] = certifi.where()
os.environ['SSL_CERT_FILE'] = certifi.where()

from dotenv import load_dotenv
env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env')
load_dotenv(dotenv_path=env_path)
API_BASE_URL = os.getenv("VITE_API_BASE_URL") or "http://127.0.0.1:8080"

def load_prompt(filename: str) -> str:
    try:
        base_path = os.path.dirname(os.path.abspath(__file__))
        file_path = os.path.join(base_path, "souls", filename)
        if not os.path.exists(file_path):
            print(f"[Error] Prompt file not found: {file_path}")
            return ""
        with open(file_path, "r", encoding="utf-8") as file:
            return file.read()
    except Exception as exc:
        print(f"[Error] Error reading prompt file '{filename}': {exc}")
        return ""



# --- GEMINI LLM SETUP ---
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

async def call_llm(prompt: str) -> str:
    from function.api_client import ZeusAPIClient
    return await ZeusAPIClient.get_instance().generate_content(
        prompt=prompt,
        system_instruction="You are a helpful assistant that outputs strictly valid JSON.",
        response_mime_type="application/json",
        temperature=0.0
    )

def parse_gemini_json(text: str):
    if not text: return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        try:
            cleaned = re.sub(r"```json\s*", "", text, flags=re.IGNORECASE)
            cleaned = re.sub(r"```", "", cleaned)
            cleaned = cleaned.strip()
            return json.loads(cleaned)
        except Exception:
            return None

# --- GOOGLE CALENDAR & GMAIL MCP HELPER FUNCTIONS ---
from function import (
    insert_calendar_event_directly,
    execute_send_email,
    execute_web_search,
    process_paddle_ocr,
    get_embedding,
    cosine_similarity,
    chunk_text,
    ensure_project_embeddings,
    PROJECT_EMBEDDINGS,
    ZeusAPIClient,
)


async def call_apifreellm(prompt: str, token_holder: dict = None) -> str:
    try:
        return await ZeusAPIClient.get_instance().generate_content(
            prompt=prompt,
            temperature=0.6,
            token_holder=token_holder
        )
    except Exception as e:
        print(f"LLM Error: {e}")
        return "[Warning] Sorry, I encountered an internal error while processing your request. Please try again."


# --- WEB SEARCH & CRAWLER MCP HELPERS ---
SEARCH_RESULT_LIMIT = 5
MAX_CRAWLED_SOURCES = 3
MAX_MARKDOWN_CHARS_PER_SOURCE = 8000
BLOCKED_SEARCH_EXTENSIONS = (".pdf", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".zip")
MODE_WEB_SEARCH = "Web Search"
MODE_OCR = "Document Text Extractor"
MODE_SMART = "Auto"
MODE_CALENDAR = "Google Calendar"
MODE_GMAIL = "Google Gmail"

def _normalize_mode(mode_text: str) -> str:
    """Strip emojis and extra whitespace so frontend modes match backend constants."""
    cleaned = re.sub(r'[^\w\s]', '', mode_text).strip()
    return cleaned

async def execute_read_document(file_id: str) -> str:
    from dbconfig.db import SessionLocal, FileTable
    
    db = SessionLocal()
    try:
        record = db.query(FileTable).filter(FileTable.file_id == file_id).first()
        if record and record.ocr_details and record.extracted_data:
            return json.dumps({
                "ocr_text": record.ocr_text,
                "ocr_details": record.ocr_details,
                "extracted_data": record.extracted_data
            })
    except Exception as db_err:
        print(f"Error reading doc from DB: {db_err}")
    finally:
        db.close()

    async with httpx.AsyncClient(timeout=120.0) as client:
        try:
            async with client.stream("GET", f"{API_BASE_URL}/process_document/{file_id}") as response:
                if response.status_code != 200:
                    return f"Error reading document: Status {response.status_code}"
                async for line in response.aiter_lines():
                    pass # Consume the stream to let the processing finish and save to DB
            
            db = SessionLocal()
            try:
                record = db.query(FileTable).filter(FileTable.file_id == file_id).first()
                if record and record.ocr_details and record.extracted_data:
                    return json.dumps({
                        "ocr_text": record.ocr_text,
                        "ocr_details": record.ocr_details,
                        "extracted_data": record.extracted_data
                    })
            except Exception as db_err:
                print(f"Error reading doc from DB second time: {db_err}")
            finally:
                db.close()
                
            return "Error: Document processed but results not found in DB."
        except Exception as exc:
            return f"Tool execution failed: {str(exc)}"

# --- PYDANTIC SCHEMAS ---
class HighlightRequest(BaseModel):
    file_id: str
    fields: List[str]
    existing_values: dict = {}

class DbConnCreate(BaseModel):
    name: str
    database_name: str = ""
    connection_str: str = ""
    type: str = ""
    description: str = ""
    host: str = ""
    port: str = ""
    user: str = ""
    password: str = ""
    ssl_mode: bool = False

class ApiConnCreate(BaseModel):
    name: str
    api_url: str = ""
    description: str = ""
    parameter: str = ""
    method: str = "GET"
    api_key: str = ""


class ZeusChatRequest(BaseModel):
    session_id: str
    message: str
    mode: str
    file_ids: List[str] = []
    system_instructions: str = ""
    temperature: float = 0.7
    tone: str = "professional"
    db_conn_id: Optional[int] = None
    is_api: Optional[bool] = False
    api_conn_id: Optional[int] = None

class RegisterRequest(BaseModel):
    email: str
    password: str
    confirmPassword: str

class LoginRequest(BaseModel):
    email: str
    password: str

class SettingsRequest(BaseModel):
    userid: int
    google_connected: int
    email_enabled: int
    calendar_enabled: int

class GenerateDataReportRequest(BaseModel):
    userid: int
    db_name: str
    prompt: str
    filename: str = "data_report.pdf"
    session_id: Optional[str] = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    print("[OK] Databases initialized (Postgres)")
    try:
        from sqlalchemy import text
        with engine.begin() as conn:
            conn.execute(text("ALTER TABLE client ADD COLUMN IF NOT EXISTS token_usage INTEGER DEFAULT 0;"))
            conn.execute(text("ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;"))
            conn.execute(text("ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS userid INTEGER;"))
            conn.execute(text("ALTER TABLE workflow_schedules ADD COLUMN IF NOT EXISTS userid INTEGER;"))
            try:
                conn.execute(text("ALTER TABLE client ADD COLUMN last_reset_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP"))
                print("Auto-migration: Added last_reset_date to client table.")
            except Exception as e:
                if "already exists" not in str(e).lower():
                    print(f"Migration note: {e}")
        print("[OK] Database schema updated: client, chat_sessions and workflow_schedules columns verified")
    except Exception as e:
        print(f"[Error] Failed to update schema dynamically: {e}")

    try:
        from dbconfig.db import TaskNotification
        TaskNotification.__table__.create(bind=engine, checkfirst=True)
        print("Auto-migration: Ensured task_notification table exists.")
    except Exception as e:
        print(f"TaskNotification migration error: {e}")

    from workflow.scheduler import start_scheduler
    start_scheduler()
    
    yield

app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://zeus-ai-workflow.firebaseapp.com",
        "https://zeus-ai-workflow.web.app",
        "http://127.0.0.1:8080",
        "http://localhost:5173",
        "http://localhost:8080",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)

#----------------- Database Session Setup (get_db imported from dbconfig.db) ----------------

class SaveHistoryRequest(BaseModel):
    session_id: str
    role: str
    content: str
    mode: str = "Auto"

def find_bounding_boxes_for_value(value, ocr_details: List[dict]) -> List[dict]:
    if value is None or not ocr_details:
        return []
    
    # If the value is a dictionary or a list, recursively collect all sub-values
    sub_values = []
    if isinstance(value, dict):
        for v in value.values():
            if v is not None:
                sub_values.append(v)
    elif isinstance(value, list):
        for v in value:
            if v is not None:
                sub_values.append(v)
    else:
        sub_values.append(value)
        
    results = []
    for item in sub_values:
        if isinstance(item, (dict, list)):
            # Nested list/dict
            results.extend(find_bounding_boxes_for_value(item, ocr_details))
            continue
            
        val_str = str(item).strip()
        if not val_str:
            continue
        val_lower = val_str.lower()
        
        # Look for matches in OCR details
        for page_idx, page in enumerate(ocr_details):
            res = page.get("res", page)
            texts = res.get("rec_texts", [])
            polys = res.get("dt_polys", [])
            for i, text in enumerate(texts):
                text_str = str(text).strip()
                text_lower = text_str.lower()
                if val_lower == text_lower or val_lower in text_lower:
                    poly = polys[i]
                    flat_box = [coord for pt in poly for coord in pt] if poly else []
                    results.append({
                        "box": flat_box,
                        "page": page_idx,
                        "text": text_str
                    })
                    break # Match one per sub-value to prevent duplicated highlights of same sub-value
    return results

@app.post("/highlight_fields")
async def highlight_fields(payload: HighlightRequest, db: Session = Depends(get_db)):
    try:
        record = db.query(FileTable).filter(FileTable.file_id == payload.file_id).first()
        if not record:
            raise HTTPException(404, "File not found")
        
        ocr_details = record.ocr_details or []
        highlights = []
        
        for field in payload.fields:
            val = payload.existing_values.get(field, None)
            if val is not None:
                # Handle single values as dict containing "value" if they are structured that way
                val_to_search = val
                if isinstance(val, dict) and "value" in val:
                    val_to_search = val["value"]
                    
                matches = find_bounding_boxes_for_value(val_to_search, ocr_details)
                if matches:
                    for m in matches:
                        highlights.append({
                            "field": field,
                            "value": m["text"],
                            "box": m["box"],
                            "page": m["page"]
                        })
                else:
                    highlights.append({
                        "field": field,
                        "value": str(val),
                        "box": None,
                        "page": 0
                    })
        return {"highlights": highlights}
    except Exception as e:
        raise HTTPException(500, detail=str(e))

# ---------------- MAIN ENDPOINT OCR ----------------
@app.get("/process_document/{file_id}")
async def process_document(file_id: str, db: Session = Depends(get_db)):
    # Start the streaming generator
    async def event_stream():
        try:
            record = db.query(FileTable).filter(FileTable.file_id == file_id).first()
            if not record:
                yield json.dumps({"error": "File not found"}) + "\n\n"
                return

            if record.ocr_details and record.extracted_data:
                if record.status != "ocr_completed":
                    record.status = "ocr_completed"
                    db.commit()
                yield json.dumps({
                    "progress": "Complete", 
                    "percent": 100, 
                    "ocr_text": record.ocr_text or "", 
                    "ocr_details": record.ocr_details, 
                    "extracted_data": record.extracted_data
                }) + "\n\n"
                return

            yield json.dumps({"progress": "Initializing...", "percent": 10}) + "\n\n"
            await asyncio.sleep(0.1)

            file_bytes = download_file_from_firebase(record.file_id) if getattr(record, 'firebase_url', None) else b""
            filename = record.filename or ""
            mime_type = record.mime_type or ""

            is_text_file = False
            if mime_type.startswith("text/") or filename.lower().endswith(('.txt', '.csv', '.json', '.md', '.xml', '.yaml', '.yml')):
                is_text_file = True

            ocr_details = []
            raw_text_parts = []

            if is_text_file:
                yield json.dumps({"progress": "Processing text file...", "percent": 40}) + "\n\n"
                try:
                    raw_text = file_bytes.decode("utf-8", errors="ignore")
                    ocr_details = [{"res": {"rec_texts": [raw_text], "dt_polys": []}}]
                    raw_text_parts.append(raw_text)
                except Exception:
                    loop = asyncio.get_event_loop()
                    res = await loop.run_in_executor(None, process_paddle_ocr, file_bytes)
                    ocr_details = res.get("ocr_details", [])
                    raw_text_parts.append(res.get("raw_text", ""))
            else:
                is_pdf = mime_type == "application/pdf" or filename.lower().endswith(".pdf")
                if is_pdf:
                    try:
                        import fitz
                        doc = fitz.open(stream=file_bytes, filetype="pdf")
                        total_pages = len(doc)
                        yield json.dumps({"progress": f"Found {total_pages} pages...", "percent": 15}) + "\n\n"

                        loop = asyncio.get_event_loop()
                        for i in range(total_pages):
                            page = doc.load_page(i)
                            pix = page.get_pixmap()
                            img_bytes = pix.tobytes("png")
                            
                            yield json.dumps({"progress": f"Processing Page {i+1} of {total_pages}...", "percent": 15 + int((i/total_pages)*60)}) + "\n\n"
                            res = await loop.run_in_executor(None, process_paddle_ocr, img_bytes)
                            page_details = res.get("ocr_details", [])
                            for p in page_details:
                                if isinstance(p, dict): p["page_num"] = i
                            
                            ocr_details.extend(page_details)
                            raw_text_parts.append(res.get("raw_text", ""))
                    except Exception as e:
                        print(f"PyMuPDF error: {e}")
                        # Fallback to direct OCR
                        yield json.dumps({"progress": "Processing image...", "percent": 40}) + "\n\n"
                        loop = asyncio.get_event_loop()
                        res = await loop.run_in_executor(None, process_paddle_ocr, file_bytes)
                        ocr_details = res.get("ocr_details", [])
                        raw_text_parts.append(res.get("raw_text", ""))
                else:
                    yield json.dumps({"progress": "Processing image...", "percent": 40}) + "\n\n"
                    loop = asyncio.get_event_loop()
                    res = await loop.run_in_executor(None, process_paddle_ocr, file_bytes)
                    ocr_details = res.get("ocr_details", [])
                    raw_text_parts.append(res.get("raw_text", ""))

            raw_text = "\n".join(raw_text_parts)

            extracted_data = {}
            if raw_text:
                yield json.dumps({"progress": "Extracting intelligence with AI...", "percent": 80}) + "\n\n"
                try:
                    prompt_template = load_prompt("docAgent.md")
                    llm_prompt = prompt_template.replace("{raw_text}", raw_text)
                    llm_response = await call_llm(llm_prompt)
                    llm_fields = parse_gemini_json(llm_response) or {}

                    for key, val in llm_fields.items():
                        if val is not None:
                            # Use find_bounding_boxes_for_value to get all sub-value boxes
                            matches = find_bounding_boxes_for_value(val, ocr_details)
                            if matches:
                                # If there are multiple matches (nested array/dict), store the list of boxes
                                # and the original parsed value
                                extracted_data[key] = {
                                    "value": val,
                                    "box": matches[0]["box"] if len(matches) == 1 else [m["box"] for m in matches if m["box"]],
                                    "page": matches[0]["page"] if len(matches) == 1 else [m["page"] for m in matches]
                                }
                            else:
                                extracted_data[key] = {
                                    "value": val,
                                    "box": None,
                                    "page": 0
                                }
                except Exception as e:
                    print(f"[Error] LLM extraction: {e}")

            record.ocr_text = raw_text
            record.ocr_details = ocr_details
            record.extracted_data = extracted_data
            record.status = "ocr_completed"
            db.commit()

            yield json.dumps({
                "progress": "Complete", 
                "percent": 100, 
                "ocr_text": raw_text, 
                "ocr_details": ocr_details, 
                "extracted_data": extracted_data
            }) + "\n\n"

        except Exception as e:
            yield json.dumps({"error": str(e)}) + "\n\n"
        finally:
            db.close()

    return StreamingResponse(event_stream(), media_type="text/event-stream")

@app.post("/process_document/{file_id}/corrections")
async def save_ocr_corrections(file_id: str, payload: dict, db: Session = Depends(get_db)):
    try:
        from dbconfig.db import OcrCorrection
        field_name = payload.get("field")
        corrected_value = payload.get("value")
        original_value = payload.get("original")
        
        correction = OcrCorrection(
            file_id=file_id,
            field_name=field_name,
            original_value=original_value,
            corrected_value=corrected_value
        )
        db.add(correction)
        db.commit()
        return {"status": "success"}
    except Exception as e:
        db.rollback()
        raise HTTPException(500, detail=str(e))

@app.post("/upload")
async def upload_document(
    file: UploadFile = File(...),
    session_id: Optional[str] = Form(None),
    userid: Optional[int] = Form(None),
    db: Session = Depends(get_db)
):
    file_bytes = await file.read()
    file_id = f"FILE-{int(time.time())}"
    
    firebase_url = upload_file_to_firebase(file_bytes, file_id, file.content_type)
    
    new_record = FileTable(  
        file_id=file_id,
        filename=file.filename,
        firebase_url=firebase_url, 
        mime_type=file.content_type,
        status="uploaded",
        session_id=session_id,
        userid=userid
    )
    
    db.add(new_record)
    db.commit()
    return {"fileId": file_id, "status": "uploaded"}

@app.get("/document_info/{file_id}")
async def get_document_info(file_id: str, db: Session = Depends(get_db)):
    record = db.query(FileTable).filter(FileTable.file_id == file_id).first()
    if not record:
        raise HTTPException(404, "File not found")
    return {
        "file_id": record.file_id,
        "filename": record.filename,
        "mime_type": record.mime_type,
        "ocr_text": record.ocr_text,
        "ocr_details": record.ocr_details,
        "extracted_data": record.extracted_data
    }

@app.get("/view-file/{file_id}")
async def get_file(file_id: str, db: Session = Depends(get_db)):
    record = db.query(FileTable).filter(FileTable.file_id == file_id).first()
    if not record:
        raise HTTPException(status_code=404, detail="File not found")
    file_bytes = download_file_from_firebase(record.file_id) if getattr(record, 'firebase_url', None) else b""
    return Response(content=file_bytes, media_type=record.mime_type)

@app.get("/search/documents")
async def search_documents(term: str, db: Session = Depends(get_db)):
    search_pattern = f"%{term}%" 
    
    results = db.query(FileTable).filter(
        or_(
            FileTable.file_id == term,
            FileTable.filename.ilike(search_pattern),
            FileTable.status.ilike(search_pattern),
            FileTable.ocr_text.ilike(search_pattern) 
        )
    ).all()
    
    return results

# ---------------- FUNCTION DEFINITIONS FOR MCP ----------------
async def process_document_background(file_id: str):
    from dbconfig.db import SessionLocal, FileTable
    db = SessionLocal()
    try:
        record = db.query(FileTable).filter(FileTable.file_id == file_id).first()
        if not record:
            print(f"[Background Task] File {file_id} not found in DB")
            return

        if record.ocr_details and record.extracted_data:
            if record.status != "ocr_completed":
                record.status = "ocr_completed"
                db.commit()
            print(f"[Background Task] Document {file_id} already processed")
            return

        file_bytes = download_file_from_firebase(record.file_id) if getattr(record, 'firebase_url', None) else b""
        if not file_bytes:
            print(f"[Background Task] File bytes empty or download failed for {file_id}")
            return

        filename = record.filename or ""
        mime_type = record.mime_type or ""
        is_text_file = mime_type.startswith("text/") or filename.lower().endswith(('.txt', '.csv', '.json', '.md', '.xml', '.yaml', '.yml'))

        ocr_details = []
        raw_text_parts = []
        
        import asyncio
        loop = asyncio.get_event_loop()

        if is_text_file:
            try:
                raw_text = file_bytes.decode("utf-8", errors="ignore")
                ocr_details = [{"res": {"rec_texts": [raw_text], "dt_polys": []}}]
                raw_text_parts.append(raw_text)
            except Exception:
                res = await loop.run_in_executor(None, process_paddle_ocr, file_bytes)
                ocr_details = res.get("ocr_details", [])
                raw_text_parts.append(res.get("raw_text", ""))
        else:
            is_pdf = mime_type == "application/pdf" or filename.lower().endswith(".pdf")
            if is_pdf:
                try:
                    import fitz
                    doc = fitz.open(stream=file_bytes, filetype="pdf")
                    
                    # Direct PDF text extraction fast path
                    pdf_text_parts = []
                    pdf_ocr_details = []
                    for i in range(len(doc)):
                        page = doc.load_page(i)
                        text = page.get_text()
                        if text.strip():
                            pdf_text_parts.append(text)
                            pdf_ocr_details.append({
                                "page_num": i,
                                "res": {
                                    "rec_texts": [text],
                                    "dt_polys": []
                                }
                            })
                    
                    extracted_pdf_text = "\n".join(pdf_text_parts)
                    if len(extracted_pdf_text.strip()) > 20:
                        print(f"[Background Task] Extracted {len(extracted_pdf_text)} characters directly from PDF using PyMuPDF fast-path.")
                        ocr_details = pdf_ocr_details
                        raw_text_parts = pdf_text_parts
                    else:
                        print("[Background Task] PDF has no copyable text. Running page-by-page OCR.")
                        total_pages = len(doc)
                        for i in range(total_pages):
                            page = doc.load_page(i)
                            pix = page.get_pixmap()
                            img_bytes = pix.tobytes("png")
                            res = await loop.run_in_executor(None, process_paddle_ocr, img_bytes)
                            page_details = res.get("ocr_details", [])
                            for p in page_details:
                                if isinstance(p, dict): p["page_num"] = i
                            ocr_details.extend(page_details)
                            raw_text_parts.append(res.get("raw_text", ""))
                except Exception as e:
                    print(f"[Background Task] PyMuPDF error: {e}")
                    log_error_to_db(
                        component="process_document_background (PyMuPDF)",
                        error_message=str(e),
                        stack_trace=traceback.format_exc()
                    )
                    res = await loop.run_in_executor(None, process_paddle_ocr, file_bytes)
                    ocr_details = res.get("ocr_details", [])
                    raw_text_parts.append(res.get("raw_text", ""))
            else:
                res = await loop.run_in_executor(None, process_paddle_ocr, file_bytes)
                ocr_details = res.get("ocr_details", [])
                raw_text_parts.append(res.get("raw_text", ""))

        raw_text = "\n".join(raw_text_parts)
        extracted_data = {}

        if raw_text:
            try:
                prompt_template = load_prompt("docAgent.md")
                llm_prompt = prompt_template.replace("{raw_text}", raw_text)
                llm_response = await call_llm(llm_prompt)
                llm_fields = parse_gemini_json(llm_response) or {}
                for key, val in llm_fields.items():
                    if val is not None:
                        # Use find_bounding_boxes_for_value to get all sub-value boxes
                        matches = find_bounding_boxes_for_value(val, ocr_details)
                        if matches:
                            extracted_data[key] = {
                                "value": val,
                                "box": matches[0]["box"] if len(matches) == 1 else [m["box"] for m in matches if m["box"]],
                                "page": matches[0]["page"] if len(matches) == 1 else [m["page"] for m in matches]
                            }
                        else:
                            extracted_data[key] = {
                                "value": val,
                                "box": None,
                                "page": 0
                            }
            except Exception as e:
                print(f"[Background Task] LLM extraction error: {e}")
                log_error_to_db(
                    component="process_document_background (LLM)",
                    error_message=str(e),
                    stack_trace=traceback.format_exc()
                )

        record.ocr_text = raw_text
        record.ocr_details = ocr_details
        record.extracted_data = extracted_data
        record.status = "ocr_completed"
        db.commit()
        print(f"[Background Task] Document {file_id} processed successfully")
    except Exception as e:
        db.rollback()
        print(f"[Background Task] Error processing document {file_id}: {e}")
        log_error_to_db(
            component="process_document_background",
            error_message=str(e),
            stack_trace=traceback.format_exc()
        )
    finally:
        db.close()

@app.post("/upload_document")
async def upload_document(
    file: UploadFile = File(...), 
    session_id: str = Form(None),
    userid: Optional[int] = Form(None),
    background_tasks: BackgroundTasks = None,
    db: Session = Depends(get_db)
):
    try:
        file_id = str(uuid.uuid4())
        
        contents = await file.read()
        
        firebase_url = upload_file_to_firebase(contents, file_id, file.content_type)
        
        new_file = FileTable(
            file_id=file_id,
            filename=file.filename,
            firebase_url=firebase_url,  
            mime_type=file.content_type,
            status="pending_ocr",
            session_id=session_id,
            userid=userid
        )
        
        db.add(new_file)
        db.commit()
        
        #print(f"[OK] File saved to PostgreSQL: {file_id}, Session: {session_id}")
        
        if background_tasks:
            background_tasks.add_task(process_document_background, file_id)
            
        return {
            "file_id": file_id, 
            "filename": file.filename,
            "status": "pending_ocr"
        }
        
    except Exception as e:
        db.rollback()
        print(f"[Error] Upload Error: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to upload to Postgres: {str(e)}")

# ---------------- ZEUS MCP ROUTER & ENDPOINTS ----------------
zeus_router = APIRouter()

@zeus_router.post("/zeus/history/save")
async def save_history_msg(payload: SaveHistoryRequest):
    save_to_history(payload.session_id, payload.role, payload.content, payload.mode)
    return {"status": "success"}

@zeus_router.post("/auth/register")
async def auth_register(payload: RegisterRequest, db: Session = Depends(get_db)):
    if payload.password != payload.confirmPassword:
        raise HTTPException(status_code=400, detail="Passwords do not match")
    
    existing_user = db.query(UserTable).filter(UserTable.email == payload.email).first()
    if existing_user:
        raise HTTPException(status_code=400, detail="Email already registered")
    
    # Try to create user in Firebase
    from auth.firebase_auth import create_firebase_user
    fb_res = create_firebase_user(payload.email, payload.password)
    if fb_res.get("status") == "error":
        raise HTTPException(status_code=400, detail=f"Firebase Registration failed: {fb_res.get('message')}")
        
    try:
        hashed_pwd = hashlib.sha256(payload.password.encode()).hexdigest()
        new_user = UserTable(email=payload.email, password=hashed_pwd, role="user")
        db.add(new_user)
        db.commit()
        db.refresh(new_user)
        return {"status": "success", "userid": new_user.userid, "email": new_user.email, "role": new_user.role, "firebase_uid": fb_res.get("uid")}
    except Exception as e:
        db.rollback()
        print(f"[Error] Registration failed: {e}")
        raise HTTPException(status_code=500, detail=f"Registration failed: {str(e)}")

@zeus_router.post("/auth/login")
async def auth_login(payload: LoginRequest, db: Session = Depends(get_db)):
    from auth.firebase_auth import verify_firebase_login
    
    # Attempt Firebase authentication
    fb_res = verify_firebase_login(payload.email, payload.password)
    if fb_res.get("status") != "success":
        raise HTTPException(
            status_code=401, 
            detail="Invalid email or password"
        )

    # Ensure the user exists in the local database to get user metadata (userid, role, etc.)
    user = db.query(UserTable).filter(UserTable.email == payload.email).first()
    if not user:
        raise HTTPException(
            status_code=401, 
            detail="Account verified in Firebase, but not registered in local database."
        )
        
    return {
        "status": "success", 
        "userid": user.userid, 
        "email": user.email, 
        "role": user.role,
        "firebase_token": fb_res.get("idToken")
    }

@zeus_router.get("/user/settings")
async def get_user_settings(userid: int, db: Session = Depends(get_db)):
    user = db.query(UserTable).filter(UserTable.userid == userid).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
        
    return {
        "userid": user.userid,
        "google_connected": user.google_connected or 0,
        "email_enabled": user.email_enabled or 0,
        "calendar_enabled": user.calendar_enabled or 0,
        "google_email": user.google_email
    }

@zeus_router.post("/user/settings")
async def update_user_settings(payload: SettingsRequest, db: Session = Depends(get_db)):
    user = db.query(UserTable).filter(UserTable.userid == payload.userid).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
        
    user.google_connected = payload.google_connected
    user.email_enabled = payload.email_enabled
    user.calendar_enabled = payload.calendar_enabled
    
    # If disconnecting, nullify OAuth tokens
    if payload.google_connected == 0:
        user.google_refresh_token = None
        user.google_email = None
        
    db.commit()
    return {"status": "success"}


@zeus_router.get("/admin/token_usage")
async def get_admin_token_usage(db: Session = Depends(get_db)):
    try:
        users = db.query(UserTable).order_by(UserTable.userid.asc()).all()
        return [
            {
                "userid": u.userid,
                "email": u.email,
                "role": u.role,
                "token_usage": u.token_usage if u.token_usage is not None else 0
            }
            for u in users
        ]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@zeus_router.get("/user/token_usage")
async def get_user_token_usage(userid: int, db: Session = Depends(get_db)):
    try:
        user = db.query(UserTable).filter(UserTable.userid == userid).first()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        
        from dbconfig.db import check_and_reset_tokens
        if check_and_reset_tokens(user):
            db.commit()

        import datetime
        import calendar
        now = datetime.datetime.now(datetime.timezone.utc)
        _, last_day = calendar.monthrange(now.year, now.month)
        days_left = last_day - now.day

        usage = user.token_usage if user.token_usage is not None else 0
        limit = 100000
        percentage = min((usage / limit) * 100, 100) if limit > 0 else 0

        return {
            "userid": user.userid,
            "email": user.email,
            "role": user.role,
            "token_usage": usage,
            "limit": limit,
            "percentage": percentage,
            "days_left": days_left
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@zeus_router.get("/zeus/session_documents")
async def get_session_documents(session_id: str, db: Session = Depends(get_db)):
    try:
        records = db.query(FileTable).filter(FileTable.session_id == session_id).order_by(FileTable.file_id.desc()).all()
        return [{
            "file_id": r.file_id,
            "filename": r.filename,
            "mime_type": r.mime_type,
            "status": r.status
        } for r in records]
    except Exception as e:
        raise HTTPException(500, detail=str(e))

@zeus_router.get("/zeus/documents")
async def get_all_documents(userid: Optional[int] = None, db: Session = Depends(get_db)):
    try:
        query = db.query(FileTable)
        if userid is not None:
            query = query.filter(FileTable.userid == userid)
        records = query.order_by(FileTable.file_id.desc()).all()
        return [{
            "file_id": r.file_id,
            "filename": r.filename,
            "mime_type": r.mime_type,
            "status": r.status,
            "session_id": r.session_id,
            "created_at": r.created_at.isoformat() if r.created_at else ""
        } for r in records]
    except Exception as e:
        raise HTTPException(500, detail=str(e))

@zeus_router.delete("/zeus/documents/{file_id}")
async def delete_document(file_id: str, db: Session = Depends(get_db)):
    try:
        record = db.query(FileTable).filter(FileTable.file_id == file_id).first()
        if not record:
            raise HTTPException(404, "Document not found")
        db.delete(record)
        db.commit()
        return {"success": True}
    except Exception as e:
        raise HTTPException(500, detail=str(e))

@zeus_router.get("/zeus/sessions")
async def get_zeus_sessions(userid: int):
    try:
        from dbconfig.db import SessionLocal, ChatSession
        db = SessionLocal()
        sessions = db.query(ChatSession).filter(ChatSession.userid == userid).order_by(ChatSession.updated_at.desc()).all()
        result = [{"id": s.id, "title": s.title, "type": getattr(s, 'type', 'chat'), "updated_at": s.updated_at.isoformat() if s.updated_at else ""} for s in sessions]
        db.close()
        return {"sessions": result}
    except Exception as e:
        print(f"[Error] Error fetching sessions: {e}")
        return {"sessions": []}

@zeus_router.post("/zeus/sessions")
async def create_zeus_session(userid: int = Body(None), payload: dict = Body(None)):
    try:
        from dbconfig.db import SessionLocal, ChatSession
        db = SessionLocal()
        new_id = str(uuid.uuid4())
        session_type = payload.get("type", "chat") if payload else "chat"
        new_session = ChatSession(id=new_id, title="New chat", type=session_type, userid=userid)
        db.add(new_session)
        db.commit()
        db.close()
        return {"id": new_id, "title": "New chat", "type": session_type}
    except Exception as e:
        print(f"[Error] Error creating session: {e}")
        raise HTTPException(status_code=500, detail="Error creating session")

class EmailConfirmPayload(BaseModel):
    to_email: str
    subject: str
    body: str
    userid: int = None

@zeus_router.post("/zeus/send_email_confirm")
async def send_email_confirm(payload: EmailConfirmPayload):
    from function.email import execute_send_email
    try:
        result = await execute_send_email(payload.to_email, payload.subject, payload.body, userid=payload.userid)
        return {"status": "success", "message": result}
    except Exception as e:
        return {"status": "error", "message": str(e)}

class EmailStatusUpdatePayload(BaseModel):
    session_id: str
    to_email: str
    status: str

@zeus_router.post("/zeus/history/update_email_status")
async def update_email_status(payload: EmailStatusUpdatePayload):
    try:
        from dbconfig.db import SessionLocal, ChatHistory
        db = SessionLocal()
        rows = db.query(ChatHistory).filter(
            ChatHistory.session_id == payload.session_id,
            ChatHistory.role == "assistant"
        ).order_by(ChatHistory.timestamp.desc()).all()
        
        updated = False
        import re
        for row in rows:
            if payload.to_email in row.content and "zeus-email-status-chip" in row.content:
                content = row.content
                status_display = "Approved" if payload.status == "approved" else ("Rejected" if payload.status == "rejected" else payload.status.capitalize())
                chip_replace = f"<div class='zeus-email-status-chip {payload.status}' style='display: inline-block;'>{status_display}</div>"
                chip_find = "<div class='zeus-email-status-chip' style='display: none;'></div>"
                if chip_find not in content:
                    chip_find = '<div class="zeus-email-status-chip" style="display: none;"></div>'
                content = content.replace(chip_find, chip_replace)
                
                content = re.sub(
                    r"<div class='zeus-email-draft-buttons'>.*?</div>",
                    "",
                    content,
                    flags=re.DOTALL
                )
                row.content = content
                db.commit()
                updated = True
                break
        db.close()
        return {"status": "success", "updated": updated}
    except Exception as e:
        print(f"[Error] Error updating email status in database: {e}")
        return {"status": "error", "message": str(e)}

@zeus_router.post("/zeus/upload_kb")
async def upload_kb(
    files: List[UploadFile] = File(...),
    session_id: str = Form(None),
    db: Session = Depends(get_db)
):
    try:
        if not session_id:
            raise HTTPException(status_code=400, detail="session_id is required")

        uploaded_records = []
        for file in files:
            file_id = str(uuid.uuid4())
            contents = await file.read()
            
            firebase_url = upload_file_to_firebase(contents, file_id, file.content_type)
            
            new_file = FileTable(
                file_id=file_id,
                filename=file.filename,
                firebase_url=firebase_url,
                mime_type=file.content_type,
                status="pending_ocr",
                session_id=session_id
            )
            db.add(new_file)
            db.commit()
            
            try:
                import asyncio
                loop = asyncio.get_running_loop()
                ocr_result = await loop.run_in_executor(None, process_paddle_ocr, contents)
                new_file.ocr_text = ocr_result.get("raw_text", "")
                new_file.ocr_details = ocr_result.get("ocr_details", [])
                new_file.status = "ocr_completed"
                db.commit()
            except Exception as ocr_err:
                print(f"Error running OCR on uploaded KB file: {ocr_err}")
                
            uploaded_records.append({
                "file_id": file_id,
                "filename": file.filename
            })
            
        if session_id in PROJECT_EMBEDDINGS:
            del PROJECT_EMBEDDINGS[session_id]

        return {"status": "success", "uploaded": uploaded_records}
    except Exception as e:
        db.rollback()
        print(f"Error in upload_kb: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@zeus_router.delete("/zeus/documents/{file_id}")
async def delete_document(file_id: str, db: Session = Depends(get_db)):
    print(f"\n[DELETE] Trying to delete document: '{file_id}'")
    try:
        record = db.query(FileTable).filter(FileTable.file_id == file_id).first()
        #print(f"[DELETE] Query returned: {record}")
        if not record:
            #print(f"[DELETE] Document '{file_id}' not found in database.")
            raise HTTPException(status_code=404, detail=f"File not found: {file_id}")
        
        session_id = record.session_id
        db.delete(record)
        db.commit()
        #print(f"[DELETE] Successfully deleted document '{file_id}' from database.")
        
        if session_id and session_id in PROJECT_EMBEDDINGS:
            del PROJECT_EMBEDDINGS[session_id]
            #print(f"[DELETE] Cleared PROJECT_EMBEDDINGS for session: '{session_id}'")
            
        return {"status": "success", "message": "Document deleted"}
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        print(f"[DELETE] Error occurred during deletion: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@zeus_router.delete("/zeus/sessions/{session_id}")
async def delete_zeus_session(session_id: str):
    try:
        from dbconfig.db import SessionLocal, ChatSession
        db = SessionLocal()
        session = db.query(ChatSession).filter(ChatSession.id == session_id).first()
        if session:
            db.delete(session)
            db.commit()
        db.close()
        return {"status": "ok"}
    except Exception as e:
        print(f"[Error] Error deleting session: {e}")
        return {"status": "error"}

@zeus_router.put("/zeus/sessions/{session_id}")
async def rename_zeus_session(session_id: str, payload: dict = Body(...)):
    try:
        from dbconfig.db import SessionLocal, ChatSession
        db = SessionLocal()
        session = db.query(ChatSession).filter(ChatSession.id == session_id).first()
        if not session:
            db.close()
            raise HTTPException(status_code=404, detail="Session not found")
        new_title = payload.get("title")
        if not new_title:
            db.close()
            raise HTTPException(status_code=400, detail="Title is required")
        session.title = new_title
        db.commit()
        db.close()
        return {"status": "ok", "title": new_title}
    except HTTPException:
        raise
    except Exception as e:
        print(f"[Error] Error renaming session: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@zeus_router.get("/zeus/history")
async def get_zeus_history(session_id: str):
    try:
        from dbconfig.db import SessionLocal, ChatHistory
        db = SessionLocal()
        rows = db.query(ChatHistory).filter(ChatHistory.session_id == session_id).order_by(ChatHistory.timestamp.asc()).all()
        
        history = []
        for row in rows:
            content = row.content
            if content:
                content = content.replace(
                    'style="font-family: Arial, sans-serif; padding: 15px; border-left: 4px solid #007bff; background: #f9f9f9;"',
                    'class="zeus-web-search-box"'
                )
            history.append({
                "role": row.role,
                "content": content,
                "mode": row.mode
            })
        db.close()
        return {"history": history}
    except Exception as e:
        print(f"[Error] Error fetching history: {e}")
        return {"history": []}

from chat.chat import register_zeus_chat_route

register_zeus_chat_route(
    zeus_router,
    ZeusChatRequest,
    normalize_mode=_normalize_mode,
    save_to_history=save_to_history,
    call_apifreellm=call_apifreellm,
    load_prompt=load_prompt,
    execute_web_search=execute_web_search,
    execute_read_document=execute_read_document,
    execute_send_email=execute_send_email,
    insert_calendar_event_directly=insert_calendar_event_directly,
    ensure_project_embeddings=ensure_project_embeddings,
    project_embeddings=PROJECT_EMBEDDINGS,
    get_embedding=get_embedding,
    cosine_similarity=cosine_similarity,
    mode_web_search=MODE_WEB_SEARCH,
    mode_ocr=MODE_OCR,
    mode_calendar=MODE_CALENDAR,
    mode_gmail=MODE_GMAIL,
    mode_smart=MODE_SMART,
)

# ---------------- CONFIGURATION API ROUTER ----------------
config_router = APIRouter(prefix="/api", tags=["Config"])

@config_router.post("/reports/generate")
async def generate_data_report(payload: GenerateDataReportRequest):
    try:
        from workflow.autoTask import execute_db_query, REPORT_CONTEXT_KIND
        from function.fileGenerator import generate_structured_pdf_report

        query_result = await execute_db_query(payload.db_name, payload.prompt, "", structured=True)
        try:
            report_context = json.loads(query_result)
        except Exception:
            raise HTTPException(status_code=400, detail=query_result)

        if report_context.get("kind") != REPORT_CONTEXT_KIND:
            raise HTTPException(status_code=400, detail=query_result)

        pdf_result = generate_structured_pdf_report(
            report_title=report_context.get("report_title", "Generated Database Report"),
            summary_note=report_context.get("summary_note", "Report generated from the selected database."),
            rows=report_context.get("rows", []),
            columns=report_context.get("columns", []),
            chart_config=report_context.get("chart_config", {}),
            sql_query=report_context.get("sql_query", ""),
            filename=payload.filename,
            session_id=payload.session_id,
            userid=payload.userid,
            report_subtitle=f"Database report from {payload.db_name}",
        )
        if not pdf_result.get("success"):
            raise HTTPException(status_code=500, detail=pdf_result.get("error", "Report generation failed"))

        return {
            "status": "success",
            "file_id": pdf_result.get("file_id"),
            "filename": pdf_result.get("filename"),
            "download_link": f"{API_BASE_URL.rstrip('/')}/view-file/{pdf_result.get('file_id')}",
            "row_count": pdf_result.get("row_count", len(report_context.get("rows", []))),
            "columns": pdf_result.get("columns", report_context.get("columns", [])),
            "sql_query": report_context.get("sql_query", ""),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@config_router.get("/db_connections")
async def get_db_connections(db: Session = Depends(get_db)):
    conns = db.query(DbConn).all()
    results = []
    for c in conns:
        host, port = "", ""
        user, password = "", ""
        if c.connection_str:
            import re
            m = re.match(r"^([^:]+)://(?:([^:@]+)(?::([^@]+))?@)?([^:/]+)(?::(\d+))?/(.+)$", c.connection_str)
            if m:
                user = m.group(2) or ""
                password = m.group(3) or ""
                host = m.group(4) or ""
                port = m.group(5) or ""
            else:
                if "@" in c.connection_str:
                    try:
                        auth_part = c.connection_str.split("://")[1].split("@")[0]
                        if ":" in auth_part:
                            user, password = auth_part.split(":", 1)
                        else:
                            user = auth_part
                        
                        host_port = c.connection_str.split("@")[1].split("/")[0]
                        if ":" in host_port:
                            host, port = host_port.split(":")
                        else:
                            host = host_port
                    except:
                        pass
        results.append({
            "id": c.id,
            "name": c.name,
            "database_name": c.database_name,
            "type": c.type,
            "host": host,
            "port": port,
            "user": user,
            "password": password,
            "connection_str": c.connection_str,
            "description": c.description
        })
    return results

def verify_connection(conn_str: str, db_type: str):
    if db_type.lower() == "mongodb":
        return
    from sqlalchemy import create_engine
    try:
        temp_engine = create_engine(conn_str, connect_args={"connect_timeout": 5})
        with temp_engine.connect() as conn:
            pass
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Database connection test failed: {str(e)}")

@config_router.put("/db_connections/{conn_id}")
async def update_db_connection(conn_id: int, payload: DbConnCreate, db: Session = Depends(get_db)):
    c = db.query(DbConn).filter(DbConn.id == conn_id).first()
    if not c:
        raise HTTPException(status_code=404, detail="Connection not found")
    
    conn_str = payload.connection_str
    if not conn_str and payload.host:
        protocol = payload.type
        if payload.type == "postgresql": protocol = "postgresql"
        elif payload.type == "mysql": protocol = "mysql+pymysql"
        elif payload.type == "mssql": protocol = "mssql+pyodbc"
        
        auth = ""
        if payload.user:
            auth = payload.user
            if payload.password:
                auth += f":{payload.password}"
            auth += "@"
        port_str = f":{payload.port}" if payload.port else ""
        conn_str = f"{protocol}://{auth}{payload.host}{port_str}/{payload.database_name}"
        if payload.ssl_mode and payload.type == "postgresql":
            conn_str += "?sslmode=require"

    # Validate before saving
    verify_connection(conn_str, payload.type)

    c.name = payload.name
    c.database_name = payload.database_name
    c.connection_str = conn_str
    c.type = payload.type
    c.description = payload.description
    
    db.commit()
    return {"status": "success", "id": c.id}

@config_router.post("/db_connections")
async def create_db_connection(payload: DbConnCreate, db: Session = Depends(get_db)):
    # Build connection string if not provided
    conn_str = payload.connection_str
    if not conn_str and payload.host:
        # naive builder
        protocol = payload.type
        if payload.type == "postgresql": protocol = "postgresql"
        elif payload.type == "mysql": protocol = "mysql+pymysql"
        elif payload.type == "mssql": protocol = "mssql+pyodbc"
        
        auth = ""
        if payload.user:
            auth = payload.user
            if payload.password:
                auth += f":{payload.password}"
            auth += "@"
        port_str = f":{payload.port}" if payload.port else ""
        conn_str = f"{protocol}://{auth}{payload.host}{port_str}/{payload.database_name}"
        if payload.ssl_mode and payload.type == "postgresql":
            conn_str += "?sslmode=require"
    
    # Validate before saving
    verify_connection(conn_str, payload.type)

    new_conn = DbConn(
        name=payload.name,
        database_name=payload.database_name,
        connection_str=conn_str,
        type=payload.type,
        description=payload.description
    )
    db.add(new_conn)
    db.commit()
    db.refresh(new_conn)
    return {"status": "success", "id": new_conn.id}

@config_router.delete("/db_connections/{conn_id}")
async def delete_db_connection(conn_id: int, db: Session = Depends(get_db)):
    c = db.query(DbConn).filter(DbConn.id == conn_id).first()
    if c:
        db.delete(c)
        db.commit()
    return {"status": "success"}

@config_router.post("/db_connections/test")
async def test_db_connection(payload: dict):
    try:
        conn_str = payload.get("connection_str")
        if not conn_str and payload.get("host"):
            protocol = payload.get("type", "")
            if protocol == "postgresql": protocol = "postgresql"
            elif protocol == "mysql": protocol = "mysql+pymysql"
            elif protocol == "mssql": protocol = "mssql+pyodbc"
            
            auth = ""
            if payload.get("user"):
                auth = payload.get("user")
                if payload.get("password"):
                    auth += f":{payload.get('password')}"
                auth += "@"
            port_str = f":{payload.get('port')}" if payload.get("port") else ""
            conn_str = f"{protocol}://{auth}{payload.get('host')}{port_str}/{payload.get('database_name', '')}"
            if payload.get("ssl_mode") and payload.get("type") == "postgresql":
                conn_str += "?sslmode=require"
        
        if not conn_str:
            raise Exception("Invalid connection details provided.")
            
        from sqlalchemy import create_engine
        temp_engine = create_engine(conn_str, connect_args={"connect_timeout": 5})
        with temp_engine.connect() as conn:
            pass
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@config_router.post("/db_connections/generate_description")
async def generate_description(payload: dict):
    try:
        conn_str = payload.get("connection_str")
        if not conn_str and payload.get("host"):
            protocol = payload.get("type", "")
            if protocol == "postgresql": protocol = "postgresql"
            elif protocol == "mysql": protocol = "mysql+pymysql"
            elif protocol == "mssql": protocol = "mssql+pyodbc"
            
            auth = ""
            if payload.get("user"):
                auth = payload.get("user")
                if payload.get("password"):
                    auth += f":{payload.get('password')}"
                auth += "@"
            port_str = f":{payload.get('port')}" if payload.get('port') else ""
            conn_str = f"{protocol}://{auth}{payload.get('host')}{port_str}/{payload.get('database_name', '')}"
        
        if not conn_str:
            raise Exception("Invalid connection details provided.")
            
        from sqlalchemy import create_engine, inspect, text
        temp_engine = create_engine(conn_str, connect_args={"connect_timeout": 5})
        
        schema_info = []
        schema_info.append(f"Database Name: {payload.get('database_name', '')}")
        schema_info.append(f"Database Type: {payload.get('type', '')}")
        schema_info.append("---")
        
        with temp_engine.connect() as conn:
            inspector = inspect(temp_engine)
            tables = inspector.get_table_names()
            
            for table in tables[:10]: 
                schema_info.append(f"Table: {table}")
                columns = inspector.get_columns(table)
                pk = inspector.get_pk_constraint(table)
                fks = inspector.get_foreign_keys(table)
                
                col_strs = []
                for c in columns:
                    pk_marker = " (PK)" if pk and c['name'] in pk.get('constrained_columns', []) else ""
                    null_marker = " NOT NULL" if not c.get('nullable', True) else ""
                    col_strs.append(f"  - {c['name']}: {c['type']}{pk_marker}{null_marker}")
                schema_info.append("Columns:")
                schema_info.extend(col_strs)
                
                if fks:
                    schema_info.append("Foreign Keys:")
                    for fk in fks:
                        schema_info.append(f"  - {fk['constrained_columns']} -> {fk['referred_table']}.{fk['referred_columns']}")
                        
                try:
                    result = conn.execute(text(f"SELECT * FROM {table} LIMIT 3"))
                    rows = result.fetchall()
                    if rows:
                        schema_info.append("Sample Rows:")
                        for row in rows:
                            row_str = str(row)
                            if len(row_str) > 200: row_str = row_str[:200] + "..."
                            schema_info.append(f"  - {row_str}")
                except Exception as ex:
                    schema_info.append(f"  - (Could not fetch sample data: {ex})")
                
                schema_info.append("---")
                
        schema_text = "\n".join(schema_info)
        
        prompt_template = load_prompt("dbInstructions.md")
        if not prompt_template:
            raise Exception("Prompt template 'dbInstructions.md' not found.")
            
        final_prompt = prompt_template + "\n\nInput Data:\n" + schema_text
        
        llm_response = await call_apifreellm(final_prompt)
        
        if "[Warning] Sorry" in llm_response:
            raise Exception("Failed to generate with LLM.")
            
        return {"description": llm_response.strip()}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@config_router.get("/api_connections")
async def get_api_connections(db: Session = Depends(get_db)):
    conns = db.query(ApiConn).all()
    results = []
    for c in conns:
        results.append({
            "id": c.id,
            "apiName": c.name,
            "url": c.api_url,
            "method": c.method,
            "apiKeyVal": c.api_key,
            "params": c.parameter,
            "desc": c.description
        })
    return results

@config_router.post("/api_connections")
async def create_api_connection(payload: ApiConnCreate, db: Session = Depends(get_db)):
    new_conn = ApiConn(
        name=payload.name,
        api_url=payload.api_url,
        description=payload.description,
        parameter=payload.parameter,
        method=payload.method,
        api_key=payload.api_key
    )
    db.add(new_conn)
    db.commit()
    db.refresh(new_conn)
    return {"status": "success", "id": new_conn.id}

@config_router.put("/api_connections/{conn_id}")
async def update_api_connection(conn_id: int, payload: ApiConnCreate, db: Session = Depends(get_db)):
    c = db.query(ApiConn).filter(ApiConn.id == conn_id).first()
    if not c:
        raise HTTPException(status_code=404, detail="API connection not found")
    c.name = payload.name
    c.api_url = payload.api_url
    c.description = payload.description
    c.parameter = payload.parameter
    c.method = payload.method
    c.api_key = payload.api_key
    db.commit()
    return {"status": "success", "id": c.id}

@config_router.delete("/api_connections/{conn_id}")
async def delete_api_connection(conn_id: int, db: Session = Depends(get_db)):
    c = db.query(ApiConn).filter(ApiConn.id == conn_id).first()
    if c:
        db.delete(c)
        db.commit()
    return {"status": "success"}

class UacPermissionSetPayload(BaseModel):
    connection_type: str  # 'db' or 'api'
    connection_id: int
    userid: int
    allowed: bool

@config_router.get("/uac/permissions")
async def get_uac_permissions(db: Session = Depends(get_db)):
    perms = db.query(UserConnectionPermission).all()
    result = {"db": {}, "api": {}}
    for p in perms:
        t = p.connection_type
        conn_id = str(p.connection_id)
        userid = str(p.userid)
        if t not in result:
            result[t] = {}
        if conn_id not in result[t]:
            result[t][conn_id] = {}
        result[t][conn_id][userid] = bool(p.allowed)
    return result

@config_router.post("/uac/permissions")
async def set_uac_permission(payload: UacPermissionSetPayload, db: Session = Depends(get_db)):
    perm = db.query(UserConnectionPermission).filter(
        UserConnectionPermission.connection_type == payload.connection_type,
        UserConnectionPermission.connection_id == payload.connection_id,
        UserConnectionPermission.userid == payload.userid
    ).first()
    
    val = 1 if payload.allowed else 0
    if perm:
        perm.allowed = val
    else:
        perm = UserConnectionPermission(
            connection_type=payload.connection_type,
            connection_id=payload.connection_id,
            userid=payload.userid,
            allowed=val
        )
        db.add(perm)
    db.commit()
    return {"status": "success"}

from workflow.autoTask import execute_workflow

workflow_router = APIRouter(prefix="/api/workflow", tags=["Workflow"])

class ScheduleSyncRequest(BaseModel):
    workflow_id: str
    cron_expression: str
    payload_data: dict
    is_active: int

class SaveWorkflowRequest(BaseModel):
    id: str
    name: str
    description: Optional[str] = ""
    nodes: list
    connections: list
    status: str
    userid: int
    scheduleFrequency: Optional[str] = None
    scheduleTime: Optional[str] = None
    scheduleDay: Optional[str] = None

class DeleteWorkflowRequest(BaseModel):
    id: str
    userid: int

@workflow_router.post("/save")
async def save_workflow(payload: SaveWorkflowRequest, db: Session = Depends(get_db)):
    try:
        from dbconfig.db import WorkflowTask, UserTable
        user = db.query(UserTable).filter(UserTable.userid == payload.userid).first()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        
        existing = db.query(WorkflowTask).filter(WorkflowTask.id == payload.id).first()
        if existing:
            if existing.userid != payload.userid:
                raise HTTPException(status_code=403, detail="Not authorized to edit this workflow")
            existing.name = payload.name
            existing.description = payload.description
            existing.nodes = payload.nodes
            existing.connections = payload.connections
            existing.status = payload.status
            existing.schedule_frequency = payload.scheduleFrequency
            existing.schedule_time = payload.scheduleTime
            existing.schedule_day = payload.scheduleDay
        else:
            new_workflow = WorkflowTask(
                id=payload.id,
                name=payload.name,
                description=payload.description,
                nodes=payload.nodes,
                connections=payload.connections,
                status=payload.status,
                schedule_frequency=payload.scheduleFrequency,
                schedule_time=payload.scheduleTime,
                schedule_day=payload.scheduleDay,
                userid=payload.userid
            )
            db.add(new_workflow)
        db.commit()
        return {"status": "success"}
    except HTTPException as he:
        raise he
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

@workflow_router.get("/list")
async def list_workflows(userid: int, db: Session = Depends(get_db)):
    try:
        from dbconfig.db import WorkflowTask
        tasks = db.query(WorkflowTask).filter(WorkflowTask.userid == userid).order_by(WorkflowTask.updated_at.desc()).all()
        return [
            {
                "id": t.id,
                "name": t.name,
                "description": t.description,
                "nodes": t.nodes,
                "connections": t.connections,
                "status": t.status,
                "createdAt": t.created_at.isoformat() if t.created_at else None,
                "updatedAt": t.updated_at.isoformat() if t.updated_at else None,
                "scheduleFrequency": t.schedule_frequency,
                "scheduleTime": t.schedule_time,
                "scheduleDay": t.schedule_day,
            }
            for t in tasks
        ]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@workflow_router.post("/delete")
async def delete_workflow(payload: DeleteWorkflowRequest, db: Session = Depends(get_db)):
    try:
        from dbconfig.db import WorkflowTask, ScheduledTask
        workflow = db.query(WorkflowTask).filter(WorkflowTask.id == payload.id).first()
        if not workflow:
            raise HTTPException(status_code=404, detail="Workflow not found")
        if workflow.userid != payload.userid:
            raise HTTPException(status_code=403, detail="Not authorized to delete this workflow")
            
        db.query(ScheduledTask).filter(ScheduledTask.workflow_id == payload.id).delete()
        db.delete(workflow)
        db.commit()
        return {"status": "success"}
    except HTTPException as he:
        raise he
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

@workflow_router.post("/schedule")
async def api_sync_schedule(payload: ScheduleSyncRequest, db: Session = Depends(get_db)):
    try:
        from dbconfig.db import ScheduledTask, WorkflowTask
        
        # Verify workflow ownership if it exists
        workflow = db.query(WorkflowTask).filter(WorkflowTask.id == payload.workflow_id).first()
        userid = payload.payload_data.get("userid") or (workflow.userid if workflow else None)
        
        if workflow and userid and workflow.userid != userid:
            raise HTTPException(status_code=403, detail="Not authorized to schedule this workflow")
            
        existing = db.query(ScheduledTask).filter(ScheduledTask.workflow_id == payload.workflow_id).first()
        if existing:
            existing.cron_expression = payload.cron_expression
            existing.payload_data = payload.payload_data
            existing.is_active = payload.is_active
            if userid:
                existing.userid = userid
        else:
            new_schedule = ScheduledTask(
                workflow_id=payload.workflow_id,
                cron_expression=payload.cron_expression,
                payload_data=payload.payload_data,
                is_active=payload.is_active,
                userid=userid
            )
            db.add(new_schedule)
        db.commit()
        return {"status": "success"}
    except HTTPException as he:
        raise he
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

async def execute_and_log(payload: dict):
    workflow_id = payload.get('workflow_id', 'manual')
    workflow_name = payload.get('workflow_name', 'Manual Execution')
    userid = payload.get('userid')
    status = "success"
    error_msg = ""
    
    try:
        from workflow.autoTask import execute_workflow
        import json
        async for event in execute_workflow(payload):
            try:
                ev_data = json.loads(event.strip())
                if ev_data.get("type") == "error":
                    status = "failed"
                    error_msg = ev_data.get("message", "Unknown error")
            except Exception:
                pass
            yield event
    except Exception as e:
        status = "failed"
        error_msg = str(e)
        import json
        yield json.dumps({"type": "error", "message": str(e)}) + "\n"
        
    if userid:
        try:
            from dbconfig.db import SessionLocal, TaskNotification, TrackError
            db = SessionLocal()
            notification = TaskNotification(
                userid=userid,
                workflow_id=workflow_id,
                workflow_name=workflow_name,
                status=status,
                error_message=error_msg
            )
            db.add(notification)
            if status == "failed":
                new_error = TrackError(
                    userid=userid,
                    error_type="workflow_execution",
                    error_message=error_msg,
                    error_details=f"Workflow {workflow_id} ({workflow_name}) failed"
                )
                db.add(new_error)
            db.commit()
            db.close()
        except Exception as log_err:
            print(f"Failed to log notification/error: {log_err}")

@workflow_router.post("/execute")
async def api_execute_workflow(payload: dict):
    return StreamingResponse(execute_and_log(payload), media_type="text/event-stream")

@workflow_router.post("/validate")
async def api_validate_workflow(payload: dict):
    nodes = {n["id"]: n for n in payload.get("nodes", [])}
    start_nodes = [n for n in nodes.values() if n["type"] == "start"]
    if not start_nodes:
        return {"status": "error", "message": "Workflow must have a Start node."}
    end_nodes = [n for n in nodes.values() if n["type"] == "end"]
    if not end_nodes:
        return {"status": "error", "message": "Workflow must have an End node."}
    return {"status": "success", "message": "Workflow is valid."}

@zeus_router.get("/api/notifications")
async def get_notifications(userid: int, db: Session = Depends(get_db)):
    try:
        from dbconfig.db import TaskNotification
        notifs = db.query(TaskNotification).filter(TaskNotification.userid == userid).order_by(TaskNotification.created_at.desc()).all()
        result = []
        for n in notifs:
            result.append({
                "id": n.id,
                "workflow_id": n.workflow_id,
                "workflow_name": n.workflow_name,
                "status": n.status,
                "error_message": n.error_message,
                "created_at": n.created_at.isoformat() if n.created_at else None,
                "is_read": n.is_read
            })
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@zeus_router.put("/api/notifications/read")
async def mark_notifications_read(payload: dict, db: Session = Depends(get_db)):
    userid = payload.get("userid")
    if not userid:
        raise HTTPException(status_code=400, detail="Missing userid")
    try:
        from dbconfig.db import TaskNotification
        db.query(TaskNotification).filter(
            TaskNotification.userid == userid, 
            TaskNotification.is_read == 0
        ).update({"is_read": 1})
        db.commit()
        return {"status": "success"}
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

# Cron scheduler logic refactored to py_script/workflow/scheduler.py

from auth.googleAuth import google_auth_router

app.include_router(config_router)
app.include_router(zeus_router)
app.include_router(google_auth_router)
app.include_router(workflow_router)

# Startup events migrated to FastAPI lifespan context manager

if __name__ == "__main__":
    import uvicorn
    import os
    if sys.platform == 'win32':
        asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
        
    port = int(os.getenv("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)
