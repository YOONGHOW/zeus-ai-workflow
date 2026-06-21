from sqlalchemy import desc

def get_chat_history_context(session_id: str, limit: int = 6) -> str:
    import sys
    import os
    sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from dbconfig.db import SessionLocal, ChatHistory
    db = SessionLocal()
    try:
        rows = (
            db.query(ChatHistory)
            .filter(ChatHistory.session_id == session_id)
            .order_by(desc(ChatHistory.id))
            .limit(limit + 1)
            .all()
        )
        
        if rows:
            history_rows = rows[1:]
        else:
            history_rows = []
            
        history_rows.reverse()
        
        history_lines = []
        for r in history_rows:
            role_label = "User" if r.role == "user" else "Assistant"
            history_lines.append(f"{role_label}: {r.content}")
            
        if history_lines:
            return "\n".join(history_lines) + "\n"
        return ""
    except Exception as e:
        print(f"Error fetching memory history: {e}")
        return ""
    finally:
        db.close()
