import os
import asyncio
import httpx
import numpy as np
from typing import List, Dict, Any
from sqlalchemy.orm import Session
from dbconfig.db import FileTable
from .docExtract import process_paddle_ocr

PROJECT_EMBEDDINGS: Dict[str, List[Dict[str, Any]]] = {}

async def get_embedding(text: str) -> List[float]:
    from .api_client import ZeusAPIClient
    return await ZeusAPIClient.get_instance().get_embedding(text)

def cosine_similarity(v1: List[float], v2: List[float]) -> float:
    if not v1 or not v2 or len(v1) != len(v2):
        return 0.0
    arr1 = np.array(v1)
    arr2 = np.array(v2)
    dot_product = np.dot(arr1, arr2)
    norm1 = np.linalg.norm(arr1)
    norm2 = np.linalg.norm(arr2)
    if norm1 == 0 or norm2 == 0:
        return 0.0
    return float(dot_product / (norm1 * norm2))

def chunk_text(text: str, chunk_size: int = 600, overlap: int = 150) -> List[str]:
    chunks = []
    if not text:
        return chunks
    words = text.split()
    current_chunk = []
    current_length = 0
    for word in words:
        current_chunk.append(word)
        current_length += len(word) + 1 # +1 for space
        if current_length >= chunk_size:
            chunks.append(" ".join(current_chunk))
            # Overlap: keep the last 15 words
            overlap_words = current_chunk[-15:] if len(current_chunk) > 15 else current_chunk[-5:]
            current_chunk = list(overlap_words)
            current_length = sum(len(w) + 1 for w in current_chunk)
    if current_chunk:
        chunks.append(" ".join(current_chunk))
    return chunks

async def ensure_project_embeddings(session_id: str, db: Session):
    if session_id in PROJECT_EMBEDDINGS and PROJECT_EMBEDDINGS[session_id]:
        return

    project_files = db.query(FileTable).filter(FileTable.session_id == session_id).all()
    if not project_files:
        return

    chunks_with_embeddings = []
    for pf in project_files:
        text = pf.ocr_text
        if not text and pf.file_data:
            try:
                filename = pf.filename or ""
                mime_type = pf.mime_type or ""
                is_text_file = False
                if mime_type.startswith("text/") or filename.lower().endswith(('.txt', '.csv', '.json', '.md', '.xml', '.yaml', '.yml')):
                    is_text_file = True
                
                if is_text_file:
                    text = pf.file_data.decode("utf-8", errors="ignore")
                    pf.ocr_details = [{"res": {"rec_texts": [text], "dt_polys": []}}]
                else:
                    ocr_result = process_paddle_ocr(pf.file_data)
                    text = ocr_result.get("raw_text", "")
                    pf.ocr_details = ocr_result.get("ocr_details", [])
                
                pf.ocr_text = text
                pf.status = "ocr_completed"
                db.commit()
            except Exception as e:
                print(f"Error extracting text for {pf.filename}: {e}")
                continue

        if not text:
            continue

        chunks = chunk_text(text)
        print(f"[RAG] Document '{pf.filename}' split into {len(chunks)} chunks.")

        for idx, chunk in enumerate(chunks):
            embedding = await get_embedding(chunk)
            if embedding:
                chunks_with_embeddings.append({
                    "text": f"[{pf.filename}]: {chunk}",
                    "embedding": embedding
                })
            await asyncio.sleep(0.1)

    if chunks_with_embeddings:
        PROJECT_EMBEDDINGS[session_id] = chunks_with_embeddings
        print(f"[RAG] Cached {len(chunks_with_embeddings)} chunk embeddings for session {session_id}.")
