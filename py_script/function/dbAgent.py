import re
import os
from sqlalchemy import inspect, text
from dbconfig.db import SessionLocal, ChatSession, DbConn, create_readonly_engine
from memory.memory import get_chat_history_context

def remove_sql_literals(sql: str) -> str:
    # Replace single quoted strings
    sql = re.sub(r"'[^'\\]*(?:\\.[^'\\]*)*'", "''", sql)
    # Replace double quoted strings
    sql = re.sub(r'"[^"\\]*(?:\\.[^"\\]*)*"', '""', sql)
    return sql

def is_sql_safe(sql: str) -> bool:
    # 1. Strip comments
    clean_sql = re.sub(r'--.*?\n', '\n', sql)
    clean_sql = re.sub(r'/\*.*?\*/', '', clean_sql, flags=re.DOTALL)
    
    # 2. Strip string literals
    clean_sql = remove_sql_literals(clean_sql)
    
    # 3. Clean and lowercase
    clean_sql = clean_sql.strip().lower()
    
    # 4. Check allowed prefixes
    allowed_prefixes = ("select", "show", "desc", "describe", "explain", "with")
    if not clean_sql.startswith(allowed_prefixes):
        return False
        
    # 5. Check forbidden destructive keywords
    forbidden_keywords = [
        "insert", "update", "delete", "drop", "alter", 
        "truncate", "replace", "create", "grant", "revoke",
        "merge", "into", "set", "upsert"
    ]
    
    for kw in forbidden_keywords:
        pattern = r'\b' + re.escape(kw) + r'\b'
        if re.search(pattern, clean_sql):
            return False
            
    return True

async def run_db_agent(payload, user_msg: str, mode: str, call_apifreellm, save_to_history):
    print(f"[DB Agent] Processing query in database chat session: {payload.session_id}")
    db = SessionLocal()
    try:
        conn_config = None
        if payload.db_conn_id:
            conn_config = db.query(DbConn).filter(DbConn.id == payload.db_conn_id).first()
        else:
            conn_config = db.query(DbConn).first()
        
        if not conn_config:
            db.close()
            answer = "This database chat session has no connection configured. Please select or add a database connection first."
            save_to_history(payload.session_id, "assistant", answer, mode)
            return {"answer": answer, "tool_used": "Database Chat (No Connection)"}

        print(f"[DB Agent] Querying connection: {conn_config.name} ({conn_config.type})")
        is_api = conn_config.type.lower() in ["rest api", "rest_api", "api"]
        
        if is_api:
            prompt = (
                f"You are an API integration assistant. The user wants to query a REST API named '{conn_config.name}' "
                f"located at URL '{conn_config.api_url}'.\n"
                f"Description: {conn_config.description or 'None'}\n"
                f"Parameters: {conn_config.parameter or 'None'}\n"
                f"HTTP Method: {conn_config.method or 'GET'}\n\n"
                f"User Query: {user_msg}\n\n"
                f"Analyze the request and provide a clear explanation of how to call this API to get the desired data. "
                f"Format your response in clean markdown."
            )
            api_answer = await call_apifreellm(prompt)
            save_to_history(payload.session_id, "assistant", api_answer, mode)
            db.close()
            return {"answer": api_answer, "tool_used": f"API connection ({conn_config.name})"}
        
        else:
            target_engine = create_readonly_engine(conn_config.connection_str, db_type=conn_config.type)
            
            inspector = inspect(target_engine)
            schema_info = []
            try:
                table_names = inspector.get_table_names()
                for table_name in table_names[:10]: 
                    columns = inspector.get_columns(table_name)
                    col_details = [f"{col['name']} ({str(col['type'])})" for col in columns]
                    schema_info.append(f"Table: {table_name}\nColumns: {', '.join(col_details)}")
            except Exception as ins_err:
                print(f"Error inspecting tables: {ins_err}")
                schema_info = ["Could not retrieve tables. Ensure credentials have access and connection works."]
            
            schema_context = "\n\n".join(schema_info)
            
            history_text = get_chat_history_context(payload.session_id, limit=6)
            history_block = f"Conversation History:\n{history_text}\n" if history_text else ""
            
            sql_gen_prompt = (
                f"You are a database query expert and general AI assistant.\n"
                f"1. If the user's question requires querying the database to get specific data, generate ONLY the raw SQL query inside a ```sql ... ``` code block. Do not write any explanations.\n"
                f"2. If the user's question is conversational or asks for general knowledge (e.g., 'What is Honda company?', 'Hello'), simply answer the question directly in plain text or markdown WITHOUT any ```sql ... ``` code block.\n\n"
                f"Database Type: {conn_config.type}\n"
                f"Database Schema:\n{schema_context}\n\n"
                f"{history_block}User Question: {user_msg}"
            )
            sql_response = await call_apifreellm(sql_gen_prompt)
            
            sql_match = re.search(r'```sql\s*(.*?)\s*```', sql_response, re.DOTALL | re.IGNORECASE)
            
            if not sql_match:
                is_plain_sql = sql_response.strip().lower().startswith(("select ", "show ", "desc ", "with "))
                if not is_plain_sql:
                    save_to_history(payload.session_id, "assistant", sql_response.strip(), mode)
                    db.close()
                    return {"answer": sql_response.strip(), "tool_used": f"Direct Answer ({conn_config.name})"}
                else:
                    sql_query = sql_response.strip()
            else:
                sql_query = sql_match.group(1).strip()
            
            if "select" not in sql_query.lower() and "show" not in sql_query.lower() and "desc" not in sql_query.lower():
                select_match = re.search(r'(select\s+.*)', sql_query, re.DOTALL | re.IGNORECASE)
                if select_match:
                    sql_query = select_match.group(1)
            # print(f"[DB Agent] Generated SQL: {sql_query}")
            
            try:
                if not is_sql_safe(sql_query):
                    raise ValueError("Unsafe SQL query detected. Only read-only queries (SELECT, SHOW, DESC, EXPLAIN) are permitted.")

                with target_engine.connect() as target_conn:
                    res = target_conn.execute(text(sql_query))
                    keys = res.keys()
                    rows = res.fetchall()
                
                if not rows:
                    md_table = "Query executed successfully, but returned 0 rows."
                else:
                    md_table = "| " + " | ".join(keys) + " |\n"
                    md_table += "| " + " | ".join(["---"] * len(keys)) + " |\n"
                    for row in rows[:50]:
                        row_vals = [str(val) if val is not None else "NULL" for val in row]
                        md_table += "| " + " | ".join(row_vals) + " |\n"
                    if len(rows) > 50:
                        md_table += f"\n*(Showing top 50 of {len(rows)} rows)*"
                
                db_answer = md_table
                save_to_history(payload.session_id, "assistant", db_answer, mode)
                db.close()
                return {"answer": db_answer, "tool_used": f"Database query ({conn_config.name})"}
                
            except Exception as run_err:
                print(f"Error running SQL: {run_err}")
                db_answer = (
                    f"[Warning] **Error executing query:**\n```\n{str(run_err)}\n```\n\n"
                    f"**Generated SQL (attempted):**\n```sql\n{sql_query}\n```"
                )
                save_to_history(payload.session_id, "assistant", db_answer, mode)
                db.close()
                return {"answer": db_answer, "tool_used": "Database query error"}
                
    except Exception as e:
        print(f"Error in database chat session: {e}")
        db.close()
        err_answer = f"[Warning] Sorry, I encountered an error querying the database: {str(e)}"
        save_to_history(payload.session_id, "assistant", err_answer, mode)
        return {"answer": err_answer, "tool_used": "Error"}
