import asyncio
import json
import re
import os
from typing import AsyncGenerator, Any, Dict, List, Optional

import httpx
from sqlalchemy import inspect, text
from dbconfig.db import SessionLocal, DbConn, FileTable, create_readonly_engine
from function.api_client import ZeusAPIClient

REPORT_CONTEXT_KIND = "zeus_report_context"

async def execute_llm_call(prompt: str) -> str:
    return await ZeusAPIClient.get_instance().generate_content(prompt, temperature=0.6)

async def execute_json_llm_call(prompt: str) -> str:
    return await ZeusAPIClient.get_instance().generate_content(
        prompt,
        system_instruction="Return strictly valid JSON and no markdown.",
        response_mime_type="application/json",
        temperature=0.0,
    )

def parse_json_response(text_value: str) -> Optional[dict]:
    if not text_value:
        return None
    try:
        return json.loads(text_value)
    except json.JSONDecodeError:
        cleaned = re.sub(r"```json\s*", "", text_value, flags=re.IGNORECASE)
        cleaned = re.sub(r"```", "", cleaned).strip()
        try:
            return json.loads(cleaned)
        except Exception:
            return None

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

def _row_to_dict(row: Any) -> Dict[str, Any]:
    if hasattr(row, "_mapping"):
        return dict(row._mapping)
    if isinstance(row, dict):
        return dict(row)
    return {}

def _rows_to_markdown(columns: List[str], rows: List[Dict[str, Any]]) -> str:
    if not rows:
        return "Query executed successfully, but returned 0 rows."
    md_table = "| " + " | ".join(columns) + " |\n"
    md_table += "| " + " | ".join(["---"] * len(columns)) + " |\n"
    for row in rows[:50]:
        row_vals = [str(row.get(col)) if row.get(col) is not None else "NULL" for col in columns]
        md_table += "| " + " | ".join(row_vals) + " |\n"
    return md_table

async def plan_report_query(db_name: str, prompt_text: str, context_data: str, schema_context: str) -> Dict[str, Any]:
    planning_prompt = (
        "You are a data reporting assistant. Return a short JSON object with these keys: "
        "sql_query, report_title, summary_note, chart_config. "
        "chart_config must be an object like {\"type\":\"bar\",\"x_axis\":\"column\",\"y_axis\":\"column\"}, or {} when no chart is useful. "
        "Do not include result rows. Only generate read-only SQL.\n\n"
        f"Database name: {db_name}\n"
        f"Database schema:\n{schema_context}\n\n"
        f"Context from previous workflow steps:\n{context_data}\n\n"
        f"User request:\n{prompt_text}"
    )
    llm_response = await execute_json_llm_call(planning_prompt)
    plan = parse_json_response(llm_response) or {}
    sql_query = (plan.get("sql_query") or "").strip()
    if not sql_query:
        fallback_prompt = (
            "Generate ONLY the raw SQL query inside a ```sql ... ``` code block based on the user's prompt.\n"
            f"Database Schema:\n{schema_context}\n\nContext Data from previous steps: {context_data}\n\nUser Prompt: {prompt_text}"
        )
        fallback = await execute_llm_call(fallback_prompt)
        sql_match = re.search(r'```sql\s*(.*?)\s*```', fallback, re.DOTALL | re.IGNORECASE)
        sql_query = sql_match.group(1).strip() if sql_match else fallback.strip()
    return {
        "sql_query": sql_query,
        "report_title": plan.get("report_title") or "Generated Database Report",
        "summary_note": plan.get("summary_note") or "Report generated from the selected database query.",
        "chart_config": plan.get("chart_config") or {},
    }

async def execute_db_query(db_name: str, prompt_text: str, context_data: str, structured: bool = False) -> str:
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
        plan = await plan_report_query(db_name, prompt_text, context_data, schema_context)
        sql_query = plan["sql_query"]
        if "select" not in sql_query.lower() and "show" not in sql_query.lower() and "desc" not in sql_query.lower():
            select_match = re.search(r'(select\s+.*)', sql_query, re.DOTALL | re.IGNORECASE)
            if select_match:
                sql_query = select_match.group(1)

        if not is_sql_safe(sql_query):
            return "[Error] Unsafe SQL query generated. Only SELECT allowed."

        with target_engine.connect() as target_conn:
            res = target_conn.execute(text(sql_query))
            columns = list(res.keys())
            rows = [_row_to_dict(row) for row in res.fetchall()]

        if structured:
            return json.dumps({
                "kind": REPORT_CONTEXT_KIND,
                "db_name": db_name,
                "sql_query": sql_query,
                "columns": columns,
                "rows": rows,
                "report_title": plan["report_title"],
                "summary_note": plan["summary_note"],
                "chart_config": plan["chart_config"],
            }, default=str)

        return _rows_to_markdown(columns, rows)
    except Exception as e:
        return f"[Error] Database query failed: {e}"
    finally:
        db.close()

def parse_report_context(context_data: str) -> Optional[dict]:
    try:
        parsed = json.loads(context_data)
        if isinstance(parsed, dict) and parsed.get("kind") == REPORT_CONTEXT_KIND:
            return parsed
    except Exception:
        return None
    return None

async def format_email_body_with_llm(raw_data: str) -> str:
    base_path = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    prompt_path = os.path.join(base_path, "souls", "emailInstructions.md")
    try:
        with open(prompt_path, "r", encoding="utf-8") as f:
            instructions = f.read()
    except Exception:
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
    except Exception:
        return html_body

