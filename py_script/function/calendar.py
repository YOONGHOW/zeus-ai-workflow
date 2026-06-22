import os
import json

try:
    from googleapiclient.discovery import build
    from google.auth import default as google_auth_default
    HAS_GOOGLE_LIBS = True
except ImportError:
    HAS_GOOGLE_LIBS = False

async def insert_calendar_event_directly(event_data: dict, userid: int = None) -> bool:
    if not HAS_GOOGLE_LIBS:
        print("[Error] google-api-python-client not installed.")
        return False
        
    if userid is None:
        print("[Calendar Check] Disabled because userid is None")
        return False
        
    creds = None
    calendar_id = "primary"
    
    try:
        from dbconfig.db import SessionLocal, UserTable
        db = SessionLocal()
        user = db.query(UserTable).filter(UserTable.userid == userid).first()
        
        if not user or not user.google_connected or not user.calendar_enabled:
            print(f"[Calendar Check] Disabled or unconnected for userid {userid}")
            if user:
                db.close()
            return False
            
        refresh_token = user.google_refresh_token
        db.close()
        
        if not refresh_token:
            print(f"[Calendar Check] No refresh token found for userid {userid}")
            return False
            
        # Load OAuth client details
        try:
            from auth.googleAuth import get_google_oauth_config
            config = get_google_oauth_config()
        except Exception as e:
            print(f"[Calendar Check] Failed to get OAuth config: {e}")
            return False
        
        from google.oauth2.credentials import Credentials
        creds = Credentials(
            token=None,
            refresh_token=refresh_token,
            token_uri=config["token_uri"],
            client_id=config["client_id"],
            client_secret=config["client_secret"]
        )
        calendar_id = "primary"
        print(f"[OK] Using User OAuth Credentials for calendar insertion.")
    except Exception as oauth_err:
        print(f"[Error] Calendar OAuth setup failed: {oauth_err}")
        return False

    if not creds:
        print("[Error] No valid credentials for Calendar API.")
        return False

    try:
        service = build('calendar', 'v3', credentials=creds)

        import re
        def parse_datetime(dt_str: str) -> str:
            if not dt_str:
                return ""
            dt_str = dt_str.strip()
            if re.match(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:?\d{2})?$', dt_str):
                return dt_str
            m = re.match(r'^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$', dt_str)
            if m:
                suffix = 'Z' if m.group(7) else ''
                return f"{m.group(1)}-{m.group(2)}-{m.group(3)}T{m.group(4)}:{m.group(5)}:{m.group(6)}{suffix}"
            m_space = re.match(r'^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$', dt_str)
            if m_space:
                return f"{m_space.group(1)}-{m_space.group(2)}-{m_space.group(3)}T{m_space.group(4)}:{m_space.group(5)}:{m_space.group(6)}"
            digits = re.sub(r'\D', '', dt_str)
            if len(digits) >= 14:
                return f"{digits[:4]}-{digits[4:6]}-{digits[6:8]}T{digits[8:10]}:{digits[10:12]}:{digits[12:14]}"
            elif len(digits) >= 8:
                return f"{digits[:4]}-{digits[4:6]}-{digits[6:8]}T00:00:00"
            return dt_str

        start_time_parsed = parse_datetime(event_data.get('start_time', ''))
        end_time_parsed = parse_datetime(event_data.get('end_time', ''))

        # Fetch timezone dynamically
        try:
            cal_metadata = service.calendars().get(calendarId=calendar_id).execute()
            calendar_timezone = cal_metadata.get('timeZone', 'UTC')
        except Exception:
            calendar_timezone = 'UTC'

        body = {
            'summary': event_data.get('title', 'New Event'),
            'location': event_data.get('location', ''),
            'description': event_data.get('details', ''),
            'start': {
                'dateTime': start_time_parsed,
                'timeZone': calendar_timezone, 
            },
            'end': {
                'dateTime': end_time_parsed,
                'timeZone': calendar_timezone,
            },
        }
        
        service.events().insert(calendarId=calendar_id, body=body).execute()
        print("[OK] Event inserted successfully.")
        return True
    except Exception as e:
        print(f"Auto-add Calendar Error: {e}")
        return False
