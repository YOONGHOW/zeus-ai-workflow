import os
import httpx
from typing import List, Dict, Any, Optional

class ZeusAPIClient:
    _instance: Optional['ZeusAPIClient'] = None
    _client: Optional[httpx.AsyncClient] = None
    
    def __new__(cls, *args, **kwargs):
        if not cls._instance:
            cls._instance = super(ZeusAPIClient, cls).__new__(cls, *args, **kwargs)
        return cls._instance

    def __init__(self):
        if self._client is None:
            self.api_key = os.getenv("GEMINI_API_KEY", "")
            self._client = httpx.AsyncClient(timeout=120.0, follow_redirects=True)

    @classmethod
    def get_instance(cls) -> 'ZeusAPIClient':
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self.api_key = os.getenv("GEMINI_API_KEY", "")
            self._client = httpx.AsyncClient(timeout=120.0, follow_redirects=True)
        return self._client

    async def close(self):
        if self._client:
            await self._client.aclose()
            self._client = None

    async def generate_content(
        self,
        prompt: str,
        system_instruction: Optional[str] = None,
        response_mime_type: Optional[str] = None,
        temperature: float = 0.6,
        token_holder: Optional[dict] = None
    ) -> str:
        try:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={self.api_key}"
            headers = {"Content-Type": "application/json"}
            data = {
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {
                    "temperature": temperature
                }
            }
            if system_instruction:
                data["systemInstruction"] = {
                    "parts": [{"text": system_instruction}]
                }
            if response_mime_type:
                data["generationConfig"]["responseMimeType"] = response_mime_type

            response = await self.client.post(url, headers=headers, json=data)
            if response.status_code == 200:
                result = response.json()
                if token_holder is not None and "usageMetadata" in result:
                    usage = result["usageMetadata"]
                    token_holder["prompt_tokens"] = usage.get("promptTokenCount", 0)
                    token_holder["completion_tokens"] = usage.get("candidatesTokenCount", 0)
                    token_holder["total_tokens"] = usage.get("totalTokenCount", 0)
                return result["candidates"][0]["content"]["parts"][0]["text"]
            else:
                print(f"[Error] Gemini API Error: {response.text}")
                return "{}" if response_mime_type == "application/json" else f"[Error] LLM API Error: {response.text}"
        except Exception as e:
            print(f"[Error] Gemini API failure: {e}")
            return "{}" if response_mime_type == "application/json" else f"[Error] LLM Request failed: {e}"

    async def get_embedding(self, text: str) -> List[float]:
        try:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key={self.api_key}"
            headers = {"Content-Type": "application/json"}
            data = {
                "content": {
                    "parts": [{"text": text}]
                }
            }
            response = await self.client.post(url, headers=headers, json=data, timeout=30.0)
            if response.status_code == 200:
                result = response.json()
                return result["embedding"]["values"]
            else:
                print(f"[Error] Error fetching embedding: {response.text}")
                return []
        except Exception as e:
            print(f"[Error] Error fetching embedding: {e}")
            return []

    async def crawl_url(self, url: str) -> str:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
        try:
            response = await self.client.get(url, headers=headers, timeout=10.0)
            if response.status_code != 200:
                return ""
            return response.text
        except Exception as e:
            print(f"[Zeus Tool] Web scraping failed for {url}: {e}")
            return ""
