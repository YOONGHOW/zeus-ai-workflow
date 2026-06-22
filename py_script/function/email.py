import os
import ssl
import smtplib
import json
import base64
from email.message import EmailMessage

async def execute_send_email(to_email: str, subject: str, body: str, is_html: bool = False, userid: int = None) -> str:
    print(f"[Zeus Tool] Executing Send Email to: {to_email} (userid={userid})")
    
    if userid is None:
        return "Gmail integration is disabled. Please connect your Google Account and enable Email Integration in the Settings page."
        
    try:
        from dbconfig.db import SessionLocal, UserTable
        db = SessionLocal()
        user = db.query(UserTable).filter(UserTable.userid == userid).first()
        
        if not user or not user.google_connected or not user.email_enabled:
            if user:
                db.close()
            return "Gmail integration is disabled. Please connect your Google Account and enable Email Integration in the Settings page."
        
        refresh_token = user.google_refresh_token
        user_email = user.google_email
        db.close()
        
        if not refresh_token:
            return "Gmail credentials missing. Please reconnect your Google Account in the Settings page."
            
        # Load OAuth client details
        try:
            from auth.googleAuth import get_google_oauth_config
            config = get_google_oauth_config()
        except Exception as e:
            return f"Failed to get OAuth config: {str(e)}"

        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build

        creds = Credentials(
            token=None,
            refresh_token=refresh_token,
            token_uri=config["token_uri"],
            client_id=config["client_id"],
            client_secret=config["client_secret"]
        )

        service = build('gmail', 'v1', credentials=creds)

        message = EmailMessage()
        if is_html:
            message.set_content("Please enable HTML to view this email.")
            message.add_alternative(body, subtype='html')
        else:
            message.set_content(body)
        
        message['To'] = to_email
        message['From'] = user_email or "me"
        message['Subject'] = subject

        raw_message = base64.urlsafe_b64encode(message.as_bytes()).decode('utf-8')
        send_body = {'raw': raw_message}
        
        service.users().messages().send(userId='me', body=send_body).execute()
        print(f"[OK] Email sent successfully via Gmail API (User OAuth) to {to_email}")
        return f"Successfully sent email to {to_email} via Gmail API using your Google Account."
        
    except Exception as oauth_err:
        print(f"[Error] Gmail OAuth send failed: {oauth_err}")
        return f"Failed to send email via Google Account: {str(oauth_err)}"