def render_data_report_email(report_context: dict, download_link: str = "") -> str:
    from jinja2 import Environment, FileSystemLoader, select_autoescape

    base_path = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    template_dir = os.path.join(base_path, "templates")
    env = Environment(loader=FileSystemLoader(template_dir), autoescape=select_autoescape(["html", "xml"]))
    template = env.get_template("email_data_report_template.html")
    return template.render(
        subject=report_context.get("report_title", "Generated Report"),
        report_title=report_context.get("report_title", "Generated Report"),
        summary_note=report_context.get("summary_note", "Your report is ready."),
        columns=report_context.get("columns", []),
        preview_rows=(report_context.get("rows", []) or [])[:8],
        download_link=download_link,
    )

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
                except Exception:
                    pass

                if db_target:
                    result = await execute_db_query(db_target, prompt_text, context_data, structured=True)
                    context_data = result
                    yield json.dumps({"type": "log", "node_id": current_id, "message": "Database query planned and executed."}) + "\n"
                else:
                    full_prompt = f"Context Data: {context_data}\n\nUser Instructions: {prompt_text}"
                    result = await execute_llm_call(full_prompt)
                    context_data = result
                    yield json.dumps({"type": "log", "node_id": current_id, "message": "LLM Prompt executed."}) + "\n"

            elif node_type == "gmail":
                from function.email import execute_send_email
                to_email = config.get("to", "")
                subject = "AI Workflow Notification"
                report_context = parse_report_context(context_data)
                if report_context:
                    subject = report_context.get("report_title") or subject
                    final_html = render_data_report_email(report_context, report_context.get("download_link", ""))
                    yield json.dumps({"type": "log", "node_id": current_id, "message": "Prepared data report email preview."}) + "\n"
                else:
                    yield json.dumps({"type": "log", "node_id": current_id, "message": "Formatting email content via LLM..."}) + "\n"
                    html_inner = await format_email_body_with_llm(context_data)
                    final_html = await wrap_in_html_template(html_inner, subject)

                res = await execute_send_email(to_email, subject, final_html, is_html=True, userid=userid)
                yield json.dumps({"type": "log", "node_id": current_id, "message": f"Gmail node executed: {res}"}) + "\n"

            elif node_type == "calendar":
                from function.calendar import insert_calendar_event_directly
                date_str = config.get("date", "").replace("-", "")
                time_str = config.get("time", "").replace(":", "")
                event_time = f"{date_str}T{time_str}00" if date_str and time_str else "20260101T090000"
                event_data = {
                    "title": config.get("info", "Automated Event"),
                    "start_time": event_time,
                    "end_time": event_time,
                    "details": context_data,
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
                    from dbconfig.firebase import download_file_from_firebase
                    file_bytes = download_file_from_firebase(record.file_id) if record and getattr(record, 'firebase_url', None) else b""
                    if record and file_bytes:
                        from function.docExtract import process_paddle_ocr
                        ocr_res = process_paddle_ocr(file_bytes)
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
                from function.fileGenerator import generate_pdf_report, generate_structured_pdf_report
                filename = config.get("filename", "workflow_report.pdf")
                yield json.dumps({"type": "log", "node_id": current_id, "message": f"Generating PDF report: {filename}..."}) + "\n"

                report_context = parse_report_context(context_data)
                if report_context:
                    pdf_res = generate_structured_pdf_report(
                        report_title=report_context.get("report_title", "Generated Database Report"),
                        summary_note=report_context.get("summary_note", "Report generated from workflow data."),
                        rows=report_context.get("rows", []),
                        columns=report_context.get("columns", []),
                        chart_config=report_context.get("chart_config", {}),
                        sql_query=report_context.get("sql_query", ""),
                        filename=filename,
                        session_id=None,
                        userid=userid,
                        report_subtitle=f"Database report from {report_context.get('db_name', 'workflow')}",
                    )
                else:
                    pdf_res = generate_pdf_report(context_data, filename, None, userid)

                if pdf_res.get("success"):
                    report_context = report_context or {}
                    report_context.update({
                        "kind": REPORT_CONTEXT_KIND,
                        "download_link": pdf_res.get("firebase_url", ""),
                        "file_id": pdf_res.get("file_id"),
                        "filename": filename,
                    })
                    context_data = json.dumps(report_context, default=str)
                    yield json.dumps({"type": "log", "node_id": current_id, "message": f"PDF Report '{filename}' successfully generated (File ID: {pdf_res.get('file_id')})."}) + "\n"
                else:
                    yield json.dumps({"type": "log", "node_id": current_id, "message": f"[Error] Failed to generate PDF Report: {pdf_res.get('error')}"}) + "\n"
                    raise Exception(pdf_res.get("error"))

            elif node_type == "end":
                yield json.dumps({"type": "log", "node_id": current_id, "message": "Reached End node."}) + "\n"
                yield json.dumps({"type": "status", "node_id": current_id, "status": "success"}) + "\n"
                yield json.dumps({"type": "finish", "output": context_data}) + "\n"
                break

            yield json.dumps({"type": "status", "node_id": current_id, "status": "success"}) + "\n"
            if current_id in next_node_map:
                for next_id in next_node_map[current_id]:
                    context_data_map[next_id] = context_data
                    queue.append(next_id)

        except Exception as e:
            yield json.dumps({"type": "log", "node_id": current_id, "message": f"[Error] Node {node_type} failed: {e}"}) + "\n"
            yield json.dumps({"type": "status", "node_id": current_id, "status": "error"}) + "\n"
            yield json.dumps({"type": "error", "message": f"Pipeline failed at {node_type}"}) + "\n"
            return
