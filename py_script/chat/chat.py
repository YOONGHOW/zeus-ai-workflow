import sys
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='backslashreplace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='backslashreplace')
import json
import re
import traceback
import httpx
from fastapi import HTTPException
from memory.memory import get_chat_history_context
from fastapi.responses import StreamingResponse


def register_zeus_chat_route(
    zeus_router,
    ZeusChatRequest,
    *,
    normalize_mode,
    save_to_history,
    call_apifreellm,
    load_prompt,
    execute_web_search,
    execute_read_document,
    execute_send_email,
    insert_calendar_event_directly,
    ensure_project_embeddings,
    project_embeddings,
    get_embedding,
    cosine_similarity,
    mode_web_search,
    mode_ocr,
    mode_calendar,
    mode_gmail,
    mode_smart,
):
    @zeus_router.post("/zeus/chat")
    async def handle_zeus_chat(payload: ZeusChatRequest):
        mode = payload.mode
        try:
            raw_mode = payload.mode
            user_msg = payload.message
            file_ids = payload.file_ids

            # Get userid from session for token tracking
            userid = None
            user_role = None
            user_tokens = 0
            try:
                from dbconfig.db import SessionLocal, ChatSession, UserTable, check_and_reset_tokens
                db = SessionLocal()
                session = db.query(ChatSession).filter(ChatSession.id == payload.session_id).first()
                if session:
                    userid = session.userid
                    user = db.query(UserTable).filter(UserTable.userid == userid).first()
                    if user:
                        if check_and_reset_tokens(user):
                            db.commit()
                        user_role = user.role
                        user_tokens = user.token_usage if user.token_usage is not None else 0
                db.close()
            except Exception as e:
                print(f"Error fetching userid for token tracking: {e}")

            if user_role == "user" and user_tokens >= 100000:
                # Need to return an error generator or simple response if limit reached
                async def error_generator():
                    yield "```json\n"
                    yield json.dumps({
                        "error": "Monthly token limit reached. You have exceeded your 300,000 token allowance for this month."
                    }) + "\n```"
                return StreamingResponse(error_generator(), media_type="text/event-stream")

            # Local wrapper to call LLM and record tokens
            async def call_apifreellm_tracked(prompt_str: str) -> str:
                token_holder = {}
                ans = await call_apifreellm(prompt_str, token_holder)
                total_tokens = token_holder.get("total_tokens", 0)
                if total_tokens > 0 and userid:
                    try:
                        from dbconfig.db import add_user_tokens
                        add_user_tokens(userid, total_tokens)
                        print(f"[Tokens] Added {total_tokens} tokens for userid {userid}")
                    except Exception as token_err:
                        print(f"Error saving tokens: {token_err}")
                return ans

            # Normalize mode by stripping emojis so "ðŸŒ Web Search" matches "Web Search"
            mode = normalize_mode(raw_mode)

            print(f"Zeus received message in mode: {raw_mode} -> normalized: {mode}")

            # Save user message to history
            save_to_history(payload.session_id, "user", user_msg, mode)

            # Update session title if it is a new chat
            try:
                from dbconfig.db import SessionLocal, ChatSession
                db = SessionLocal()
                session = db.query(ChatSession).filter(ChatSession.id == payload.session_id).first()
                if session and session.title == "New chat":
                    # Create a concise title from the user's first message
                    clean_msg = re.sub(r'<[^>]*>', '', user_msg).strip()
                    if not clean_msg:
                        new_title = "Image Chat"
                    else:
                        new_title = clean_msg
                        if len(new_title) > 30:
                            new_title = new_title[:27] + "..."
                    session.title = new_title
                    db.commit()
                db.close()
            except Exception as e:
                print(f"Error updating session title: {e}")

            # Removed dbAgent routing so smart agent can use the selected DB + tools together

            if mode == mode_web_search:
                summary_html = await execute_web_search(user_msg)
                result = {
                    "answer": (
                        "<div class=\"zeus-web-search-box\">"
                        f"{summary_html}"
                        "</div>"
                    ),
                    "tool_used": mode_web_search,
                }
                save_to_history(payload.session_id, "assistant", result["answer"], mode)
                return result

            if mode == mode_ocr:
                if not file_ids:
                    result = {
                        "answer": "Please attach a document first using the paperclip icon so I can read it.",
                        "tool_used": None,
                    }
                    save_to_history(payload.session_id, "assistant", result["answer"], mode)
                    return result

                ocr_data_str = await execute_read_document(file_ids[0])
                try:
                    ocr_data = json.loads(ocr_data_str)
                    extracted_fields = ocr_data.get("extracted_data", {})
                    # Flatten to key: value format
                    flat_data = {k: v.get("value") if isinstance(v, dict) else str(v) for k, v in extracted_fields.items()}
                    
                    # Convert to JSON string
                    json_str = json.dumps(flat_data, indent=2)
                    answer = f"I have successfully scanned the document. Here is the extracted data:\n\n```json\n{json_str}\n```"
                except Exception as e:
                    print(f"Error parsing ocr_data: {e}")
                    answer = f"I have successfully scanned the document. Here is the raw response:\n\n```json\n{ocr_data_str}\n```"

                try:
                    from dbconfig.db import SessionLocal, FileTable
                    db_s = SessionLocal()
                    pf = db_s.query(FileTable).filter(FileTable.file_id == file_ids[0]).first()
                    doc_filename = pf.filename if pf else "Document"
                    doc_mime = pf.mime_type if pf else "application/pdf"
                    db_s.close()
                except Exception:
                    doc_filename, doc_mime = "Document", "application/pdf"
                
                btn_html = f"<br><br><button class='zeus-view-highlights-btn' data-file-id='{file_ids[0]}' data-filename='{doc_filename}' data-mime='{doc_mime}' style='background:linear-gradient(135deg, #3b82f6, #4f46e5); color:white; border:none; padding:8px 16px; border-radius:6px; cursor:pointer; font-weight:500; font-family:Inter, sans-serif; box-shadow:0 2px 8px rgba(59, 130, 246, 0.3); transition:all 0.2s;'><i class='fas fa-file-search' style='margin-right:6px;'></i> View Document Highlights</button>"
                answer += btn_html

                result = {
                    "answer": answer,
                    "tool_used": "OCR Extract",
                }
                save_to_history(payload.session_id, "assistant", result["answer"], mode)
                return result

            # Actual API Execution for Basic Chat
            if payload.api_conn_id:
                from dbconfig.db import SessionLocal, ApiConn
                db = SessionLocal()
                api_conn = db.query(ApiConn).filter(ApiConn.id == payload.api_conn_id).first()
                if api_conn:
                    try:
                        # 1. Ask LLM to resolve URL template and parameters
                        resolver_prompt = (
                            "You are an API parameter resolver.\n"
                            "Given the following API details and the user request, determine the exact URL and request payload (JSON params/body) to use.\n\n"
                            "API Details:\n"
                            f"- Name: {api_conn.name}\n"
                            f"- Method: {api_conn.method}\n"
                            f"- Configured URL: {api_conn.api_url}\n"
                            f"- Configured Parameter template: {api_conn.parameter or ''}\n"
                            f"- Description: {api_conn.description or ''}\n\n"
                            f"User Request: {user_msg}\n\n"
                            "Rule:\n"
                            "- Replace any path parameters like {id} or {userId} in the URL with the actual values mentioned by the user.\n"
                            "- Resolve any query params or body parameters.\n"
                            "- Respond ONLY with a valid raw JSON object matching the format below. No markdown formatting, no code blocks, no other text.\n\n"
                            "Format:\n"
                            "{\n"
                            '  "url": "resolved URL string",\n'
                            '  "params": { ... key-value pairs ... }\n'
                            "}"
                        )
                        llm_response = await call_apifreellm_tracked(resolver_prompt)

                        # Clean up markdown code blocks if present
                        match = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', llm_response, re.DOTALL)
                        if match:
                            json_str = match.group(1)
                        else:
                            start_idx = llm_response.find('{')
                            end_idx = llm_response.rfind('}')
                            if start_idx != -1 and end_idx != -1:
                                json_str = llm_response[start_idx:end_idx+1]
                            else:
                                json_str = llm_response.strip()

                        resolved_req = json.loads(json_str)
                        target_url = resolved_req.get("url", api_conn.api_url)
                        req_params = resolved_req.get("params", {})

                        # 2. Make the HTTP call
                        headers = {}
                        if api_conn.api_key:
                            if api_conn.api_key.lower().startswith("bearer "):
                                headers["Authorization"] = api_conn.api_key
                            else:
                                headers["Authorization"] = f"Bearer {api_conn.api_key}"
                                headers["x-api-key"] = api_conn.api_key

                        async with httpx.AsyncClient(timeout=15.0, verify=False) as client:
                            method = (api_conn.method or "GET").upper()
                            if method == "GET":
                                res = await client.get(target_url, params=req_params, headers=headers)
                            elif method == "POST":
                                res = await client.post(target_url, json=req_params, headers=headers)
                            elif method == "PUT":
                                res = await client.put(target_url, json=req_params, headers=headers)
                            elif method == "DELETE":
                                res = await client.delete(target_url, params=req_params, headers=headers)
                            else:
                                res = await client.request(method, target_url, json=req_params, headers=headers)

                        res_status = res.status_code
                        try:
                            res_data = res.json()
                            res_text = json.dumps(res_data, indent=2)
                        except Exception:
                            res_text = res.text

                        # 3. Format the final response to the user
                        api_prompt_template = load_prompt("APiprompt.md")
                        if not api_prompt_template:
                            api_prompt_template = "You are a concise API response formatter. Turn structured API data into a helpful human answer. Never return raw JSON."

                        synthesis_prompt = f"""{api_prompt_template}
 
User Request: {user_msg}
API Called: {target_url} ({api_conn.method})
HTTP Status Code: {res_status}
API Response Data:
{res_text}
"""
                        final_answer = await call_apifreellm_tracked(synthesis_prompt)
                        save_to_history(payload.session_id, "assistant", final_answer, mode)
                        db.close()
                        return {
                            "answer": final_answer,
                            "tool_used": f"REST API ({api_conn.name})"
                        }
                    except Exception as api_exc:
                        traceback.print_exc()
                        print(f"Error calling selected API: {api_exc}")
                        err_msg = f"[Warning] I encountered an error executing the selected API connection ({api_conn.name}): {str(api_exc)}"
                        save_to_history(payload.session_id, "assistant", err_msg, mode)
                        db.close()
                        return {
                            "answer": err_msg,
                            "tool_used": f"REST API ({api_conn.name})"
                        }
                db.close()

            # Project Chat Strict Mode Logic
            try:
                from dbconfig.db import SessionLocal, ChatSession, FileTable
                db = SessionLocal()
                session = db.query(ChatSession).filter(ChatSession.id == payload.session_id).first()
                is_project = session and session.type == "project"

                if is_project:
                    # 1. Ensure project embeddings are generated and cached in memory
                    await ensure_project_embeddings(payload.session_id, db)

                    # Retrieve from memory cache
                    cached_chunks = project_embeddings.get(payload.session_id, [])

                    context_text = ""
                    if cached_chunks:
                        # 2. Get query embedding
                        query_emb = await get_embedding(user_msg)
                        if query_emb:
                            # 3. Calculate similarities
                            scored_chunks = []
                            for chunk in cached_chunks:
                                sim = cosine_similarity(query_emb, chunk["embedding"])
                                scored_chunks.append((sim, chunk["text"]))

                            # Sort by similarity descending
                            scored_chunks.sort(key=lambda x: x[0], reverse=True)

                            # Take top 5 relevant chunks
                            top_chunks = scored_chunks[:5]

                            # Print debug info
                            print(f"[RAG] Retrieved top chunks for query: '{user_msg}'")
                            for idx, (sim, text) in enumerate(top_chunks):
                                print(f"  {idx+1}. Similarity: {sim:.4f} | Text: {text[:60]}...")

                            # Build context (using a reasonable similarity threshold)
                            context_text = "\n\n".join(text for sim, text in top_chunks if sim > 0.3)
                            if not context_text.strip() and top_chunks:
                                # Fallback to top 2 chunks if below threshold but exists
                                context_text = "\n\n".join(text for sim, text in top_chunks[:2])

                    # Fallback to full document text if embedding search yielded nothing
                    if not context_text.strip():
                        project_files = db.query(FileTable).filter(FileTable.session_id == payload.session_id).all()
                        for pf in project_files:
                            if pf.ocr_text:
                                context_text += f"\n\n--- Document: {pf.filename} ---\n{pf.ocr_text}"

                    if not context_text.strip():
                        result = {
                            "answer": "This project has no uploaded documents yet. Please upload documents so I can base my answers on them.",
                            "tool_used": "Project Knowledge Base"
                        }
                        save_to_history(payload.session_id, "assistant", result["answer"], mode)
                        db.close()
                        return result

                    history_text = get_chat_history_context(payload.session_id, limit=8)
                    history_block = f"Conversation History:\n{history_text}\n" if history_text else ""

                    prompt = f"You are a strictly constrained project assistant. Answer the user's question ONLY based on the following context retrieved from the uploaded documents. If the answer is not in the context, say you cannot answer based on the provided documents.\n\nContext:\n{context_text}\n\n{history_block}User Question: {user_msg}"
                    rag_answer = await call_apifreellm_tracked(prompt)

                    save_to_history(payload.session_id, "assistant", rag_answer, mode)
                    db.close()
                    return {"answer": rag_answer, "tool_used": "Project Knowledge Base (Semantic Search)"}

                db.close()
            except Exception as e:
                print(f"Error handling project chat: {e}")

            if mode == mode_calendar:
                is_allowed = False
                try:
                    from dbconfig.db import SessionLocal, UserTable
                    db_check = SessionLocal()
                    user_check = db_check.query(UserTable).filter(UserTable.userid == userid).first() if userid else None
                    if user_check and user_check.google_connected and user_check.calendar_enabled:
                        is_allowed = True
                    db_check.close()
                except Exception:
                    pass
                
                if not is_allowed:
                    return {
                        "answer": "Google Calendar integration is disabled. Please connect your Google Account and enable Calendar Integration in the Settings page.",
                        "tool_used": "Google Calendar"
                    }

                import datetime
                import urllib.parse
                now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

                history_text = get_chat_history_context(payload.session_id, limit=8)
                history_block = f"Conversation History:\n{history_text}\n" if history_text else ""

                prompt_template = load_prompt("calendar_prompt.md")
                prompt = prompt_template.replace("{now_str}", now_str).replace("{user_msg}", f"{history_block}User message: {user_msg}")

                llm_response = await call_apifreellm_tracked(prompt)

                # If the LLM returned our masked error string, don't try to parse it
                if llm_response.startswith("[Warning]"):
                    return {
                        "answer": llm_response,
                        "tool_used": "Google Calendar"
                    }

                json_str = llm_response

                # Clean up potential markdown blocks
                match = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', llm_response, re.DOTALL)
                if match:
                    json_str = match.group(1)
                else:
                    # If no markdown block, try to find the first { and last }
                    start_idx = llm_response.find('{')
                    end_idx = llm_response.rfind('}')
                    if start_idx != -1 and end_idx != -1:
                        json_str = llm_response[start_idx:end_idx+1]

                try:
                    event_data = json.loads(json_str)
                    title = event_data.get("title", "New Event")
                    start = event_data.get("start_time", "")
                    end = event_data.get("end_time", "")
                    details = event_data.get("details", "")
                    location = event_data.get("location", "")

                    # Format URL
                    url = f"https://calendar.google.com/calendar/render?action=TEMPLATE"
                    if title: url += f"&text={urllib.parse.quote(title)}"
                    if start and end: url += f"&dates={start}/{end}"
                    if details: url += f"&details={urllib.parse.quote(details)}"
                    if location: url += f"&location={urllib.parse.quote(location)}"

                    # Try to add automatically first
                    auto_success = await insert_calendar_event_directly(event_data, userid=userid)

                    if auto_success:
                        answer = f"Success! I have automatically added '{title}' to your Google Calendar.\n\n```json\n{json.dumps(event_data, indent=2)}\n```"
                    else:
                        # Fallback to the beautiful button
                        btn_html = f"<div style='margin: 16px 0;'><a href='{url}' target='_blank' style='display:inline-block; background:linear-gradient(135deg, #3b82f6, #4f46e5); color:white; padding:10px 20px; border-radius:8px; text-decoration:none; font-weight:500; font-family:Inter, sans-serif; box-shadow:0 4px 12px rgba(59, 130, 246, 0.3);'>📅 Add '{title}' to Google Calendar</a></div>"
                        answer = f"I've prepared your calendar event!\n\n{btn_html}\n\n```json\n{json.dumps(event_data, indent=2)}\n```"

                    result = {
                        "answer": answer,
                        "tool_used": "Google Calendar"
                    }
                    save_to_history(payload.session_id, "assistant", result["answer"], mode)
                    return result
                except Exception as e:
                    result = {
                        "answer": f"I couldn't parse the event details from your message. Please be more specific about the date and time. (Error: {str(e)})\n\nRaw LLM output: {llm_response}",
                        "tool_used": "Google Calendar"
                    }
                    save_to_history(payload.session_id, "assistant", result["answer"], mode)
                    return result

            if mode == mode_gmail:
                is_allowed = False
                try:
                    from dbconfig.db import SessionLocal, UserTable
                    db_check = SessionLocal()
                    user_check = db_check.query(UserTable).filter(UserTable.userid == userid).first() if userid else None
                    if user_check and user_check.google_connected and user_check.email_enabled:
                        is_allowed = True
                    db_check.close()
                except Exception:
                    pass
                
                if not is_allowed:
                    return {
                        "answer": "Gmail integration is disabled. Please connect your Google Account and enable Email Integration in the Settings page.",
                        "tool_used": "Google Gmail"
                    }
                history_text = get_chat_history_context(payload.session_id, limit=8)
                history_block = f"Conversation History:\n{history_text}\n" if history_text else ""

                prompt_template = load_prompt("email_prompt.md")
                prompt = prompt_template.replace("{user_msg}", f"{history_block}User message: {user_msg}")

                llm_response = await call_apifreellm_tracked(prompt)
                if llm_response.startswith("[Warning]"):
                    save_to_history(payload.session_id, "assistant", llm_response, mode)
                    return {"answer": llm_response, "tool_used": "Google Gmail"}

                json_str = llm_response
                match = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', llm_response, re.DOTALL)
                if match:
                    json_str = match.group(1)
                else:
                    start_idx = llm_response.find('{')
                    end_idx = llm_response.rfind('}')
                    if start_idx != -1 and end_idx != -1:
                        json_str = llm_response[start_idx:end_idx+1]

                try:
                    email_data = json.loads(json_str)
                    to_email = email_data.get("to_email")
                    subject = email_data.get("subject", "No Subject")
                    body = email_data.get("body", "")

                    if not to_email:
                        result = {
                            "answer": "I'd be happy to send that email, but I need to know the destination email address. Who should I send it to?",
                            "tool_used": "Google Gmail"
                        }
                        save_to_history(payload.session_id, "assistant", result["answer"], mode)
                        return result

                    import base64
                    b64_to = base64.b64encode(to_email.encode('utf-8')).decode('utf-8')
                    b64_subject = base64.b64encode(subject.encode('utf-8')).decode('utf-8')
                    b64_body = base64.b64encode(body.encode('utf-8')).decode('utf-8')
                    summary_words = ' '.join(body.split()[:10]) + ("..." if len(body.split()) > 10 else "")
                    
                    btn_html = f"""<div class='zeus-email-draft-card'>
<div class='zeus-email-status-chip' style='display: none;'></div>
<p><strong>Summary:</strong> {summary_words}</p>
<p class='zeus-email-draft-prompt'>Would you like me sending email to <strong>{to_email}</strong>?</p>
<div class='zeus-email-draft-buttons'>
<button class='zeus-reject-email-btn' style='background: #ef4444; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 500;'>Reject</button>
<button class='zeus-approve-email-btn' data-to='{b64_to}' data-subject='{b64_subject}' data-body='{b64_body}' style='background: #10b981; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 500;'>Approve</button>
</div>
</div>"""
                    result = {
                        "answer": f"I have drafted the email.\n\n{btn_html}",
                        "tool_used": "Google Gmail"
                    }
                    save_to_history(payload.session_id, "assistant", result["answer"], mode)
                    return result
                except Exception as e:
                    result = {
                        "answer": f"I couldn't parse the email details. Please specify the recipient, subject, and body clearly. (Error: {str(e)})",
                        "tool_used": "Google Gmail"
                    }
                    save_to_history(payload.session_id, "assistant", result["answer"], mode)
                    return result

            if mode == mode_smart:
                async def event_generator():
                    try:
                        yield f"data: {json.dumps({'type': 'status', 'message': 'Analyzing request...'})}\n\n"

                        # 1. Clean visual attachment HTML tags from user_msg so the LLM only gets the clean text query
                        clean_user_msg = re.sub(r'<(div|img|i|span)\b[^>]*>.*?</\1>|<img\b[^>]*>', '', user_msg, flags=re.DOTALL).strip()
                        
                        is_workflow_mode = False
                        if "[Generate Workflow]" in clean_user_msg:
                            is_workflow_mode = True
                            clean_user_msg = clean_user_msg.replace("[Generate Workflow]", "").strip()

                        if not clean_user_msg:
                            clean_user_msg = "Please analyze the uploaded document."

                        # 2. Retrieve all documents/images uploaded in this chat session to provide automatic context
                        from dbconfig.db import SessionLocal, FileTable
                        db_session = SessionLocal()
                        session_files = []
                        try:
                            session_files = db_session.query(FileTable).filter(FileTable.session_id == payload.session_id).all()
                            
                            # 3. Synchronously run PaddleOCR or decode text files directly
                            from function import process_paddle_ocr
                            from dbconfig.firebase import download_file_from_firebase
                            for pf in session_files:
                                file_bytes = download_file_from_firebase(pf.file_id) if getattr(pf, 'firebase_url', None) else b""
                                if (not pf.ocr_text) and file_bytes:
                                    try:
                                        filename = pf.filename or ""
                                        mime_type = pf.mime_type or ""
                                        is_text_file = False
                                        if mime_type.startswith("text/") or filename.lower().endswith(('.txt', '.csv', '.json', '.md', '.xml', '.yaml', '.yml')):
                                            is_text_file = True
                                        
                                        if is_text_file:
                                            print(f"[Backend Chat] Decoding text file synchronously: {pf.filename}")
                                            text = file_bytes.decode("utf-8", errors="ignore")
                                            pf.ocr_details = [{"res": {"rec_texts": [text], "dt_polys": []}}]
                                        else:
                                            print(f"[Backend Chat] Running PaddleOCR synchronously for: {pf.filename}")
                                            ocr_res = process_paddle_ocr(file_bytes)
                                            text = ocr_res.get("raw_text", "")
                                            pf.ocr_details = ocr_res.get("ocr_details", [])
                                        
                                        pf.ocr_text = text
                                        pf.status = "ocr_completed"
                                        db_session.commit()
                                    except Exception as ocr_err:
                                        print(f"Error running OCR/decoding on session file: {ocr_err}")
                        except Exception as db_err:
                            print(f"Error querying session files: {db_err}")

                        # 4. Compile the OCR text context of all documents in the session
                        session_context = ""
                        for pf in session_files:
                            if pf.ocr_text:
                                session_context += f"\n\n--- Document: {pf.filename} ---\n{pf.ocr_text}"
                        
                        db_session.close()

                        # 5. Inject document context into file_context
                        file_context = ""
                        if session_context:
                            file_context = f"\n\n[Context from Uploaded Files in this Chat Session]:{session_context}\n"
                        elif file_ids:
                            # Fallback to simple context message if files exist but OCR yielded nothing
                            file_context = f"\n[System] The user has uploaded a file with ID: {file_ids[0]}."

                        custom_instructions = ""
                        if payload.system_instructions:
                            custom_instructions = f"\n[User Custom Instructions]: {payload.system_instructions}\n"

                        history_text = get_chat_history_context(payload.session_id, limit=8)
                        history_block = f"Conversation History:\n{history_text}\n" if history_text else ""

                        # Query registered DB and API connections
                        connections_context = ""
                        try:
                            from dbconfig.db import SessionLocal, DbConn, ApiConn
                            db_s = SessionLocal()
                            db_conns = db_s.query(DbConn).all()
                            api_conns = db_s.query(ApiConn).all()
                            
                            db_lines = []
                            for c in db_conns:
                                db_val = c.database_name if c.database_name else c.name
                                db_lines.append(f'- Name: "{c.name}", config value: "{db_val}" (Type: {c.type or "unknown"}, Desc: {c.description or ""})')
                            
                            api_lines = []
                            for c in api_conns:
                                api_lines.append(f'- Name: "{c.name}", config value: "{c.name}" (Method: {c.method or "GET"}, URL: {c.api_url or ""}, Desc: {c.description or ""})')
                            
                            db_s.close()
                            
                            if db_lines or api_lines:
                                connections_context = "\n\n[Available User Database/API Connections - MUST select matching connection names/values if relevant to the request]:\n"
                                if db_lines:
                                    connections_context += "Databases:\n" + "\n".join(db_lines) + "\n"
                                if api_lines:
                                    connections_context += "APIs:\n" + "\n".join(api_lines) + "\n"
                        except Exception as conn_exc:
                            print(f"Error building connections context: {conn_exc}")

                        prompt_template = load_prompt("smart_prompt.md")
                        
                        MAX_STEPS = 6
                        current_step = 0
                        tool_results_context = ""
                        final_answer = ""
                        tool_used_names = []
                        btn_html_additions = ""
                        
                        from datetime import datetime
                        now_str = datetime.now().strftime("%Y-%m-%d %I:%M %p")
                        date_context = f"\n[Current Time: {now_str}]\n"

                        while current_step < MAX_STEPS:
                            # Yield that we are planning/thinking
                            yield f"data: {json.dumps({'type': 'status', 'message': 'Planning next step...' if current_step > 0 else 'Analyzing request...'})}\n\n"
                            
                            prompt = prompt_template.replace("{custom_instructions}", custom_instructions).replace("{user_msg}", clean_user_msg).replace("{file_context}", date_context + file_context + connections_context).replace("{chat_history}", history_block).replace("{tool_results}", tool_results_context)
                            if is_workflow_mode:
                                workflow_tool_def = load_prompt("workflow_prompt.md")
                                prompt = prompt.replace("Available tools:", "Available tools:\n" + workflow_tool_def)
                                prompt += "\n\nCRITICAL: You MUST use the 'create_workflow' tool to fulfill this request."
                            
                            response_text = await call_apifreellm_tracked(prompt)
                            
                            # Check if it returned a JSON tool call
                            match = re.search(r'```json\s*(\{.*?\})\s*```', response_text, re.DOTALL)
                            if not match:
                                match = re.search(r'(\{.*?"tool"\s*:.*?\})', response_text, re.DOTALL)
                                
                            if match:
                                try:
                                    tool_call = json.loads(match.group(1))
                                    function_name = tool_call.get("tool")
                                    tool_used_names.append(function_name)
                                    print(f"Auto triggering tool (Step {current_step+1}): {function_name}")
                                    
                                    # Yield a nice status update depending on the tool name
                                    status_msg = f"Executing {function_name}..."
                                    if function_name == "read_document":
                                        status_msg = "Reading document details..."
                                    elif function_name == "web_search":
                                        status_msg = "Searching the web..."
                                    elif function_name == "execute_db_query":
                                        status_msg = "Retrieving data from database..."
                                    elif function_name == "send_email":
                                        status_msg = "Ready to send the email..."
                                    elif function_name == "create_calendar_event":
                                        status_msg = "Creating calendar event..."
                                    elif function_name == "create_workflow":
                                        status_msg = "Generating canvas workflow..."
                                    elif function_name == "generate_pdf_report":
                                        status_msg = "Generating PDF report..."
                                    
                                    yield f"data: {json.dumps({'type': 'status', 'message': status_msg})}\n\n"
                                    
                                    target_file_id = ""
                                    tool_result = ""
                                    if function_name == "read_document":
                                        target_file_id = file_ids[0] if file_ids else ""
                                        llm_file_id = tool_call.get("file_id")
                                        if llm_file_id and not target_file_id:
                                            try:
                                                from dbconfig.db import SessionLocal, FileTable
                                                db_s = SessionLocal()
                                                matching_file = db_s.query(FileTable).filter(
                                                    FileTable.session_id == payload.session_id,
                                                    (FileTable.file_id == llm_file_id) | (FileTable.filename == llm_file_id)
                                                ).first()
                                                if matching_file:
                                                    target_file_id = matching_file.file_id
                                                db_s.close()
                                            except Exception:
                                                pass
                                        if not target_file_id:
                                            target_file_id = llm_file_id or ""
                                        tool_result = await execute_read_document(target_file_id)
                                        
                                        if target_file_id:
                                            try:
                                                from dbconfig.db import SessionLocal, FileTable
                                                db_s = SessionLocal()
                                                pf = db_s.query(FileTable).filter(FileTable.file_id == target_file_id).first()
                                                doc_filename = pf.filename if pf else "Document"
                                                doc_mime = pf.mime_type if pf else "application/pdf"
                                                db_s.close()
                                            except Exception:
                                                doc_filename, doc_mime = "Document", "application/pdf"
                                            btn_html_additions += f"<br><br><button class='zeus-view-highlights-btn' data-file-id='{target_file_id}' data-filename='{doc_filename}' data-mime='{doc_mime}' style='background:linear-gradient(135deg, #3b82f6, #4f46e5); color:white; border:none; padding:8px 16px; border-radius:6px; cursor:pointer; font-weight:500; font-family:Inter, sans-serif; box-shadow:0 2px 8px rgba(59, 130, 246, 0.3); transition:all 0.2s;'><i class='fas fa-file-search' style='margin-right:6px;'></i> View Document Highlights</button>"
                                        
                                    elif function_name == "web_search":
                                        tool_result = await execute_web_search(tool_call.get("query", clean_user_msg))
                                        
                                    elif function_name == "execute_db_query":
                                        from workflow.autoTask import execute_db_query
                                        
                                        db_name = ""
                                        if payload.db_conn_id:
                                            try:
                                                from dbconfig.db import SessionLocal, DbConn
                                                dbs = SessionLocal()
                                                db_obj = dbs.query(DbConn).filter(DbConn.id == payload.db_conn_id).first()
                                                if db_obj:
                                                    db_name = db_obj.name
                                                dbs.close()
                                            except Exception:
                                                pass

                                        if not db_name:
                                            tool_result = "Error: You cannot execute queries because the user has not selected a database connection. Politely ask the user to select a database from the connection dropdown."
                                        else:
                                            query_txt = tool_call.get("query", "")
                                            tool_result = await execute_db_query(db_name, query_txt, "")
                                        
                                    elif function_name == "send_email":
                                        # Check if email is enabled
                                        is_allowed = False
                                        try:
                                            from dbconfig.db import SessionLocal, UserTable
                                            db_check = SessionLocal()
                                            user_check = db_check.query(UserTable).filter(UserTable.userid == userid).first() if userid else None
                                            if user_check and user_check.google_connected and user_check.email_enabled:
                                                is_allowed = True
                                            db_check.close()
                                        except Exception:
                                            pass
                                            
                                        if not is_allowed:
                                            tool_result = "Gmail integration is disabled. Please connect your Google Account and enable Email Integration in the Settings page."
                                        else:
                                            import base64
                                            to_email = tool_call.get("to_email", "")
                                            subject = tool_call.get("subject", "No Subject")
                                            body = tool_call.get("body", "")
                                            b64_to = base64.b64encode(to_email.encode('utf-8')).decode('utf-8')
                                            b64_subject = base64.b64encode(subject.encode('utf-8')).decode('utf-8')
                                            b64_body = base64.b64encode(body.encode('utf-8')).decode('utf-8')
                                            summary_words = ' '.join(body.split()[:10]) + ("..." if len(body.split()) > 10 else "")
                                            
                                            btn_html = f"""<div class='zeus-email-draft-card'>
<div class='zeus-email-status-chip' style='display: none;'></div>
<p><strong>Summary:</strong> {summary_words}</p>
<p class='zeus-email-draft-prompt'>Would you like me sending email to <strong>{to_email}</strong>?</p>
<div class='zeus-email-draft-buttons'>
<button class='zeus-reject-email-btn' style='background: #ef4444; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 500;'>Reject</button>
<button class='zeus-approve-email-btn' data-to='{b64_to}' data-subject='{b64_subject}' data-body='{b64_body}' style='background: #10b981; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 500;'>Approve</button>
</div>
</div>"""
                                            btn_html_additions += btn_html
                                            tool_result = f"Drafted the email to {to_email}. Waiting for user to approve or reject."
                                         
                                    elif function_name == "create_calendar_event":
                                        # Check if calendar is enabled
                                        is_allowed = False
                                        try:
                                            from dbconfig.db import SessionLocal, UserTable
                                            db_check = SessionLocal()
                                            user_check = db_check.query(UserTable).filter(UserTable.userid == userid).first() if userid else None
                                            if user_check and user_check.google_connected and user_check.calendar_enabled:
                                                is_allowed = True
                                            db_check.close()
                                        except Exception:
                                            pass
                                            
                                        if not is_allowed:
                                            tool_result = "Google Calendar integration is disabled. Please connect your Google Account and enable Calendar Integration in the Settings page."
                                        else:
                                            event_data = {
                                                "title": tool_call.get("title", "New Event"),
                                                "start_time": tool_call.get("start_time", ""),
                                                "end_time": tool_call.get("end_time", ""),
                                                "details": tool_call.get("details", ""),
                                                "location": tool_call.get("location", "")
                                            }
                                            auto_success = await insert_calendar_event_directly(event_data, userid=userid)
                                            if auto_success:
                                                tool_result = f"Calendar event '{event_data['title']}' was successfully added."
                                            else:
                                                tool_result = f"Failed to auto-add calendar event '{event_data['title']}'."
                                                
                                            import urllib.parse
                                            title = tool_call.get("title", "New Event")
                                            start = tool_call.get("start_time", "")
                                            end = tool_call.get("end_time", "")
                                            details = tool_call.get("details", "")
                                            location = tool_call.get("location", "")
                                            url = f"https://calendar.google.com/calendar/render?action=TEMPLATE"
                                            if title: url += f"&text={urllib.parse.quote(title)}"
                                            if start and end: url += f"&dates={urllib.parse.quote(start)}/{urllib.parse.quote(end)}"
                                            if details: url += f"&details={urllib.parse.quote(details)}"
                                            if location: url += f"&location={urllib.parse.quote(location)}"
                                            btn_html_additions += f"<div style='margin: 16px 0;'><a href='{url}' target='_blank' style='display:inline-block; background:linear-gradient(135deg, #3b82f6, #4f46e5); color:white; padding:10px 20px; border-radius:8px; text-decoration:none; font-weight:500; font-family:Inter, sans-serif; box-shadow:0 4px 12px rgba(59, 130, 246, 0.3);'><i class='fas fa-calendar-alt' style='margin-right:6px;'></i> Add '{title}' to Google Calendar</a></div>"
                                        
                                    elif function_name == "create_workflow":
                                        import base64
                                        import uuid
                                        workflow_data = tool_call.get("workflow", {})
                                        if "id" not in workflow_data:
                                            workflow_data["id"] = f"ta_gen_{uuid.uuid4().hex[:8]}"
                                        b64_workflow = base64.b64encode(json.dumps(workflow_data).encode("utf-8")).decode("utf-8")
                                        btn_html_additions += f"<br><br><button class='zeus-open-workflow-btn' data-workflow='{b64_workflow}' style='background:linear-gradient(135deg, #3b82f6, #4f46e5); color:white; border:none; padding:8px 16px; border-radius:6px; cursor:pointer; font-weight:500; font-family:Inter, sans-serif; box-shadow:0 2px 8px rgba(59, 130, 246, 0.3); transition:all 0.2s;'><i class='fas fa-project-diagram' style='margin-right:6px;'></i> Open Generated Workflow</button>"
                                        tool_result = f"Successfully drafted workflow '{workflow_data.get('name', 'Untitled')}'. Ready for user review."
                                        
                                    elif function_name == "generate_pdf_report":
                                        from function.fileGenerator import generate_pdf_report
                                        filename = tool_call.get("filename", "report.pdf")
                                        content = tool_call.get("content", "")
                                        chart_config = tool_call.get("chart_config", {})
                                        pdf_res = generate_pdf_report(content, filename, payload.session_id, userid, chart_config)
                                        if pdf_res.get("success"):
                                            file_id = pdf_res.get("file_id")
                                            tool_result = f"PDF Report '{filename}' successfully generated (File ID: {file_id})."
                                            btn_html_additions += f"<br><br><button class='zeus-view-highlights-btn' data-file-id='{file_id}' data-filename='{filename}' data-mime='application/pdf' style='background:linear-gradient(135deg, #10b981, #059669); color:white; border:none; padding:8px 16px; border-radius:6px; cursor:pointer; font-weight:500; font-family:Inter, sans-serif; box-shadow:0 2px 8px rgba(16, 185, 129, 0.3); transition:all 0.2s;'><i class='fas fa-file-pdf' style='margin-right:6px;'></i> Preview generated PDF: {filename}</button>"
                                        else:
                                            tool_result = f"Failed to generate PDF Report: {pdf_res.get('error')}"
                                    else:
                                        tool_result = "Unknown tool requested."

                                    # Append result and loop
                                    tool_results_context += f"\n\n[System] Tool '{function_name}' was executed. Result:\n{tool_result}\n\n[Instruction] You must now either use another tool, or reply to the user using the tool results. DO NOT assume the user saw the tool results."
                                    
                                    # Yield status that we are writing summaries/processing results
                                    yield f"data: {json.dumps({'type': 'status', 'message': 'Writing the summaries...' if function_name == 'execute_db_query' else 'Processing action results...'})}\n\n"
                                    
                                    current_step += 1
                                    continue
                                    
                                except Exception as json_exc:
                                    print(f"Error parsing tool JSON: {json_exc}")
                                    final_answer = response_text
                                    break
                                    
                            else:
                                # LLM gave a text response, no more tools
                                final_answer = response_text
                                break
                                
                        if not final_answer:
                            final_answer = "I executed multiple actions based on your request, but reached the maximum allowed steps before summarizing. The requested actions should be completed."
                            
                        # Make sure that if there are uploaded files in this request/session, 
                        # the user gets the "View Document Highlights" button even if the LLM 
                        # didn't explicitly call the read_document tool (since the context was injected automatically)
                        if file_ids:
                            try:
                                from dbconfig.db import SessionLocal, FileTable
                                db_s = SessionLocal()
                                for fid in file_ids:
                                    if f"data-file-id='{fid}'" not in btn_html_additions and f'data-file-id="{fid}"' not in btn_html_additions:
                                        pf = db_s.query(FileTable).filter(FileTable.file_id == fid).first()
                                        if pf:
                                            doc_filename = pf.filename or "Document"
                                            doc_mime = pf.mime_type or "application/pdf"
                                            btn_html_additions += f"<br><br><button class='zeus-view-highlights-btn' data-file-id='{fid}' data-filename='{doc_filename}' data-mime='{doc_mime}' style='background:linear-gradient(135deg, #3b82f6, #4f46e5); color:white; border:none; padding:8px 16px; border-radius:6px; cursor:pointer; font-weight:500; font-family:Inter, sans-serif; box-shadow:0 2px 8px rgba(59, 130, 246, 0.3); transition:all 0.2s;'><i class='fas fa-file-search' style='margin-right:6px;'></i> View Document Highlights</button>"
                                db_s.close()
                            except Exception as db_exc:
                                print(f"Error appending highlights button fallback: {db_exc}")

                        if btn_html_additions:
                            final_answer += btn_html_additions

                        used_tool_str = ", ".join(tool_used_names) if tool_used_names else None
                        
                        save_to_history(payload.session_id, "assistant", final_answer, mode)
                        
                        # Yield final response
                        yield f"data: {json.dumps({'type': 'final', 'answer': final_answer, 'tool_used': used_tool_str})}\n\n"
                        
                    except Exception as e:
                        print(f"Error in event_generator: {traceback.format_exc()}")
                        err_msg = "[Warning] Sorry, I encountered an internal error while processing your request. Please try again."
                        save_to_history(payload.session_id, "assistant", err_msg, mode)
                        yield f"data: {json.dumps({'type': 'final', 'answer': err_msg, 'tool_used': 'Error'})}\n\n"

                return StreamingResponse(event_generator(), media_type="text/event-stream")


            raise HTTPException(status_code=400, detail="Unknown mode selected.")
        except Exception:
            print(f"Crash in handle_zeus_chat: {traceback.format_exc()}")
            answer = "[Warning] Sorry, I encountered an internal error while processing your request. Please try again."
            save_to_history(payload.session_id, "assistant", answer, mode)
            return {"answer": answer, "tool_used": "Error"}

    return handle_zeus_chat
