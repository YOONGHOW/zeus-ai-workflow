import os
import firebase_admin
from firebase_admin import credentials, storage
from dotenv import load_dotenv

base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
env_path = os.path.join(base_dir, '.env')
load_dotenv(dotenv_path=env_path)

FIREBASE_STORAGE_BUCKET = os.getenv("FIREBASE_STORAGE_BUCKET")

def initialize_firebase():
    if not firebase_admin._apps:
        service_account_env = os.getenv("SERVICE_ACCOUNT_JSON")
        print(f"[Debug] SERVICE_ACCOUNT_JSON env var present: {service_account_env is not None}")
        if service_account_env:
            import json
            try:
                cred_dict = json.loads(service_account_env)
                cred = credentials.Certificate(cred_dict)
                firebase_admin.initialize_app(cred, {
                    'storageBucket': FIREBASE_STORAGE_BUCKET
                })
                print("[OK] Firebase initialized using SERVICE_ACCOUNT_JSON environment variable.")
                return
            except Exception as e:
                print(f"[Error] Failed to parse SERVICE_ACCOUNT_JSON env var: {e}")
                raise e
        
        cred_path = os.path.join(base_dir, "service_account.json")
        if os.path.exists(cred_path):
            cred = credentials.Certificate(cred_path)
            firebase_admin.initialize_app(cred, {
                'storageBucket': FIREBASE_STORAGE_BUCKET
            })
            print(f"[OK] Firebase initialized using local file: {cred_path}")
        else:
            print(f"[Info] service_account.json not found at {cred_path}. Initializing with Application Default Credentials (ADC).")
            firebase_admin.initialize_app(options={
                'storageBucket': FIREBASE_STORAGE_BUCKET
            })

def upload_file_to_firebase(file_bytes: bytes, destination_blob_name: str, content_type: str = "application/octet-stream") -> str:
    initialize_firebase()
    bucket = storage.bucket()
    blob = bucket.blob(destination_blob_name)
    blob.upload_from_string(file_bytes, content_type=content_type)
    return destination_blob_name

def download_file_from_firebase(destination_blob_name: str) -> bytes:
    initialize_firebase()
    bucket = storage.bucket()
    blob = bucket.blob(destination_blob_name)
    if blob.exists():
        return blob.download_as_bytes()
    return None

def get_file_url(destination_blob_name: str) -> str:
    import datetime
    initialize_firebase()
    bucket = storage.bucket()
    blob = bucket.blob(destination_blob_name)
    if blob.exists():
        return blob.generate_signed_url(version="v4", expiration=datetime.timedelta(hours=1), method="GET")
    return None
