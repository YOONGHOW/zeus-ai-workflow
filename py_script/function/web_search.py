import re
import asyncio
from html import escape
from typing import Any, Dict, List
from urllib.parse import urlparse
import httpx
from bs4 import BeautifulSoup
from ddgs import DDGS

SEARCH_RESULT_LIMIT = 5
MAX_CRAWLED_SOURCES = 3
MAX_MARKDOWN_CHARS_PER_SOURCE = 8000
BLOCKED_SEARCH_EXTENSIONS = (".pdf", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".zip")

def _is_direct_url(text: str) -> bool:
    """Check if the user message is a direct URL."""
    text = text.strip()
    return bool(re.match(r'^https?://', text, re.IGNORECASE))

def _extract_domain(url: str) -> str:
    try:
        return urlparse(url).netloc.lower()
    except Exception:
        return ""

def _is_useful_result(url: str) -> bool:
    lower_url = (url or "").lower()
    return bool(lower_url) and not lower_url.endswith(BLOCKED_SEARCH_EXTENSIONS)

def _dedupe_search_results(raw_results: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    unique_results: List[Dict[str, str]] = []
    seen_urls = set()

    for item in raw_results:
        url = (item.get("href") or item.get("url") or "").strip()
        if not _is_useful_result(url) or url in seen_urls:
            continue

        seen_urls.add(url)
        unique_results.append(
            {
                "title": (item.get("title") or item.get("source") or "Untitled result").strip(),
                "url": url,
                "snippet": (item.get("body") or item.get("snippet") or "").strip(),
                "domain": _extract_domain(url),
            }
        )

        if len(unique_results) >= SEARCH_RESULT_LIMIT:
            break

    return unique_results

async def _crawl_url(url: str) -> str:
    from .api_client import ZeusAPIClient
    try:
        response_text = await ZeusAPIClient.get_instance().crawl_url(url)
        if not response_text:
            return ""
        
        soup = BeautifulSoup(response_text, 'html.parser')
        
        # Remove scripts, styles, nav, footer, iframe, header
        for element in soup(["script", "style", "nav", "footer", "header", "iframe", "aside"]):
            element.decompose()
            
        # Get text and clean it up
        lines = []
        for element in soup.find_all(['h1', 'h2', 'h3', 'h4', 'p', 'li']):
            text = element.get_text().strip()
            if not text:
                continue
            # Add basic markdown formatting
            if element.name in ['h1', 'h2', 'h3', 'h4']:
                lines.append(f"\n# {text}\n")
            elif element.name == 'li':
                lines.append(f"* {text}")
            else:
                lines.append(text)
        
        # Join lines with newlines
        content = "\n".join(lines)
        # Remove multiple consecutive blank lines
        content = re.sub(r'\n+', '\n', content).strip()
        return content
    except Exception as e:
        print(f"[Zeus Tool] Web scraping failed for {url}: {e}")
        return ""

async def _crawl_result(search_result: Dict[str, str]) -> Dict[str, str]:
    try:
        content = await _crawl_url(search_result["url"])
        if content:
            return {
                **search_result,
                "content": content[:MAX_MARKDOWN_CHARS_PER_SOURCE],
                "status": "crawled",
            }
        else:
            raise RuntimeError("Scrape returned empty content")
    except Exception:
        return {
            **search_result,
            "content": search_result["snippet"],
            "status": "snippet_only",
        }

def _fallback_search_html(query: str, sources: List[Dict[str, str]]) -> str:
    if not sources:
        return (
            "<h3>Web Search Results</h3>"
            f"<p>No useful public sources were found for <strong>{escape(query)}</strong>.</p>"
        )

    points = []
    links = []
    for source in sources:
        points.append(
            f"<li><strong>{escape(source['title'])}</strong> [{escape(source['domain'] or 'Source')}]"
            f"<br>{escape(source.get('snippet') or 'No preview text was available.')}</li>"
        )
        links.append(
            f"<li><a href=\"{escape(source['url'])}\" target=\"_blank\" rel=\"noopener noreferrer\">"
            f"{escape(source['title'])}</a></li>"
        )

    return (
        f"<h3>Web Search Results for {escape(query)}</h3>"
        "<p>I found relevant sources, but the AI synthesis step was unavailable. Here are the top matches.</p>"
        f"<ul>{''.join(points)}</ul>"
        "<h3>Sources</h3>"
        f"<ul>{''.join(links)}</ul>"
    )

async def _crawl_direct_url(url: str) -> Dict[str, str]:
    """Crawl a single URL directly and return its content."""
    try:
        content = await _crawl_url(url)
        return {
            "title": "Page",
            "url": url,
            "domain": _extract_domain(url),
            "content": content[:MAX_MARKDOWN_CHARS_PER_SOURCE] if content else "",
            "status": "crawled" if content else "failed",
        }
    except Exception as exc:
        print(f"[Zeus Tool] Direct crawl failed: {exc}")
        return {
            "title": "Page",
            "url": url,
            "domain": _extract_domain(url),
            "content": "",
            "status": "failed",
        }

async def execute_web_search(query: str) -> str:
    # Import load_prompt and call_apifreellm inside the function to avoid circular imports.
    from py_script.server import load_prompt, call_apifreellm

    print(f"[Zeus Tool] Multi-source web search: {query}")
    try:
        # --- DIRECT URL HANDLING ---
        # If the user pasted a URL directly, crawl it instead of searching
        if _is_direct_url(query):
            print(f"[Zeus Tool] Detected direct URL, crawling: {query}")
            source = await _crawl_direct_url(query)

            if source["status"] == "failed" or not source["content"]:
                return (
                    f"<h3>Page Extraction Failed</h3>"
                    f"<p>I was unable to extract content from <a href=\"{escape(query)}\" target=\"_blank\">{escape(query)}</a>.</p>"
                    f"<p>The site may be blocking automated access, or the page may require login.</p>"
                )

            # Synthesize the crawled content using Gemini
            prompt_template = load_prompt("webSearchPrompt.md").strip()
            system_prompt = prompt_template if prompt_template else (
                "You are Zeus. Always format your response in clean HTML only."
            )

            try:
                full_prompt = (
                    f"{system_prompt}\n\n"
                    f"The user wants to know about this page: {query}\n\n"
                    f"Page Title: {source['title']}\n"
                    f"URL: {source['url']}\n\n"
                    "Extracted Page Content:\n"
                    f"{source['content']}\n\n"
                    "Please summarize the key information from this page in clean HTML format. "
                    "Include the source URL at the end."
                )
                response_text = await call_apifreellm(full_prompt)
                if response_text and not response_text.startswith("Error"):
                    return response_text
            except Exception as exc:
                print(f"[Zeus Tool] URL synthesis failed: {exc}")

            # Fallback: return raw content
            return (
                f"<h3>{escape(source['title'])}</h3>"
                f"<p><a href=\"{escape(query)}\" target=\"_blank\">{escape(query)}</a></p>"
                f"<div>{escape(source['content'][:3000])}</div>"
            )

        # --- NORMAL SEARCH FLOW ---
        with DDGS() as ddgs:
            raw_results = [result for result in ddgs.text(query, max_results=SEARCH_RESULT_LIMIT)]

        search_results = _dedupe_search_results(raw_results)
        if not search_results:
            return (
                "<h3>Web Search Results</h3>"
                f"<p>No relevant public results were found for <strong>{escape(query)}</strong>.</p>"
            )

        crawled_sources = await asyncio.gather(
            *[_crawl_result(result) for result in search_results[:MAX_CRAWLED_SOURCES]]
        )

        combined_sources = crawled_sources + search_results[MAX_CRAWLED_SOURCES:]

        prompt_template = load_prompt("webSearchPrompt.md").strip()
        system_prompt = (
            prompt_template
            if prompt_template
            else (
                "You are Zeus. Always format your response in clean HTML only. "
                "Use <h3> for the title, <p> for concise summary paragraphs, <ul><li> for key findings, "
                "and a final Sources section with clickable links. Base the answer only on the supplied search material."
            )
        )

        source_blocks = []
        for index, source in enumerate(combined_sources, start=1):
            source_blocks.append(
                "\n".join(
                    [
                        f"Source {index}: {source['title']}",
                        f"URL: {source['url']}",
                        f"Domain: {source['domain'] or 'Unknown'}",
                        f"Status: {source.get('status', 'search_only')}",
                        f"Snippet: {source.get('snippet', '')}",
                        "Content:",
                        source.get("content") or source.get("snippet") or "",
                    ]
                )
            )

        try:
            full_prompt = (
                f"{system_prompt}\n\n"
                f"User query: {query}\n\n"
                "Summarize the search material below. Use inline citations like [Source 1]. "
                "If sources disagree, say so briefly.\n\n"
                + "\n\n---\n\n".join(source_blocks)
            )
            response_text = await call_apifreellm(full_prompt)
            if response_text and not response_text.startswith("Error"):
                return response_text
        except Exception as exc:
            print(f"[Zeus Tool] Search synthesis failed, using fallback HTML: {exc}")

        return _fallback_search_html(query, combined_sources)
    except Exception as exc:
        return f"<h3>Web Search Error</h3><p>{escape(str(exc))}</p>"
