import os
from cryptography.fernet import Fernet

KEY_FILE = os.path.join(os.path.dirname(__file__), ".zeus.key")

def get_encryption_key() -> bytes:
    key_env = os.environ.get("ZEUS_ENCRYPTION_KEY")
    if key_env:
        try:
            Fernet(key_env.encode())
            return key_env.encode()
        except Exception:
            pass
            
    if os.path.exists(KEY_FILE):
        try:
            with open(KEY_FILE, "rb") as f:
                key = f.read().strip()
                Fernet(key) 
                return key
        except Exception:
            pass
            
    key = Fernet.generate_key()
    try:
        with open(KEY_FILE, "wb") as f:
            f.write(key)
    except Exception as e:
        print(f"[Crypto Warning] Could not save encryption key to file: {e}")
    return key

_key = get_encryption_key()
cipher = Fernet(_key)

def encrypt_val(val: str) -> str:
    if not val:
        return ""
    try:
        return cipher.encrypt(val.encode()).decode()
    except Exception as e:
        print(f"[Crypto Error] Encryption failed: {e}")
        return val

def decrypt_val(val: str) -> str:
    if not val:
        return ""
    try:
        return cipher.decrypt(val.encode()).decode()
    except Exception:
        return val
