import os
import json
import urllib.parse
import httpx
from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session
from dbconfig.db import get_db, UserTable

google_auth_router = APIRouter()

def get_google_oauth_config():
    base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    oauth_json_path = os.path.join(base_dir, "oauth.json")
    if not os.path.exists(oauth_json_path):
        raise HTTPException(status_code=500, detail="oauth.json not found in root workspace")
    with open(oauth_json_path, "r") as f:
        config = json.load(f)
    return config["web"]

@google_auth_router.get("/auth/google/login")
async def google_login(userid: int, frontend_url: str = "http://localhost:5173"):
    try:
        config = get_google_oauth_config()
        client_id = config["client_id"]
        redirect_uri = config["redirect_uris"][0]
        
        scopes = [
            "https://www.googleapis.com/auth/userinfo.email",
            "https://www.googleapis.com/auth/gmail.send",
            "https://www.googleapis.com/auth/calendar"
        ]
        scope_str = " ".join(scopes)
        state = f"{userid}|{frontend_url}"
        params = {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": scope_str,
            "state": state,
            "access_type": "offline",
            "prompt": "consent select_account"
        }
        
        auth_url = "https://accounts.google.com/o/oauth2/auth?" + urllib.parse.urlencode(params)
        return RedirectResponse(url=auth_url)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Google OAuth initialization failed: {str(e)}")

@google_auth_router.get("/auth/google/callback")
async def google_callback(code: str = None, state: str = None, error: str = None, db: Session = Depends(get_db)):
    frontend_url = "http://localhost:5173"
    userid = None
    if state:
        parts = state.split("|", 1)
        if len(parts) == 2:
            userid_str, frontend_url = parts
            try:
                userid = int(userid_str)
            except ValueError:
                pass
        else:
            try:
                userid = int(state)
            except ValueError:
                pass

    if error:
        return RedirectResponse(url=f"{frontend_url}/src/public/html/main.html?error=" + urllib.parse.quote(error))
    if not code or not userid:
        return RedirectResponse(url=f"{frontend_url}/src/public/html/main.html?error=Invalid+callback+parameters")
        
    try:
        config = get_google_oauth_config()
        client_id = config["client_id"]
        client_secret = config["client_secret"]
        redirect_uri = config["redirect_uris"][0]
        
        token_url = "https://oauth2.googleapis.com/token"
        payload = {
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code"
        }
        
        async with httpx.AsyncClient() as client:
            res = await client.post(token_url, data=payload)
            if res.status_code != 200:
                raise Exception(f"Failed to exchange token: {res.text}")
            token_data = res.json()
            
            access_token = token_data.get("access_token")
            refresh_token = token_data.get("refresh_token")
            
            user_email = ""
            if access_token:
                userinfo_url = "https://www.googleapis.com/oauth2/v3/userinfo"
                headers = {"Authorization": f"Bearer {access_token}"}
                userinfo_res = await client.get(userinfo_url, headers=headers)
                if userinfo_res.status_code == 200:
                    userinfo_data = userinfo_res.json()
                    user_email = userinfo_data.get("email", "")
                
        if user_email:
            existing_conn = db.query(UserTable).filter(
                UserTable.google_email == user_email,
                UserTable.userid != userid
            ).first()
            if existing_conn:
                return RedirectResponse(
                    url=f"{frontend_url}/src/public/html/main.html?error=" + 
                    urllib.parse.quote(f"This Google account ({user_email}) is already connected to another user.")
                )

        user = db.query(UserTable).filter(UserTable.userid == userid).first()
        if not user:
            return RedirectResponse(url=f"{frontend_url}/src/public/html/main.html?error=User+not+found")
            
        user.google_connected = 1
        if refresh_token:
            user.google_refresh_token = refresh_token
        if user_email:
            user.google_email = user_email
        db.commit()
        
        return RedirectResponse(url=f"{frontend_url}/src/public/html/main.html?oauth=success")
        
    except Exception as e:
        return RedirectResponse(url=f"{frontend_url}/src/public/html/main.html?error={urllib.parse.quote(str(e))}")
