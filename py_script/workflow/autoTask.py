import asyncio
import json
import re
import os
from typing import AsyncGenerator
from sqlalchemy import inspect, text
from dbconfig.db import SessionLocal, DbConn, FileTable, create_readonly_engine
from function.api_client import ZeusAPIClient

async def execute_llm_call(prompt: str) -> str:
    return await ZeusAPIClient.get_instance().generate_content(prompt, temperature=0.6)

def is_sql_safe(sql: str) -> bool:
    clean_sql = re.sub(r'--.*?\n', '\n', sql)
    clean_sql = re.sub(r'/\*.*?\*/', '', clean_sql, flags=re.DOTALL)
    clean_sql = clean_sql.strip().lower()
    allowed = ("select", "show", "desc", "describe", "explain", "with")
    if not clean_sql.startswith(allowed):
        return False
    forbidden = ["insert", "update", "delete", "drop", "alter", "truncate", "replace", "create", "grant", "revoke", "merge", "into", "set", "upsert"]
    for kw in forbidden:
        pattern = r'\b' + re.escape(kw) + r'\b'
        if re.search(pattern, clean_sql):
            return False
    return True

async def execute_db_query(db_name: str, prompt_text: str, context_data: str) -> str:
    db = SessionLocal()
    try:
        conn_config = db.query(DbConn).filter(DbConn.database_name == db_name).first()
        if not conn_config:
            conn_config = db.query(DbConn).filter(DbConn.name == db_name).first()
        if not conn_config:
            return f"[Error] Database '{db_name}' not found."

        target_engine = create_readonly_engine(conn_config.connection_str, db_type=conn_config.type)
        inspector = inspect(target_engine)
        schema_info = []
        try:
            for table_name in inspector.get_table_names()[:10]:
                columns = inspector.get_columns(table_name)
                col_details = [f"{col['name']} ({str(col['type'])})" for col in columns]
                schema_info.append(f"Table: {table_name}\nColumns: {', '.join(col_details)}")
        except Exception as e:
            return f"[Error] Could not retrieve tables for {db_name}: {e}"

        schema_context = "\n\n".join(schema_info)
        sql_gen_prompt = (
            f"You are a database query expert.\n"
            f"Generate ONLY the raw SQL query inside a ```sql ... ``` code block based on the user's prompt.\n"
            f"Database Schema:\n{schema_context}\n\n"
            f"Context Data from previous steps: {context_data}\n\n"
            f"User Prompt: {prompt_text}"
        )
        sql_response = await execute_llm_call(sql_gen_prompt)
        sql_match = re.search(r'```sql\s*(.*?)\s*```', sql_response, re.DOTALL | re.IGNORECASE)
        sql_query = sql_match.group(1).strip() if sql_match else sql_response.strip()
        
        if "select" not in sql_query.lower() and "show" not in sql_query.lower() and "desc" not in sql_query.lower():
            select_match = re.search(r'(select\s+.*)', sql_query, re.DOTALL | re.IGNORECASE)
            if select_match:
                sql_query = select_match.group(1)
                
        if not is_sql_safe(sql_query):
            return "[Error] Unsafe SQL query generated. Only SELECT allowed."
            
        with target_engine.connect() as target_conn:
            res = target_conn.execute(text(sql_query))
            keys = res.keys()
            rows = res.fetchall()
            
        if not rows:
            return "Query executed successfully, but returned 0 rows."
            
        md_table = "| " + " | ".join(keys) + " |\n"
        md_table += "| " + " | ".join(["---"] * len(keys)) + " |\n"
        for row in rows[:50]:
            row_vals = [str(val) if val is not None else "NULL" for val in row]
            md_table += "| " + " | ".join(row_vals) + " |\n"
        
        return md_table
    except Exception as e:
        return f"[Error] Database query failed: {e}"
    finally:
        db.close()

