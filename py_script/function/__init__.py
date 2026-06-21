from .calendar import insert_calendar_event_directly
from .email import execute_send_email
from .web_search import execute_web_search
from .docExtract import process_paddle_ocr
from .api_client import ZeusAPIClient
from .rag_embedding import (
    get_embedding,
    cosine_similarity,
    chunk_text,
    ensure_project_embeddings,
    PROJECT_EMBEDDINGS,
)
