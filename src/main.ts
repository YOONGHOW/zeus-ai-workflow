import { initializeOCRPage } from './ocrLogic';
import './notification';
import { initializeZeusChat } from './mcpLogic';
import { initializeTaskAllocation, loadGeneratedWorkflow } from './taskAllocationLogic';
import { initializeDocumentsPage } from './documentLogic';

// Set global BASE_URL for dynamically loaded HTML files (setting.html, etc.)
const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8080';
(window as any).BASE_URL = BASE_URL;

// --- GLOBAL NETWORK & SERVER HEALTH MONITORING ---
const originalFetch = window.fetch;
(window as any).fetch = async function(input: RequestInfo | URL, init?: RequestInit) {
    try {
        return await originalFetch(input, init);
    } catch (error) {
        if (!navigator.onLine) {
            window.location.href = '/src/public/html/error.html?type=offline';
        } else {
            const urlString = typeof input === 'string' ? input : (input instanceof Request ? input.url : '');
            if (urlString.includes(BASE_URL) || urlString.startsWith('/api/') || urlString.startsWith('/auth/') || urlString.startsWith('/zeus/')) {
                window.location.href = '/src/public/html/error.html?type=server_offline';
            }
        }
        throw error;
    }
};

window.addEventListener('offline', () => {
    window.location.href = '/src/public/html/error.html?type=offline';
});

if (!navigator.onLine) {
    window.location.href = '/src/public/html/error.html?type=offline';
} else {
    const checkInitialServerHealth = async () => {
        try {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), 3000);
            const res = await originalFetch(`${BASE_URL}/api/api_connections`, { signal: controller.signal });
            clearTimeout(id);
            if (!res.ok && res.status >= 500) {
                window.location.href = '/src/public/html/error.html?type=server_offline';
            }
        } catch (e) {
            window.location.href = '/src/public/html/error.html?type=server_offline';
        }
    };
    checkInitialServerHealth();
}

(window as any).initializeOCRPage = initializeOCRPage;
(window as any).initializeZeusChat = initializeZeusChat;
(window as any).initializeTaskAllocation = initializeTaskAllocation;
(window as any).loadGeneratedWorkflow = loadGeneratedWorkflow;
(window as any).initializeDocumentsPage = initializeDocumentsPage;

import { initializeInboxNotifications } from './notification';
document.addEventListener('DOMContentLoaded', () => {
    initializeInboxNotifications();
});