async def format_email_body_with_llm(raw_data: str) -> str:
    base_path = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    prompt_path = os.path.join(base_path, "souls", "emailInstructions.md")
    try:
        with open(prompt_path, "r", encoding="utf-8") as f:
            instructions = f.read()
    except Exception as e:
        instructions = "Format the following data into an HTML email body (no html/body tags)."
        
    full_prompt = f"{instructions}\n\nInput Data to Format:\n{raw_data}"
    html_body = await execute_llm_call(full_prompt)
    
    html_body = re.sub(r'```html\s*', '', html_body, flags=re.IGNORECASE)
    html_body = re.sub(r'```', '', html_body)
    return html_body.strip()

async def wrap_in_html_template(html_body: str, subject: str) -> str:
    base_path = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    template_path = os.path.join(base_path, "templates", "email_template.html")
    try:
        with open(template_path, "r", encoding="utf-8") as f:
            template = f.read()
            template = template.replace("{{SUBJECT_LINE}}", subject)
            template = template.replace("{{BODY_CONTENT}}", html_body)
            return template
    except Exception as e:
        return html_body

async def execute_workflow(workflow_data: dict) -> AsyncGenerator[str, None]:
    userid = workflow_data.get("userid")
    nodes = {n["id"]: n for n in workflow_data.get("nodes", [])}
    connections = workflow_data.get("connections", [])
    
    next_node_map = {}
    for conn in connections:
        from_id = conn["fromNodeId"]
        to_id = conn["toNodeId"]
        if from_id not in next_node_map:
            next_node_map[from_id] = []
        next_node_map[from_id].append(to_id)

    start_nodes = [n for n in nodes.values() if n["type"] == "start"]
    if not start_nodes:
        yield json.dumps({"type": "error", "message": "No Start node found."}) + "\n"
        return
    
    queue = [start_nodes[0]["id"]]
    context_data_map = {start_nodes[0]["id"]: ""}
    visited = set()
    
    while queue:
        current_id = queue.pop(0)
        
        # Prevent cycles
        if current_id in visited:
            continue
        visited.add(current_id)
        
        if current_id not in nodes:
            continue
            
        node = nodes[current_id]
        node_type = node["type"]
        config = node.get("config", {})
        context_data = context_data_map.get(current_id, "")
        
        yield json.dumps({"type": "log", "node_id": current_id, "message": f"Executing node: {node_type}"}) + "\n"
        yield json.dumps({"type": "status", "node_id": current_id, "status": "executing"}) + "\n"
        
        try:
            if node_type == "database":
                db_name = config.get("db", "")
                context_data = json.dumps({"db_target": db_name, "prev_context": context_data})
                yield json.dumps({"type": "log", "node_id": current_id, "message": f"Database target set to {db_name}"}) + "\n"
                
            elif node_type == "llm":
                prompt_text = config.get("prompt", "")
                db_target = ""
                try:
                    ctx_obj = json.loads(context_data)
                    if isinstance(ctx_obj, dict) and "db_target" in ctx_obj:
                        db_target = ctx_obj["db_target"]
                        context_data = ctx_obj.get("prev_context", "")
                except:
                    pass
                
                if db_target:
                    result = await execute_db_query(db_target, prompt_text, context_data)
                    context_data = result
                    yield json.dumps({"type": "log", "node_id": current_id, "message": f"LLM + Database Query executed."}) + "\n"
                else:
                    full_prompt = f"Context Data: {context_data}\n\nUser Instructions: {prompt_text}"
                    result = await execute_llm_call(full_prompt)
                    context_data = result
                    yield json.dumps({"type": "log", "node_id": current_id, "message": f"LLM Prompt executed."}) + "\n"
                    
            elif node_type == "gmail":
                from function.email import execute_send_email
                to_email = config.get("to", "")
                subject = "AI Workflow Notification"
                yield json.dumps({"type": "log", "node_id": current_id, "message": f"Formatting email content via LLM..."}) + "\n"
                html_inner = await format_email_body_with_llm(context_data)
                final_html = await wrap_in_html_template(html_inner, subject)
                
                res = await execute_send_email(to_email, subject, final_html, is_html=True, userid=userid)
                yield json.dumps({"type": "log", "node_id": current_id, "message": f"Gmail node executed: {res}"}) + "\n"
                
            elif node_type == "calendar":
                from function.calendar import insert_calendar_event_directly
                date_str = config.get("date", "").replace("-", "")
                time_str = config.get("time", "").replace(":", "")
                if date_str and time_str:
                    event_time = f"{date_str}T{time_str}00"
                else:
                    event_time = "20260101T090000"
                    
                event_data = {
                    "title": config.get("info", "Automated Event"),
                    "start_time": event_time,
                    "end_time": event_time,
                    "details": context_data
                }
                res = await insert_calendar_event_directly(event_data, userid=userid)
                yield json.dumps({"type": "log", "node_id": current_id, "message": f"Calendar node executed: {'Success' if res else 'Failed'}"}) + "\n"
                
            elif node_type == "web_search":
                from function.web_search import execute_web_search
                url_query = config.get("url", "")
                yield json.dumps({"type": "log", "node_id": current_id, "message": f"Web Search node executed for {url_query}"}) + "\n"
                search_res = await execute_web_search(url_query)
                context_data = f"Search query provided: {url_query}\nResult:\n{search_res}\n\nPrevious Context: {context_data}"
                
            elif node_type == "ocr":
                file_id = config.get("file_id", "")
                yield json.dumps({"type": "log", "node_id": current_id, "message": f"OCR node executing for file_id {file_id}"}) + "\n"
                ocr_text = "No file found."
                if file_id:
                    db = SessionLocal()
                    record = db.query(FileTable).filter(FileTable.file_id == file_id).first()
                    db.close()
                    if record and record.file_data:
                        from function.docExtract import process_paddle_ocr
                        ocr_res = process_paddle_ocr(record.file_data)
                        ocr_text = ocr_res.get("raw_text", "")
                context_data = f"OCR Output:\n{ocr_text}\nPrevious Context: {context_data}"
                
            elif node_type == "api":
                api_target = config.get("api", "")
                yield json.dumps({"type": "log", "node_id": current_id, "message": f"API node executed for {api_target}"}) + "\n"
                try:
                    async with httpx.AsyncClient(timeout=10) as client:
                        resp = await client.get(api_target)
                        api_res = resp.text
                except Exception as ex:
                    api_res = str(ex)
                context_data = f"API result for {api_target}:\n{api_res}\nPrevious Context: {context_data}"

            elif node_type == "report":
                from function.fileGenerator import generate_pdf_report
                filename = config.get("filename", "workflow_report.pdf")
                yield json.dumps({"type": "log", "node_id": current_id, "message": f"Generating PDF report: {filename}..."}) + "\n"
                
                userid = workflow_data.get("userid")
                pdf_res = generate_pdf_report(context_data, filename, None, userid)
                if pdf_res.get("success"):
                    yield json.dumps({"type": "log", "node_id": current_id, "message": f"PDF Report '{filename}' successfully generated (File ID: {pdf_res.get('file_id')})."}) + "\n"
                    context_data = f"Generated PDF Report: {filename} (File ID: {pdf_res.get('file_id')})\n\nContent:\n{context_data}"
                else:
                    yield json.dumps({"type": "log", "node_id": current_id, "message": f"[Error] Failed to generate PDF Report: {pdf_res.get('error')}"}) + "\n"
                    raise Exception(pdf_res.get("error"))

            elif node_type == "end":
                yield json.dumps({"type": "log", "node_id": current_id, "message": "Reached End node."}) + "\n"
                yield json.dumps({"type": "status", "node_id": current_id, "status": "success"}) + "\n"
                yield json.dumps({"type": "finish", "output": context_data}) + "\n"
                break
                
            yield json.dumps({"type": "status", "node_id": current_id, "status": "success"}) + "\n"
            
            # Push next nodes to queue for parallel paths execution
            if current_id in next_node_map:
                for next_id in next_node_map[current_id]:
                    # Forward context to next nodes
                    context_data_map[next_id] = context_data
                    queue.append(next_id)
                    
        except Exception as e:
            yield json.dumps({"type": "log", "node_id": current_id, "message": f"[Error] Node {node_type} failed: {e}"}) + "\n"
            yield json.dumps({"type": "status", "node_id": current_id, "status": "error"}) + "\n"
            yield json.dumps({"type": "error", "message": f"Pipeline failed at {node_type}"}) + "\n"
            return
