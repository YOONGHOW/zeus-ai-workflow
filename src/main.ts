import { initializeOCRPage } from './ocrLogic';
import './notification';
import { initializeZeusChat } from './mcpLogic';
import { initializeTaskAllocation, loadGeneratedWorkflow } from './taskAllocationLogic';
import { initializeDocumentsPage } from './documentLogic';

// Set global BASE_URL for dynamically loaded HTML files (setting.html, etc.)
(window as any).BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8080';

(window as any).initializeOCRPage = initializeOCRPage;
(window as any).initializeZeusChat = initializeZeusChat;
(window as any).initializeTaskAllocation = initializeTaskAllocation;
(window as any).loadGeneratedWorkflow = loadGeneratedWorkflow;
(window as any).initializeDocumentsPage = initializeDocumentsPage;