import os
import requests
from dotenv import load_dotenv
from firebase_admin import auth, _apps
from dbconfig.firebase import initialize_firebase

base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
env_path = os.path.join(base_dir, '.env')
load_dotenv(dotenv_path=env_path)

FIREBASE_API_KEY = os.getenv("FIREBASE_API_KEY", "")

def create_firebase_user(email: str, password: str):
    initialize_firebase()
    try:
        user = auth.create_user(
            email=email,
            password=password
        )
        return {"status": "success", "uid": user.uid}
    except Exception as e:
        print(f"[Firebase Error] Failed to create user: {e}")
        return {"status": "error", "message": str(e)}

def verify_firebase_login(email: str, password: str):
    if not FIREBASE_API_KEY or FIREBASE_API_KEY == "YOUR_FIREBASE_API_KEY_HERE":
        print("[Firebase Error] FIREBASE_API_KEY is not set or invalid.")
        return {"status": "error", "message": "FIREBASE_API_KEY is not configured on the server."}
        
    url = f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={FIREBASE_API_KEY}"
    payload = {
        "email": email,
        "password": password,
        "returnSecureToken": True
    }
    
    try:
        response = requests.post(url, json=payload)
        data = response.json()
        
        if "error" in data:
            print(f"[Firebase Auth Error] {data['error']['message']}")
            return {"status": "error", "message": data['error']['message']}
            
        return {
            "status": "success", 
            "idToken": data.get("idToken"), 
            "email": data.get("email"), 
            "uid": data.get("localId")
        }
    except Exception as e:
        print(f"[Firebase Login Exception] {e}")
        return {"status": "error", "message": str(e)}
