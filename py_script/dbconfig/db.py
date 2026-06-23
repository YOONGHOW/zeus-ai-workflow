import os
from dotenv import load_dotenv
from sqlalchemy import Column, Integer, String, create_engine, LargeBinary, Text, ForeignKey, DateTime, JSON
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship
from sqlalchemy.sql import func

base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
env_path = os.path.join(base_dir, '.env')
load_dotenv(dotenv_path=env_path)

DATABASE_URL = os.getenv("DATABASE_URL")

engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

def create_readonly_engine(connection_str: str, db_type: str = ""):
    connect_args = {"connect_timeout": 5}
    db_type_lower = db_type.lower() if db_type else ""
    
    if "sqlite" in connection_str or "sqlite" in db_type_lower:
        connect_args["timeout"] = 5  
        connect_args["uri"] = True
        if "mode=" not in connection_str:
            if "?" in connection_str:
                connection_str += "&mode=ro"
            else:
                connection_str += "?mode=ro"
    elif "postgresql" in connection_str or "postgres" in db_type_lower:
        connect_args["options"] = "-c statement_timeout=5000"
    readonly_engine = create_engine(connection_str, connect_args=connect_args)
    
    from sqlalchemy import event
    @event.listens_for(readonly_engine, "connect")
    def set_readonly_and_timeout(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        try:
            if "postgresql" in connection_str or "postgres" in db_type_lower:
                cursor.execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;")
                cursor.execute("SET statement_timeout = 5000;")
            elif "mysql" in connection_str or "mysql" in db_type_lower:
                cursor.execute("SET SESSION TRANSACTION READ ONLY;")
                cursor.execute("SET max_execution_time = 5000;")
        except Exception as e:
            print(f"[Sandbox Database Security] Connection parameters note: {e}")
        finally:
            cursor.close()
            
    return readonly_engine

class UserTable(Base):
    __tablename__ = "client"
    
    userid = Column(Integer, primary_key=True, index=True, autoincrement=True)
    email = Column(String, unique=True, index=True)
    password = Column(String)
    role = Column(String, default="user")
    token_usage = Column(Integer, default=0)
    last_reset_date = Column(DateTime(timezone=True), server_default=func.now())
    
    # Integrations
    google_connected = Column(Integer, default=0) # 0 = false, 1 = true
    email_enabled = Column(Integer, default=0)
    calendar_enabled = Column(Integer, default=0)
    google_refresh_token = Column(String, nullable=True)
    google_email = Column(String, nullable=True)

class FileTable(Base):
    __tablename__ = "files_info"
    
    file_id = Column(String, primary_key=True)
    filename = Column(String)
    firebase_url = Column(String, nullable=True)
    mime_type = Column(String)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    status = Column(String, default="uploaded")
    ocr_text = Column(Text)
    ocr_details = Column(JSON)
    extracted_data = Column(JSON)
    session_id = Column(String)
    userid = Column(Integer, ForeignKey("client.userid"), nullable=True)



class ChatSession(Base):
    __tablename__ = "chat_sessions"
    
    id = Column(String, primary_key=True)
    title = Column(String, default="New chat")
    type = Column(String, default="chat")
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())
    userid = Column(Integer, ForeignKey("client.userid"), index=True)
    
    # Relationship to messages
    messages = relationship("ChatHistory", back_populates="session", cascade="all, delete-orphan")

class ChatHistory(Base):
    __tablename__ = "chat_history_pg"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String, ForeignKey("chat_sessions.id", ondelete="CASCADE"), nullable=False, index=True)
    role = Column(String, nullable=False)
    content = Column(Text, nullable=False)
    mode = Column(String, default="Auto")
    timestamp = Column(DateTime(timezone=True), server_default=func.now())
    
    session = relationship("ChatSession", back_populates="messages")

class ApiConn(Base):
    __tablename__ = "api_conn"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(150), nullable=False)
    api_url = Column(String, nullable=False)
    description = Column(Text)
    parameter = Column(Text)
    method = Column(String, default="GET")
    _api_key = Column("api_key", String)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())

    @property
    def api_key(self):
        from dbconfig.crypto import decrypt_val
        return decrypt_val(self._api_key)

    @api_key.setter
    def api_key(self, val):
        from dbconfig.crypto import encrypt_val
        self._api_key = encrypt_val(val)

class DbConn(Base):
    __tablename__ = "db_conn"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(150), nullable=False)
    database_name = Column(String(150))
    _connection_str = Column("connection_str", String)
    type = Column(String)
    description = Column(Text)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())

    @property
    def connection_str(self):
        from dbconfig.crypto import decrypt_val
        return decrypt_val(self._connection_str)

    @connection_str.setter
    def connection_str(self, val):
        from dbconfig.crypto import encrypt_val
        self._connection_str = encrypt_val(val)

class ScheduledTask(Base):
    __tablename__ = "workflow_schedules"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    workflow_id = Column(String, nullable=False)
    cron_expression = Column(String, nullable=False)
    payload_data = Column(JSON)
    is_active = Column(Integer, default=1)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now(), server_default=func.now())

class OcrCorrection(Base):
    __tablename__ = "ocr_corrections"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    file_id = Column(String, ForeignKey("files_info.file_id", ondelete="CASCADE"), nullable=False)
    field_name = Column(String, nullable=False)
    original_value = Column(String)
    corrected_value = Column(String, nullable=False)
    corrected_at = Column(DateTime(timezone=True), server_default=func.now())

class TaskNotification(Base):
    __tablename__ = "task_notification"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    userid = Column(Integer, ForeignKey("client.userid"), nullable=True, index=True)
    workflow_id = Column(String, nullable=False)
    workflow_name = Column(String, nullable=False)
    status = Column(String, nullable=False) # 'success' or 'failed'
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    is_read = Column(Integer, default=0)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def save_to_history(session_id: str, role: str, content: str, mode: str = "Auto"):
    try:
        db = SessionLocal()
        new_msg = ChatHistory(session_id=session_id, role=role, content=content, mode=mode)
        db.add(new_msg)
        db.commit()
        db.close()
    except Exception as e:
        print(f"[Error] Error saving to history: {e}")

def check_and_reset_tokens(user):
    import datetime
    now = datetime.datetime.now(datetime.timezone.utc)
    if not user.last_reset_date:
        user.last_reset_date = now
        return False
    
    # Check if we are in a new calendar month
    if user.last_reset_date.year < now.year or user.last_reset_date.month < now.month:
        user.token_usage = 0
        user.last_reset_date = now
        return True
    return False

def add_user_tokens(userid: int, tokens: int):
    if not userid:
        return
    try:
        db = SessionLocal()
        user = db.query(UserTable).filter(UserTable.userid == userid).first()
        if user:
            if user.token_usage is None:
                user.token_usage = 0
            check_and_reset_tokens(user)
            user.token_usage += tokens
            db.commit()
        db.close()
    except Exception as e:
        print(f"[Error] Error adding user tokens: {e}")

class TrackError(Base):
    __tablename__ = "track_error"
    
    id = Column(Integer, primary_key=True, autoincrement=True)
    component = Column(String)  # E.g., 'process_document_background', '/auth/login'
    error_message = Column(Text, nullable=False)
    stack_trace = Column(Text)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

def log_error_to_db(component: str, error_message: str, stack_trace: str = None):
    try:
        db = SessionLocal()
        new_error = TrackError(
            component=component, 
            error_message=error_message,
            stack_trace=stack_trace
        )
        db.add(new_error)
        db.commit()
        db.close()
    except Exception as e:
        print(f"[Fallback Error Logging] Failed to save to track_error: {e}")
