import { initializeOCRPage } from './ocrLogic';
import { showNotification, showConfirm } from './notification';

interface ZeusChatRequest {
    session_id: string;
    message: string;
    mode: string;
    file_ids: string[];
    system_instructions?: string;
    temperature?: number;
    tone?: string;
    api_conn_id?: number | null;
    db_conn_id?: number | null;
}

interface ZeusChatResponse {
    answer: string;
    tool_used: string | null;
}

let currentAttachedFileIds: string[] = [];
const currentAttachedFiles = new Map<string, File>();

export function initializeZeusChat() {
    console.log("Initializing Zeus Bot Logic...");
    const BASE_URL = import.meta.env.VITE_API_BASE_URL;
    let currentSessionId: string | null = null;
    let pendingSessionType: string = 'chat';

    // --- UI ELEMENTS ---
    const chatInput = document.querySelector('.mcp-input') as HTMLTextAreaElement;
    const sendBtn = document.querySelector('.mcp-send-btn') as HTMLButtonElement;
    const chatBody = document.querySelector('.mcp-chat-body') as HTMLDivElement;
    const fileInput = document.getElementById('mcpFileInput') as HTMLInputElement;
    const fileBtn = document.getElementById('mcpFileBtn') as HTMLButtonElement;
    const previewBar = document.getElementById('mcpFilePreviewBar') as HTMLDivElement;
    const extractorDrawer = document.getElementById('zeusExtractorDrawer') as HTMLElement | null;
    const extractorCollapseBtn = document.getElementById('extractorCollapseBtn') as HTMLButtonElement | null;



    // Source Selection Elements (combined API + Database)
    const sourceSelectBtn = document.getElementById('plusSourceBtn') as HTMLButtonElement;
    const sourceSelectPopup = document.getElementById('sourceSelectPopup') as HTMLDivElement;
    const sourceSelectOverlay = document.getElementById('sourceSelectOverlay') as HTMLDivElement;
    const sourceApiList = document.getElementById('sourceApiList') as HTMLDivElement;
    const sourceDbList = document.getElementById('sourceDbList') as HTMLDivElement;
    const sourceApiCount = document.getElementById('sourceApiCount') as HTMLSpanElement;
    const sourceDbCount = document.getElementById('sourceDbCount') as HTMLSpanElement;
    const sourceSelectEmpty = document.getElementById('sourceSelectEmpty') as HTMLDivElement;
    const sourceSelectClose = document.getElementById('sourceSelectClose') as HTMLButtonElement;
    const sourceActiveBadge = document.getElementById('sourceActiveBadge') as HTMLButtonElement;
    const sourceActiveIcon = document.getElementById('sourceActiveIcon') as HTMLElement;
    const sourceActiveName = document.getElementById('sourceActiveName') as HTMLSpanElement;
    const sourceActiveClear = document.getElementById('sourceActiveClear') as HTMLSpanElement;

    const mcpPlusDropdown = document.getElementById('mcpPlusDropdown') as HTMLDivElement;
    const plusUploadBtn = document.getElementById('plusUploadBtn') as HTMLDivElement;
    const plusWorkflowBtn = document.getElementById('plusWorkflowBtn') as HTMLDivElement;
    const workflowModeBadge = document.getElementById('workflowModeBadge') as HTMLDivElement;
    const workflowModeClear = document.getElementById('workflowModeClear') as HTMLElement;

    let isWorkflowMode = false;
    let selectedSource: { type: 'api' | 'database'; id: number; label: string } | null = null;
    let allApis: any[] = [];
    let allDatabases: any[] = [];
    let apiEditingId: number | null = null;

    if (!chatInput || !sendBtn || !chatBody) {
        console.warn("Zeus Bot UI elements not found.");
        return;
    }

    // --- CONFIG BOARD ELEMENTS ---
    const configBoard = document.getElementById('cbConfigBoard') as HTMLDivElement;
    const configToggleBtn = document.getElementById('cbConfigToggle') as HTMLButtonElement;
    const closeConfigBtn = document.getElementById('cbCloseConfig') as HTMLButtonElement;
    const saveConfigBtn = document.getElementById('cbSaveConfig') as HTMLButtonElement;
    const cfgRole = document.getElementById('cfgRole') as HTMLTextAreaElement;
    const cfgTemp = document.getElementById('cfgTemp') as HTMLInputElement;
    const cbFileUpload = document.getElementById('cbFileUpload') as HTMLInputElement;
    const cbFileList = document.getElementById('fileList') as HTMLDivElement;
    const cbFileCount = document.getElementById('fileCount') as HTMLSpanElement;

    // API Config Form Elements
    const apiConfigToggle = document.getElementById('apiConfigToggle') as HTMLButtonElement;
    const apiConfigPanel = document.getElementById('apiConfigPanel') as HTMLDivElement;
    const apiConfigOverlay = document.getElementById('apiConfigOverlay') as HTMLDivElement;
    const apiConfigClose = document.getElementById('apiConfigClose') as HTMLButtonElement;
    const contentApi = document.getElementById('contentApi') as HTMLDivElement;

    const apiCreateNew = document.getElementById('apiCreateNew') as HTMLButtonElement;
    const apiConnListContainer = document.getElementById('apiConnList') as HTMLDivElement;
    const apiNameInput = document.getElementById('apiName') as HTMLInputElement;
    const apiMethodInput = document.getElementById('apiMethod') as HTMLSelectElement;
    const apiUrlInput = document.getElementById('apiUrl') as HTMLInputElement;
    const apiKeyInput = document.getElementById('apiKey') as HTMLInputElement;
    const apiParamsInput = document.getElementById('apiParams') as HTMLTextAreaElement;
    const apiDescInput = document.getElementById('apiDesc') as HTMLInputElement;
    const apiSaveBtn = document.getElementById('apiSaveBtn') as HTMLButtonElement;
    const apiCancelFormBtn = document.getElementById('apiCancelForm') as HTMLButtonElement;



    let kbFilesToUpload: File[] = [];
    let sessionUploadedFiles: any[] = [];
    let extractorInitialized = false;
    let documentExtractorSelected = false;

    function syncExtractorDrawer(expanded: boolean) {
        if (!extractorDrawer) return;

        const canShowExtractor = documentExtractorSelected;
        const isExpanded = expanded && canShowExtractor;

        extractorDrawer.classList.toggle('active', isExpanded);
        extractorDrawer.setAttribute('aria-hidden', String(!isExpanded));

        if (canShowExtractor && !extractorInitialized) {
            initializeOCRPage();
            extractorInitialized = true;
        }
    }

    function setDocumentExtractorSelected(selected: boolean, expand = false) {
        documentExtractorSelected = selected;
        syncExtractorDrawer(expand);
    }

    function openDocumentExtractorView() {
        setDocumentExtractorSelected(true, true);
    }

    function resetToolChips() {
        setDocumentExtractorSelected(false);
    }

    if (extractorCollapseBtn) {
        extractorCollapseBtn.addEventListener('click', () => syncExtractorDrawer(false));
    }

    syncExtractorDrawer(false);

    function getChatbotConfigKey(): string {
        try {
            const userStr = localStorage.getItem('zeusUser');
            if (userStr) {
                const user = JSON.parse(userStr);
                if (user && user.userid) {
                    return `zeus_chatbot_config_${user.userid}`;
                }
            }
        } catch (e) {
            console.error("Failed to parse user session for config:", e);
        }
        return 'zeus_chatbot_config';
    }

    // Load saved config
    function loadConfig() {
        const key = getChatbotConfigKey();
        let saved = localStorage.getItem(key);
        if (!saved && key !== 'zeus_chatbot_config') {
            const legacySaved = localStorage.getItem('zeus_chatbot_config');
            if (legacySaved) {
                localStorage.setItem(key, legacySaved);
                saved = legacySaved;
                localStorage.removeItem('zeus_chatbot_config');
            }
        }
        if (saved) {
            try {
                const config = JSON.parse(saved);
                if (cfgRole) cfgRole.value = config.role || '';
                if (cfgTemp) cfgTemp.value = config.temperature?.toString() || '0.7';
            } catch (e) {
                console.error("Failed to parse zeus config", e);
            }
        }
    }

    function showWelcome() {
        if (!chatBody) return;
        chatBody.innerHTML = `
            <div class="gemini-welcome-container" id="welcomeContainer">
              <div class="greeting"><span class="gradient-text">Hello,</span></div>
              <div class="greeting-subtitle">How can I help you today?</div>
            </div>`;
    }



    function applySessionType(type: string) {
        pendingSessionType = type;
        const configBtn = document.getElementById('cbConfigToggle');
        if (configBtn) {
            configBtn.style.display = type === 'project' ? 'inline-flex' : 'none';
        }
        const kbGroup = document.getElementById('cbKbGroup');
        if (kbGroup) {
            kbGroup.style.display = type === 'project' ? 'block' : 'none';
        }
        if (apiConfigToggle) {
            apiConfigToggle.style.display = type === 'project' ? 'none' : 'flex';
        }
        if (mcpPlusDropdown) {
            mcpPlusDropdown.style.display = 'none';
        }
        if (sourceSelectPopup) {
            sourceSelectPopup.classList.remove('active');
            if (sourceSelectOverlay) sourceSelectOverlay.classList.remove('active');
        }
        updateSourceActiveState();
    }

    function loadSessions() {
        (window as any).currentSessionId = currentSessionId;
        if (typeof (window as any).loadSidebarSessions === 'function') {
            (window as any).loadSidebarSessions();
        }
    }

    function startNewChat(type: string = 'chat') {
        currentSessionId = null;
        pendingSessionType = type;
        applySessionType(type);
        resetToolChips();
        showWelcome();
        loadSessions();
        if (typeof (window as any).loadSidebarSessions === 'function') {
            (window as any).loadSidebarSessions();
        }
        if (typeof (window as any).clearZeusOCRWorkspace === 'function') {
            (window as any).clearZeusOCRWorkspace();
        }
    }
    (window as any).startNewZeusChat = startNewChat;

    async function loadHistory(sessionId: string, type?: string) {
        currentSessionId = sessionId;
        loadSessions();
        resetToolChips();
        if (typeof (window as any).clearZeusOCRWorkspace === 'function') {
            (window as any).clearZeusOCRWorkspace();
        }

        let sessionType = type;
        if (!sessionType) {
            try {
                const res = await fetch(`${BASE_URL}/zeus/sessions`);
                if (res.ok) {
                    const data = await res.json();
                    const session = data.sessions.find((s: any) => s.id === sessionId);
                    if (session) {
                        sessionType = session.type || 'chat';
                    }
                }
            } catch (e) {
                console.error("Error fetching session details:", e);
            }
        }
        applySessionType(sessionType || 'chat');

        try {
            const response = await fetch(`${BASE_URL}/zeus/history?session_id=${sessionId}`);
            const data = await response.json();
            if (chatBody) {
                chatBody.innerHTML = '';
                if (data.history && data.history.length > 0) {
                    data.history.forEach((msg: any) => {
                        appendMessage(msg.content, msg.role === 'user' ? 'user' : 'bot');
                    });
                } else {
                    showWelcome();
                }
            }
        } catch (err) {
            console.error("Failed to load history:", err);
        }
    }
    (window as any).loadHistory = loadHistory;

    loadConfig();
    const pendingSession = localStorage.getItem('pendingZeusSessionId');
    const pendingType = localStorage.getItem('pendingZeusSessionType');
    if (pendingSession) {
        localStorage.removeItem('pendingZeusSessionId');
        localStorage.removeItem('pendingZeusSessionType');
        loadHistory(pendingSession, pendingType || undefined);
    } else if (pendingType) {
        localStorage.removeItem('pendingZeusSessionType');
        startNewChat(pendingType);
    } else {
        if (chatBody && chatBody.innerHTML.trim() === '') {
            showWelcome();
        }
        applySessionType('chat');
        loadSessions();
    }

    if (configToggleBtn && configBoard) {
        configToggleBtn.onclick = async () => {
            configBoard.classList.add('active');
            sessionUploadedFiles = [];
            renderKbFiles();

            if (currentSessionId) {
                try {
                    const res = await fetch(`${BASE_URL}/zeus/session_documents?session_id=${currentSessionId}`);
                    if (res.ok) {
                        sessionUploadedFiles = await res.json();
                        renderKbFiles();
                    }
                } catch (e) {
                    console.error("Failed to load session documents:", e);
                }
            }
        };
    }
    if (closeConfigBtn && configBoard) {
        closeConfigBtn.onclick = () => configBoard.classList.remove('active');
    }

    if (saveConfigBtn) {
        saveConfigBtn.onclick = async () => {
            saveConfigBtn.innerText = "Saving...";
            saveConfigBtn.disabled = true;

            const config = {
                role: cfgRole.value,
                temperature: parseFloat(cfgTemp.value)
            };
            localStorage.setItem(getChatbotConfigKey(), JSON.stringify(config));

            if (!currentSessionId) {
                try {
                    const user = JSON.parse(localStorage.getItem('zeusUser') || 'null');
                    const res = await fetch(`${BASE_URL}/zeus/sessions`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ type: pendingSessionType, userid: user ? user.userid : null })
                    });
                    if (res.ok) {
                        const data = await res.json();
                        currentSessionId = data.id;
                        (window as any).currentSessionId = currentSessionId;
                        loadSessions();

                        if (chatBody) {
                            if (kbFilesToUpload.length > 0) {
                                chatBody.innerHTML = `
                                    <div class="mcp-message bot">
                                        <div class="mcp-bubble" style="padding-left: 20px; border-left: 3px solid rgba(99, 102, 241, 0.3);">
                                            <div>✨ <strong>Workspace initialized!</strong> I've uploaded the following documents:</div>
                                            <div style="margin: 8px 0; display: flex; flex-direction: column; gap: 4px;">
                                                ${kbFilesToUpload.map(f => {
                                    let iconClass = 'fa-solid fa-file';
                                    if (f.name.endsWith('.pdf')) iconClass = 'fa-solid fa-file-pdf';
                                    else if (f.name.endsWith('.docx') || f.name.endsWith('.doc')) iconClass = 'fa-solid fa-file-word';
                                    else if (/\.(png|jpg|jpeg|webp|gif)$/i.test(f.name)) iconClass = 'fa-solid fa-file-image';
                                    return `<div class="chat-attachment-card" style="margin: 4px 0;"><i class="${iconClass}"></i><span>${f.name}</span></div>`;
                                }).join('')}
                                            </div>
                                            <div>Ask me anything about them.</div>
                                        </div>
                                    </div>`;
                            } else {
                                chatBody.innerHTML = `
                                    <div class="mcp-message bot">
                                        <div class="mcp-bubble" style="padding-left: 20px; border-left: 3px solid rgba(99, 102, 241, 0.3);">
                                            <div>✨ <strong>Workspace initialized!</strong> Ask me anything.</div>
                                        </div>
                                    </div>`;
                            }
                        }
                    }
                } catch (e) {
                    console.error("Failed to create session on save:", e);
                }
            }

            if (kbFilesToUpload.length > 0) {
                const formData = new FormData();
                kbFilesToUpload.forEach(f => formData.append('files', f));
                if (currentSessionId) {
                    formData.append('session_id', currentSessionId);
                }
                try {
                    await fetch(`${BASE_URL}/zeus/upload_kb`, {
                        method: 'POST',
                        body: formData
                    });
                    kbFilesToUpload = [];
                    renderKbFiles();
                } catch (e) {
                    console.error("Failed to upload KB files", e);
                    showNotification("Failed to upload Knowledge Base files.", "error");
                }
            }

            saveConfigBtn.innerText = "Save & Close";
            saveConfigBtn.disabled = false;
            if (configBoard) configBoard.classList.remove('active');
        };
    }


    function renderKbFiles() {
        if (!cbFileList || !cbFileCount) return;
        if (kbFilesToUpload.length === 0 && sessionUploadedFiles.length === 0) {
            cbFileList.innerHTML = '';
            cbFileList.style.display = 'none';
            cbFileCount.innerText = 'No files selected';
            return;
        }

        cbFileList.style.display = 'block';
        const totalCount = kbFilesToUpload.length + sessionUploadedFiles.length;
        cbFileCount.innerText = `${totalCount} file(s) in session`;

        let html = '';

        // 1. Render already uploaded files
        sessionUploadedFiles.forEach((f, idx) => {
            let iconClass = 'fa-solid fa-file';
            if (f.filename.endsWith('.pdf')) iconClass = 'fa-solid fa-file-pdf';
            else if (f.filename.endsWith('.docx') || f.filename.endsWith('.doc')) iconClass = 'fa-solid fa-file-word';
            else if (/\.(png|jpg|jpeg|webp|gif)$/i.test(f.filename)) iconClass = 'fa-solid fa-file-image';

            html += `
                <div class="file-item" style="display:flex; justify-content:space-between; align-items:center; background:#e2e8f0; padding:8px; border-radius:4px; margin-bottom:5px;">
                    <span class="file-name" style="font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:85%; font-weight: 500;">
                        <i class="${iconClass}" style="margin-right: 6px; color: #3b82f6;"></i>
                        ${f.filename} (Uploaded)
                    </span>
                    <button type="button" onclick="window.deleteUploadedKbFile('${f.file_id}', ${idx})" style="background:none; border:none; color:#ef4444; cursor:pointer;" title="Delete document"><i class="fas fa-trash"></i></button>
                </div>
            `;
        });

        // 2. Render queued files pending upload
        kbFilesToUpload.forEach((f, i) => {
            let iconClass = 'fa-solid fa-file';
            if (f.name.endsWith('.pdf')) iconClass = 'fa-solid fa-file-pdf';
            else if (f.name.endsWith('.docx') || f.name.endsWith('.doc')) iconClass = 'fa-solid fa-file-word';
            else if (/\.(png|jpg|jpeg|webp|gif)$/i.test(f.name)) iconClass = 'fa-solid fa-file-image';

            html += `
                <div class="file-item" style="display:flex; justify-content:space-between; align-items:center; background:#f1f5f9; padding:8px; border-radius:4px; margin-bottom:5px;">
                    <span class="file-name" style="font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:80%;">
                        <i class="${iconClass}" style="margin-right: 6px; color: #64748b;"></i>
                        ${f.name} (Pending)
                    </span>
                    <button type="button" onclick="window.removeKbFile(${i})" style="background:none; border:none; color:#ef4444; cursor:pointer;"><i class="fas fa-times"></i></button>
                </div>
            `;
        });

        cbFileList.innerHTML = html;
    }

    (window as any).removeKbFile = (index: number) => {
        kbFilesToUpload.splice(index, 1);
        renderKbFiles();
    };

    (window as any).deleteUploadedKbFile = async (fileId: string, index: number) => {
        if (!await showConfirm("Are you sure you want to delete this document from the knowledge base?")) return;

        try {
            const res = await fetch(`${BASE_URL}/zeus/documents/${fileId}`, {
                method: 'DELETE'
            });
            if (res.ok) {
                sessionUploadedFiles.splice(index, 1);
                renderKbFiles();
                showNotification("Document deleted successfully.", "success");
            } else {
                showNotification("Failed to delete document.", "error");
            }
        } catch (e) {
            console.error("Error deleting document:", e);
            showNotification("Error deleting document from server.", "error");
        }
    };

    if (cbFileUpload) {
        cbFileUpload.addEventListener('change', (e: any) => {
            if (e.target.files) {
                kbFilesToUpload = [...kbFilesToUpload, ...Array.from(e.target.files as FileList)];
                renderKbFiles();
            }
        });
    }

    // --- API LOGIC ---
    async function fetchApiList() {
        try {
            const response = await fetch(`${BASE_URL}/api/api_connections`);
            if (!response.ok) throw new Error('Failed to fetch APIs');
            allApis = await response.json();
            renderApiList();
        } catch (e) {
            console.error("Error fetching APIs:", e);
        }
    }

    function renderApiList() {
        if (!apiConnListContainer) return;
        apiConnListContainer.innerHTML = '';
        if (allApis.length === 0) {
            apiConnListContainer.innerHTML = '<div style="color:#64748b; font-size:12px;">No API connections added yet.</div>';
            return;
        }

        const userStr = localStorage.getItem('zeusUser');
        const user = userStr ? JSON.parse(userStr) : null;
        const isUser = user && user.role === 'user';

        allApis.forEach(api => {
            const item = document.createElement('div');
            item.className = 'db-conn-item';
            const metaText = isUser ? api.method : `${api.method} - ${api.url}`;
            item.innerHTML = `
                <div class="db-conn-item-icon"><i class="fa-solid fa-plug"></i></div>
                <div class="db-conn-item-info">
                    <div class="db-conn-item-name">${api.apiName || 'Unnamed'}</div>
                    <div class="db-conn-item-meta">${metaText}</div>
                </div>
                <div class="db-conn-actions user-role-hide">
                    <button class="db-conn-edit" title="Edit"><i class="fa-solid fa-pen"></i></button>
                    <button class="db-conn-del" title="Delete"><i class="fa-solid fa-trash"></i></button>
                </div>
            `;

            const actionsDiv = item.querySelector('.db-conn-actions') as HTMLElement;
            if (isUser && actionsDiv) {
                actionsDiv.style.display = 'none';
            }

            const editBtn = item.querySelector('.db-conn-edit') as HTMLButtonElement;
            editBtn.onclick = () => openApiForm(api);

            const deleteBtn = item.querySelector('.db-conn-del') as HTMLButtonElement;
            deleteBtn.onclick = () => deleteApi(api.id);

            apiConnListContainer.appendChild(item);
        });
    }

    // --- Combined Source Selection (API + Database) ---
    async function fetchAllSources() {
        try {
            const [apiRes, dbRes] = await Promise.all([
                fetch(`${BASE_URL}/api/api_connections`),
                fetch(`${BASE_URL}/api/db_connections`)
            ]);
            if (apiRes.ok) {
                allApis = await apiRes.json();
                renderApiList();
            }
            if (dbRes.ok) {
                const conns = await dbRes.json();
                const typeLabels: Record<string, string> = {
                    mysql: 'MySQL', postgresql: 'PostgreSQL', mssql: 'SQL Server',
                    sqlite: 'SQLite', mongodb: 'MongoDB'
                };
                allDatabases = conns
                    .filter((cfg: any) => cfg.type !== 'rest_api')
                    .map((cfg: any) => ({
                        id: cfg.id,
                        label: cfg.name || cfg.host || 'Configured DB',
                        dbType: typeLabels[cfg.type] || cfg.type || 'Database',
                        host: cfg.host || '',
                        name: cfg.database_name || ''
                    }));
            }
            renderSourceSelector();
        } catch (e) {
            console.error("Error fetching sources:", e);
        }
    }

    function renderSourceSelector() {
        if (!sourceApiList || !sourceDbList || !sourceSelectEmpty) return;

        sourceApiList.innerHTML = '';
        sourceDbList.innerHTML = '';

        const totalCount = allApis.length + allDatabases.length;
        const body = sourceSelectPopup?.querySelector('.source-select-body') as HTMLElement;

        if (totalCount === 0) {
            sourceSelectEmpty.style.display = 'flex';
            if (body) body.style.display = 'none';
            return;
        }

        sourceSelectEmpty.style.display = 'none';
        if (body) body.style.display = 'flex';

        if (sourceApiCount) sourceApiCount.textContent = String(allApis.length);
        if (sourceDbCount) sourceDbCount.textContent = String(allDatabases.length);

        // Render APIs
        const userStr = localStorage.getItem('zeusUser');
        const user = userStr ? JSON.parse(userStr) : null;
        const isUser = user && user.role === 'user';

        if (allApis.length === 0) {
            sourceApiList.innerHTML = '<div class="source-column-empty"><i class="fa-solid fa-plug"></i><span>No APIs configured</span></div>';
        } else {
            allApis.forEach((api: any) => {
                const isSelected = selectedSource && selectedSource.type === 'api' && selectedSource.id === api.id;
                const item = document.createElement('div');
                item.className = `db-select-item${isSelected ? ' selected' : ''}`;
                const metaText = isUser ? (api.method || '') : `${api.method || ''} ${api.url || ''}`;
                item.innerHTML = `
                    <div class="db-select-item-icon type-api"><i class="fa-solid fa-plug"></i></div>
                    <div class="db-select-item-info">
                        <div class="db-select-item-name">${api.apiName || 'Unnamed'}</div>
                        <div class="db-select-item-meta">${metaText}</div>
                    </div>
                    <div class="db-select-check" style="${isSelected ? '' : 'display:none;'}"><i class="fa-solid fa-check"></i></div>
                `;
                item.onclick = () => {
                    selectedSource = { type: 'api', id: api.id, label: api.apiName || 'Unnamed' };
                    sourceSelectPopup.classList.remove('active');
                    if (sourceSelectOverlay) sourceSelectOverlay.classList.remove('active');
                    updateSourceActiveState();
                };
                sourceApiList.appendChild(item);
            });
        }

        // Render Databases
        if (allDatabases.length === 0) {
            sourceDbList.innerHTML = '<div class="source-column-empty"><i class="fa-solid fa-database"></i><span>No databases configured</span></div>';
        } else {
            const typeIcons: Record<string, string> = {
                'PostgreSQL': 'fa-solid fa-database',
                'MySQL': 'fa-solid fa-database',
                'SQL Server': 'fa-brands fa-microsoft',
                'MongoDB': 'fa-solid fa-leaf',
                'SQLite': 'fa-solid fa-database',
            };
            const typeClasses: Record<string, string> = {
                'PostgreSQL': 'type-postgres',
                'MySQL': 'type-mysql',
                'SQL Server': 'type-mssql',
                'MongoDB': 'type-mongodb',
                'SQLite': 'type-sqlite',
            };

            allDatabases.forEach((db: any) => {
                const isSelected = selectedSource && selectedSource.type === 'database' && selectedSource.id === db.id;
                const item = document.createElement('div');
                item.className = `db-select-item${isSelected ? ' selected' : ''}`;
                const iconClass = typeIcons[db.dbType] || 'fa-solid fa-database';
                const typeClass = typeClasses[db.dbType] || 'type-default';
                const metaText = isUser ? db.dbType : `${db.dbType}${db.host ? ' · ' + db.host : ''}`;
                item.innerHTML = `
                    <div class="db-select-item-icon ${typeClass}"><i class="${iconClass}"></i></div>
                    <div class="db-select-item-info">
                        <div class="db-select-item-name">${db.label}</div>
                        <div class="db-select-item-meta">${metaText}</div>
                    </div>
                    <div class="db-select-check" style="${isSelected ? '' : 'display:none;'}"><i class="fa-solid fa-check"></i></div>
                `;
                item.onclick = () => {
                    selectedSource = { type: 'database', id: db.id, label: db.label };
                    sourceSelectPopup.classList.remove('active');
                    if (sourceSelectOverlay) sourceSelectOverlay.classList.remove('active');
                    updateSourceActiveState();
                };
                sourceDbList.appendChild(item);
            });
        }
    }

    function updateSourceActiveState() {
        if (pendingSessionType === 'project') {
            sourceActiveBadge.style.display = 'none';
            return;
        }

        if (selectedSource) {
            sourceActiveBadge.style.display = 'inline-flex';
            sourceActiveName.textContent = selectedSource.label;
            // Ensure workflow mode is off when source is selected
            if (isWorkflowMode) {
                isWorkflowMode = false;
                if (workflowModeBadge) workflowModeBadge.style.display = 'none';
            }
            if (sourceActiveIcon) {
                sourceActiveIcon.className = selectedSource.type === 'api'
                    ? 'fa-solid fa-plug'
                    : 'fa-solid fa-database';
            }
        } else {
            sourceActiveBadge.style.display = 'none';
            sourceActiveName.textContent = 'No source selected';
        }
    }

    if (sourceSelectBtn && sourceSelectPopup) {
        sourceSelectBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (mcpPlusDropdown) mcpPlusDropdown.style.display = 'none';
            const isShowing = sourceSelectPopup.classList.contains('active');
            if (isShowing) {
                sourceSelectPopup.classList.remove('active');
                if (sourceSelectOverlay) sourceSelectOverlay.classList.remove('active');
            } else {
                sourceSelectPopup.classList.add('active');
                if (sourceSelectOverlay) sourceSelectOverlay.classList.add('active');
                fetchAllSources();
            }
        });
    }

    if (sourceSelectClose) {
        sourceSelectClose.addEventListener('click', () => {
            sourceSelectPopup.classList.remove('active');
            if (sourceSelectOverlay) sourceSelectOverlay.classList.remove('active');
        });
    }

    document.addEventListener('click', (e: Event) => {
        if (sourceSelectPopup && !sourceSelectPopup.contains(e.target as Node) &&
            sourceSelectBtn && !sourceSelectBtn.contains(e.target as Node)) {
            sourceSelectPopup.classList.remove('active');
            if (sourceSelectOverlay) sourceSelectOverlay.classList.remove('active');
        }
    });

    if (sourceSelectOverlay) {
        sourceSelectOverlay.addEventListener('click', () => {
            sourceSelectPopup.classList.remove('active');
            sourceSelectOverlay.classList.remove('active');
        });
    }

    if (sourceActiveClear) {
        sourceActiveClear.addEventListener('click', (e) => {
            e.stopPropagation();
            selectedSource = null;
            updateSourceActiveState();
        });
    }

    if (sourceActiveBadge) {
        sourceActiveBadge.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).closest('#sourceActiveClear')) return;
            e.stopPropagation();
            const isShowing = sourceSelectPopup.classList.contains('active');
            if (isShowing) {
                sourceSelectPopup.classList.remove('active');
                if (sourceSelectOverlay) sourceSelectOverlay.classList.remove('active');
            } else {
                sourceSelectPopup.classList.add('active');
                if (sourceSelectOverlay) sourceSelectOverlay.classList.add('active');
                fetchAllSources();
            }
        });
    }

    if (apiConfigToggle && apiConfigPanel && apiConfigOverlay) {
        apiConfigToggle.onclick = () => {
            apiConfigPanel.classList.add('active');
            apiConfigOverlay.classList.add('active');
            if (contentApi) contentApi.classList.remove('show-form');
            fetchApiList();
        };
    }

    if (apiConfigClose && apiConfigPanel && apiConfigOverlay) {
        apiConfigClose.onclick = () => {
            apiConfigPanel.classList.remove('active');
            apiConfigOverlay.classList.remove('active');
        };
    }

    if (apiConfigOverlay && apiConfigPanel) {
        apiConfigOverlay.onclick = () => {
            apiConfigPanel.classList.remove('active');
            apiConfigOverlay.classList.remove('active');
        };
    }

    if (apiCreateNew && contentApi) {
        apiCreateNew.onclick = () => {
            openApiForm();
        };
    }

    if (apiCancelFormBtn && contentApi) {
        apiCancelFormBtn.onclick = () => {
            contentApi.classList.remove('show-form');
            apiEditingId = null;
        };
    }

    function openApiForm(api?: any) {
        if (contentApi) {
            contentApi.classList.add('show-form');
        }

        if (api) {
            apiEditingId = api.id;
            apiNameInput.value = api.apiName || '';
            apiMethodInput.value = api.method || 'GET';
            apiUrlInput.value = api.url || '';
            apiKeyInput.value = api.apiKeyVal || '';
            apiParamsInput.value = api.params || '';
            apiDescInput.value = api.desc || '';
        } else {
            apiEditingId = null;
            apiNameInput.value = '';
            apiMethodInput.value = 'GET';
            apiUrlInput.value = '';
            apiKeyInput.value = '';
            apiParamsInput.value = '';
            apiDescInput.value = '';
        }
    }

    async function deleteApi(id: number) {
        if (!await showConfirm("Are you sure you want to delete this API connection?")) return;
        try {
            const res = await fetch(`${BASE_URL}/api/api_connections/${id}`, { method: 'DELETE' });
            if (res.ok) {
                if (selectedSource && selectedSource.type === 'api' && selectedSource.id === id) {
                    selectedSource = null;
                    updateSourceActiveState();
                }
                fetchApiList();
            } else {
                showNotification("Failed to delete API.", "error");
            }
        } catch (e) {
            console.error(e);
        }
    }

    if (apiSaveBtn) {
        apiSaveBtn.onclick = async () => {
            const payload = {
                name: apiNameInput.value.trim(),
                method: apiMethodInput.value,
                api_url: apiUrlInput.value.trim(),
                api_key: apiKeyInput.value.trim(),
                parameter: apiParamsInput.value.trim(),
                description: apiDescInput.value.trim()
            };

            if (!payload.name || !payload.api_url) {
                showNotification("API Name and URL are required.", "error");
                return;
            }

            try {
                let res;
                if (apiEditingId) {
                    res = await fetch(`${BASE_URL}/api/api_connections/${apiEditingId}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                } else {
                    res = await fetch(`${BASE_URL}/api/api_connections`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                }

                if (res.ok) {
                    if (contentApi) contentApi.classList.remove('show-form');
                    fetchApiList();
                    showNotification("API saved successfully.", "success");
                } else {
                    const data = await res.json();
                    showNotification("Error saving API: " + (data.detail || "Unknown error"), "error");
                }
            } catch (e) {
                console.error("Error saving API", e);
                showNotification("Failed to save API. Is backend running?", "error");
            }
        };
    }

    // Call initial fetch
    fetchAllSources();

    // --- 1. CHIPS & UI LOGIC ---
    chatInput.oninput = function () {
        const target = this as HTMLTextAreaElement;

        target.style.height = 'auto';
        target.style.height = (target.scrollHeight) + 'px';

        if (target.scrollHeight >= 150) {
            target.style.overflowY = 'auto';
        } else {
            target.style.overflowY = 'hidden';
        }
    };

    // --- 2. FILE PREVIEW LOGIC ---
    function updateFilePreview(fileName: string, fileUrl: string, fileId: string) {
        if (!previewBar) return;
        previewBar.style.display = "flex";

        const isImage = /\.(jpg|jpeg|png|webp|gif)$/i.test(fileName);
        const isPdf = /\.pdf$/i.test(fileName);
        const isWord = /\.(doc|docx)$/i.test(fileName);

        const previewItem = document.createElement('div');
        previewItem.className = 'mcp-preview-item';
        previewItem.setAttribute('data-id', fileId);

        let content = '';
        if (isImage) {
            content = `<img src="${fileUrl}" style="width:100%; height:100%; object-fit:cover;">`;
        } else if (isPdf) {
            content = `<i class="fas fa-file-pdf" style="font-size:24px; color:#e74c3c;"></i>`;
        } else if (isWord) {
            content = `<i class="fas fa-file-word" style="font-size:24px; color:#3498db;"></i>`;
        } else {
            content = `<i class="fas fa-file" style="font-size:24px; color:#64748b;"></i>`;
        }

        previewItem.innerHTML = `
            ${content}
            <div class="mcp-preview-overlay"></div>
            <div class="remove-file">
                <i class="fas fa-times"></i>
            </div>
        `;

        const removeBtn = previewItem.querySelector('.remove-file') as HTMLElement;
        removeBtn.onclick = (e) => {
            e.stopPropagation();
            currentAttachedFileIds = currentAttachedFileIds.filter(id => id !== fileId);
            currentAttachedFiles.delete(fileId);
            previewItem.remove();
            if (currentAttachedFileIds.length === 0) previewBar.style.display = "none";
        };

        previewBar.appendChild(previewItem);
    }

    function appendMessage(text: string, sender: 'user' | 'bot', _toolUsed: string | null = null, images: string[] = [], animate: boolean = false) {
        // Inject cursor style if not present
        if (!document.getElementById('zeus-chat-cursor-style')) {
            const style = document.createElement('style');
            style.id = 'zeus-chat-cursor-style';
            style.innerHTML = `
                .zeus-typing-cursor {
                    display: inline-block;
                    width: 7px;
                    height: 14px;
                    background-color: currentColor;
                    margin-left: 3px;
                    animation: zeus-blink 0.8s infinite;
                    vertical-align: middle;
                }
                @keyframes zeus-blink {
                    0%, 100% { opacity: 0; }
                    50% { opacity: 1; }
                }
            `;
            document.head.appendChild(style);
        }

        const welcome = document.getElementById('welcomeContainer');
        if (welcome) {
            welcome.remove();
        }

        const msgDiv = document.createElement('div');
        msgDiv.className = `mcp-message ${sender}`;

        let toolHtml = '';

        let imagesHtml = '';
        if (images.length > 0) {
            imagesHtml = `<div style="display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap;">` +
                images.map(url => `<img src="${url}" style="max-width: 200px; max-height: 200px; border-radius: 8px; object-fit: contain; border: 1px solid rgba(0,0,0,0.1);">`).join('') +
                `</div>`;
        }

        let processedText = text.replace(/style="[^"]*background:\s*#f9f9f9;?[^"]*"/g, 'class="zeus-web-search-box"');
        try {
            const jsonMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
            const jsonStr = jsonMatch ? jsonMatch[1] : text.trim();

            if (jsonStr.startsWith('{') || jsonStr.startsWith('[')) {
                const parsed = JSON.parse(jsonStr);
                if (typeof parsed === 'object' && parsed !== null) {
                    let html = '<div style="display:flex; flex-direction:column; gap:8px;">';
                    for (const [key, value] of Object.entries(parsed)) {
                        const formattedKey = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                        html += `<div><strong class="zeus-json-key">${formattedKey}:</strong> <span class="zeus-json-value">${value}</span></div>`;
                    }
                    html += '</div>';

                    if (jsonMatch) {
                        processedText = text.replace(jsonMatch[0], html);
                    } else {
                        processedText = html;
                    }
                }
            }
        } catch (e) {
        }

        function finalizeMessageContent() {
            const tables = msgDiv.querySelectorAll('table');
            tables.forEach((table) => {
                if (table.parentElement && !table.previousElementSibling?.classList.contains('excel-export-btn-container')) {
                    const btnContainer = document.createElement('div');
                    btnContainer.className = 'excel-export-btn-container';
                    btnContainer.style.marginBottom = '10px';
                    btnContainer.style.display = 'flex';
                    btnContainer.style.justifyContent = 'flex-start';

                    const exportBtn = document.createElement('button');
                    exportBtn.className = 'excel-export-btn';
                    exportBtn.innerHTML = '<i class="fa-solid fa-file-excel" style="margin-right: 6px; color: #107c41; font-size: 14px;"></i> Export to Excel';
                    exportBtn.style.background = 'rgba(16, 124, 65, 0.1)';
                    exportBtn.style.color = '#107c41';
                    exportBtn.style.border = '1px solid rgba(16, 124, 65, 0.3)';
                    exportBtn.style.padding = '6px 14px';
                    exportBtn.style.borderRadius = '6px';
                    exportBtn.style.fontSize = '12px';
                    exportBtn.style.fontWeight = '600';
                    exportBtn.style.cursor = 'pointer';
                    exportBtn.style.display = 'inline-flex';
                    exportBtn.style.alignItems = 'center';
                    exportBtn.style.transition = 'all 0.2s ease-in-out';
                    exportBtn.style.fontFamily = "'Inter', sans-serif";
                    exportBtn.style.boxShadow = '0 1px 2px rgba(0,0,0,0.05)';

                    exportBtn.onmouseover = () => {
                        exportBtn.style.background = '#107c41';
                        exportBtn.style.color = '#ffffff';
                        exportBtn.style.borderColor = '#107c41';
                        const icon = exportBtn.querySelector('i');
                        if (icon) icon.style.color = '#ffffff';
                    };
                    exportBtn.onmouseout = () => {
                        exportBtn.style.background = 'rgba(16, 124, 65, 0.1)';
                        exportBtn.style.color = '#107c41';
                        exportBtn.style.borderColor = 'rgba(16, 124, 65, 0.3)';
                        const icon = exportBtn.querySelector('i');
                        if (icon) icon.style.color = '#107c41';
                    };

                    exportBtn.onclick = () => {
                        const csv: string[] = [];
                        const rows = table.querySelectorAll('tr');

                        rows.forEach((row) => {
                            const cols = row.querySelectorAll('th, td');
                            const rowData: string[] = [];
                            cols.forEach((col) => {
                                let text = (col as HTMLElement).innerText.trim();
                                text = text.replace(/"/g, '""');
                                rowData.push(`"${text}"`);
                            });
                            csv.push(rowData.join(','));
                        });

                        const csvContent = "\uFEFF" + csv.join("\n");
                        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
                        const url = URL.createObjectURL(blob);
                        const link = document.createElement("a");
                        link.setAttribute("href", url);

                        const dateStr = new Date().toISOString().slice(0, 10);
                        link.setAttribute("download", `query_result_${dateStr}.csv`);
                        document.body.appendChild(link);
                        link.click();
                        document.body.removeChild(link);
                        URL.revokeObjectURL(url);
                    };

                    btnContainer.appendChild(exportBtn);

                    const exportPdfBtn = document.createElement('button');
                    exportPdfBtn.className = 'pdf-export-btn';
                    exportPdfBtn.innerHTML = '<i class="fa-solid fa-file-pdf" style="margin-right: 6px; color: #dc2626; font-size: 14px;"></i> Export to PDF';
                    exportPdfBtn.style.background = 'rgba(220, 38, 38, 0.1)';
                    exportPdfBtn.style.color = '#dc2626';
                    exportPdfBtn.style.border = '1px solid rgba(220, 38, 38, 0.3)';
                    exportPdfBtn.style.padding = '6px 14px';
                    exportPdfBtn.style.borderRadius = '6px';
                    exportPdfBtn.style.fontSize = '12px';
                    exportPdfBtn.style.fontWeight = '600';
                    exportPdfBtn.style.cursor = 'pointer';
                    exportPdfBtn.style.display = 'inline-flex';
                    exportPdfBtn.style.alignItems = 'center';
                    exportPdfBtn.style.transition = 'all 0.2s ease-in-out';
                    exportPdfBtn.style.fontFamily = "'Inter', sans-serif";
                    exportPdfBtn.style.boxShadow = '0 1px 2px rgba(0,0,0,0.05)';
                    exportPdfBtn.style.marginLeft = '8px';

                    exportPdfBtn.onmouseover = () => {
                        exportPdfBtn.style.background = '#dc2626';
                        exportPdfBtn.style.color = '#ffffff';
                        exportPdfBtn.style.borderColor = '#dc2626';
                        const icon = exportPdfBtn.querySelector('i');
                        if (icon) icon.style.color = '#ffffff';
                    };
                    exportPdfBtn.onmouseout = () => {
                        exportPdfBtn.style.background = 'rgba(220, 38, 38, 0.1)';
                        exportPdfBtn.style.color = '#dc2626';
                        exportPdfBtn.style.borderColor = 'rgba(220, 38, 38, 0.3)';
                        const icon = exportPdfBtn.querySelector('i');
                        if (icon) icon.style.color = '#dc2626';
                    };

                    exportPdfBtn.onclick = () => {
                        const printWindow = window.open('', '_blank');
                        if (printWindow) {
                            const tableHtml = table.outerHTML;
                            printWindow.document.write(`
                                <html>
                                <head>
                                    <title>Database Query Results</title>
                                    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
                                    <style>
                                        body {
                                            font-family: 'Inter', sans-serif;
                                            padding: 20px;
                                            color: #1e293b;
                                            background-color: #ffffff;
                                        }
                                        h2 {
                                            font-size: 20px;
                                            margin-bottom: 5px;
                                            color: #0f172a;
                                        }
                                        table {
                                            width: 100%;
                                            border-collapse: collapse;
                                            margin-top: 15px;
                                            font-size: 12px;
                                        }
                                        th, td {
                                            border: 1px solid #cbd5e1;
                                            padding: 8px 10px;
                                            text-align: left;
                                        }
                                        th {
                                            background-color: #f1f5f9;
                                            font-weight: 600;
                                            color: #334155;
                                        }
                                        tr:nth-child(even) {
                                            background-color: #f8fafc;
                                        }
                                        @media print {
                                            body { padding: 0; }
                                            @page { margin: 1.5cm; }
                                        }
                                    </style>
                                </head>
                                <body>
                                    <h2>Database Query Results</h2>
                                    <p style="font-size: 11px; color: #64748b; margin-top: 0; margin-bottom: 20px;">Generated on: ${new Date().toLocaleString()}</p>
                                    ${tableHtml}
                                    <script>
                                        window.onload = function() {
                                            window.print();
                                            window.close();
                                        };
                                    </script>
                                </body>
                                </html>
                            `);
                            printWindow.document.close();
                        }
                    };

                    btnContainer.appendChild(exportPdfBtn);

                    table.parentNode?.insertBefore(btnContainer, table);

                    const prevMsg = msgDiv.previousElementSibling;
                    if (prevMsg && prevMsg.classList.contains('user')) {
                        const userText = prevMsg.textContent?.toLowerCase() || '';
                        if (userText.includes('chart') || userText.includes('graph') || userText.includes('plot')) {
                            const container = document.createElement('div');
                            container.className = 'chart-visualizer-container';
                            container.style.marginTop = '15px';
                            container.style.marginBottom = '15px';
                            container.style.padding = '15px';
                            container.style.background = '#ffffff';
                            container.style.border = '1px solid #e2e8f0';
                            container.style.borderRadius = '8px';
                            container.style.boxShadow = '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)';
                            container.style.width = '60%';
                            container.style.minWidth = '700px';
                            container.style.boxSizing = 'border-box';

                            const switcher = document.createElement('div');
                            switcher.style.display = 'flex';
                            switcher.style.gap = '10px';
                            switcher.style.marginBottom = '15px';
                            switcher.style.justifyContent = 'center';

                            const types = [
                                { id: 'bar', icon: 'fa-chart-column', label: 'Bar' },
                                { id: 'line', icon: 'fa-chart-line', label: 'Line' },
                                { id: 'pie', icon: 'fa-chart-pie', label: 'Pie' },
                                { id: 'doughnut', icon: 'fa-circle-notch', label: 'Doughnut' }
                            ];

                            let currentType = 'bar';
                            if (userText.includes('line')) currentType = 'line';
                            else if (userText.includes('pie')) currentType = 'pie';
                            else if (userText.includes('doughnut') || userText.includes('donut')) currentType = 'doughnut';

                            let chartInstance: any = null;

                            const rows = table.querySelectorAll('tr');
                            if (rows.length < 2) return;

                            const headers: string[] = [];
                            rows[0].querySelectorAll('th, td').forEach(col => headers.push((col as HTMLElement).innerText.trim()));

                            const labels: string[] = [];
                            const datasetsData: { [key: number]: number[] } = {};
                            const numericColIndices: number[] = [];

                            const firstDataRow = rows[1].querySelectorAll('th, td');
                            firstDataRow.forEach((col, idx) => {
                                if (idx === 0) return;
                                const valText = (col as HTMLElement).innerText.replace(/[^0-9.-]+/g, "");
                                if (valText && !isNaN(parseFloat(valText))) {
                                    numericColIndices.push(idx);
                                    datasetsData[idx] = [];
                                }
                            });

                            if (numericColIndices.length === 0) return;

                            for (let i = 1; i < rows.length; i++) {
                                const cols = rows[i].querySelectorAll('th, td');
                                if (cols.length === 0) continue;
                                labels.push((cols[0] as HTMLElement).innerText.trim());
                                numericColIndices.forEach(idx => {
                                    if (idx < cols.length) {
                                        const valText = (cols[idx] as HTMLElement).innerText.replace(/[^0-9.-]+/g, "");
                                        const val = parseFloat(valText);
                                        datasetsData[idx].push(isNaN(val) ? 0 : val);
                                    }
                                });
                            }

                            const themeColors = [
                                { bg: 'rgba(79, 70, 229, 0.5)', border: '#4f46e5' },
                                { bg: 'rgba(16, 124, 65, 0.5)', border: '#107c41' },
                                { bg: 'rgba(220, 38, 38, 0.5)', border: '#dc2626' },
                                { bg: 'rgba(245, 158, 11, 0.5)', border: '#f59e0b' },
                                { bg: 'rgba(14, 165, 233, 0.5)', border: '#0ea5e9' }
                            ];

                            const datasets = numericColIndices.map((idx, i) => {
                                return {
                                    label: headers[idx] || `Series ${i + 1}`,
                                    data: datasetsData[idx],
                                    backgroundColor: themeColors[0].bg as any,
                                    borderColor: themeColors[0].border as any,
                                    borderWidth: 1
                                };
                            });

                            const canvasWrapper = document.createElement('div');
                            canvasWrapper.style.position = 'relative';
                            canvasWrapper.style.height = '250px';
                            canvasWrapper.style.width = '100%';
                            const canvas = document.createElement('canvas');
                            canvasWrapper.appendChild(canvas);

                            const drawChart = (type: string) => {
                                const isPie = type === 'pie' || type === 'doughnut';
                                datasets.forEach((ds, i) => {
                                    const theme = themeColors[i % themeColors.length];
                                    if (isPie) {
                                        ds.backgroundColor = labels.map((_, j) => themeColors[j % themeColors.length].bg);
                                        ds.borderColor = labels.map((_, j) => themeColors[j % themeColors.length].border);
                                    } else {
                                        ds.backgroundColor = theme.bg;
                                        ds.borderColor = theme.border;
                                    }
                                });

                                if (chartInstance) {
                                    chartInstance.destroy();
                                }
                                if (!(window as any).Chart) return;
                                chartInstance = new (window as any).Chart(canvas, {
                                    type: type,
                                    data: { labels, datasets },
                                    options: {
                                        responsive: true,
                                        maintainAspectRatio: false,
                                        animation: { duration: 500, easing: 'easeInOutQuart' },
                                        plugins: {
                                            legend: { display: !isPie || datasets.length === 1 }
                                        }
                                    }
                                });
                            };

                            types.forEach(t => {
                                const btn = document.createElement('button');
                                btn.innerHTML = `<i class="fa-solid ${t.icon}"></i> ${t.label}`;
                                btn.style.padding = '6px 12px';
                                btn.style.border = '1px solid #cbd5e1';
                                btn.style.background = t.id === currentType ? '#f1f5f9' : '#ffffff';
                                btn.style.borderRadius = '20px';
                                btn.style.cursor = 'pointer';
                                btn.style.fontSize = '12px';
                                btn.style.fontWeight = '500';
                                btn.style.color = '#334155';
                                btn.style.fontFamily = "'Inter', sans-serif";
                                btn.style.transition = 'all 0.2s';

                                btn.onclick = () => {
                                    currentType = t.id;
                                    Array.from(switcher.children).forEach((c: any) => c.style.background = '#ffffff');
                                    btn.style.background = '#f1f5f9';
                                    drawChart(currentType);
                                };
                                switcher.appendChild(btn);
                            });

                            container.appendChild(switcher);
                            container.appendChild(canvasWrapper);

                            table.parentNode?.insertBefore(container, table.nextSibling);

                            setTimeout(() => drawChart(currentType), 10);
                        }
                    }
                }
            });
            chatBody.scrollTop = chatBody.scrollHeight;
        }

        // If animation is requested and it's a bot response, we stream it.
        if (sender === 'bot' && animate) {
            chatInput.disabled = true;
            sendBtn.disabled = true;
            sendBtn.style.opacity = '0.5';
            sendBtn.style.cursor = 'not-allowed';

            const textWrapper = document.createElement('div');
            textWrapper.className = 'zeus-text-wrapper';

            msgDiv.innerHTML = `
                <div class="mcp-bubble mcp-markdown-content">
                    ${toolHtml}
                    ${imagesHtml}
                </div>
            `;
            const bubble = msgDiv.querySelector('.mcp-bubble') as HTMLElement;
            bubble.appendChild(textWrapper);
            chatBody.appendChild(msgDiv);

            // Stream text word-by-word/token-by-token
            const tokens = processedText.split(/(\s+)/);
            let tokenIndex = 0;
            let accumulated = "";

            const nextChunk = () => {
                if (tokenIndex < tokens.length) {
                    const token = tokens[tokenIndex];
                    accumulated += token;
                    tokenIndex++;

                    let formatted = accumulated;
                    if ((window as any).marked) {
                        formatted = (window as any).marked.parse(accumulated);
                    }

                    // Place the cursor correctly inside the last block element to prevent it displaying on a new line
                    let htmlWithCursor = formatted;
                    const lastClosingTag = formatted.match(/<\/[a-zA-Z0-9]+>$/);
                    if (lastClosingTag) {
                        const tag = lastClosingTag[0];
                        htmlWithCursor = formatted.substring(0, formatted.length - tag.length) + '<span class="zeus-typing-cursor"></span>' + tag;
                    } else {
                        htmlWithCursor = formatted + '<span class="zeus-typing-cursor"></span>';
                    }

                    textWrapper.innerHTML = htmlWithCursor;
                    chatBody.scrollTop = chatBody.scrollHeight;

                    // Add a tiny extra pause on newlines and sentence boundaries
                    let delay = 12;
                    if (token.includes('\n')) {
                        delay = 60;
                    } else if (/[.!?]$/.test(token.trim())) {
                        delay = 100;
                    }

                    setTimeout(nextChunk, delay);
                } else {
                    // Animation complete, clean up and finalize
                    let finalFormatted = accumulated;
                    if ((window as any).marked) {
                        finalFormatted = (window as any).marked.parse(accumulated);
                    }
                    textWrapper.innerHTML = finalFormatted;

                    chatInput.disabled = false;
                    sendBtn.disabled = false;
                    sendBtn.style.opacity = '';
                    sendBtn.style.cursor = '';
                    chatInput.focus();

                    finalizeMessageContent();
                }
            };

            nextChunk();
        } else {
            // Immediate rendering (for user messages or history loading)
            let formattedText = processedText;
            if ((window as any).marked) {
                formattedText = (window as any).marked.parse(processedText);
            } else {
                formattedText = processedText.replace(/```json\n([\s\S]*?)\n```/g, '<pre><code>$1</code></pre>');
            }

            msgDiv.innerHTML = `
                <div class="mcp-bubble mcp-markdown-content">
                    ${toolHtml}
                    ${imagesHtml}
                    <div>${formattedText}</div>
                </div>
            `;

            chatBody.appendChild(msgDiv);
            finalizeMessageContent();
        }
    }
    (window as any).appendZeusMessage = appendMessage;

    async function saveZeusHistory(role: string, content: string, mode: string = "Document Extractor") {
        if (!currentSessionId) return;
        try {
            await fetch(`${BASE_URL}/zeus/history/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    session_id: currentSessionId,
                    role: role,
                    content: content,
                    mode: mode
                })
            });
        } catch (e) {
            console.error("Failed to save zeus history:", e);
        }
    }
    (window as any).saveZeusHistory = saveZeusHistory;

    function showTypingIndicator(): HTMLDivElement {
        const msgDiv = document.createElement('div');
        msgDiv.className = `mcp-message bot`;
        msgDiv.innerHTML = `
            <div class="mcp-bubble" style="display:flex; flex-direction:row; width:fit-content; gap:10px; align-items:center; padding: 16px 20px;">
                <div class="mcp-typing-dots">
                    <span></span><span></span><span></span>
                </div>
                <span class="zeus-typing-text" style="font-size: 13px; font-weight: 500; color: #64748b; white-space: nowrap;">
                    Zeus is thinking...
                </span>
            </div>
        `;
        chatBody.appendChild(msgDiv);
        chatBody.scrollTop = chatBody.scrollHeight;
        return msgDiv;
    }

    // --- 4. DATA SEND LOGIC --
    async function handleSend() {
        let message = chatInput.value.trim();

        if (isWorkflowMode) {
            message = `[Generate Workflow] ${message}`;
            isWorkflowMode = false;
            if (workflowModeBadge) {
                workflowModeBadge.style.display = 'none';
            }
        }

        let currentMode = "Auto";

        if (!message && currentAttachedFileIds.length > 0) {
            message = "Extract text from this document.";
        }

        if (!message) return;

        const sendingFilesWithIds: { file: File, id: string }[] = [];
        currentAttachedFileIds.forEach(id => {
            const file = currentAttachedFiles.get(id);
            if (file) {
                sendingFilesWithIds.push({ file, id });
            }
        });
        const sendingFiles = sendingFilesWithIds.map(x => x.file);
        const sendingFileIds = sendingFilesWithIds.map(x => x.id);

        let attachmentsHtml = '';
        sendingFiles.forEach((file, idx) => {
            const fileId = sendingFileIds[idx];
            const isImage = file.type.startsWith('image/');
            if (isImage) {
                attachmentsHtml += `\n<div class="chat-image-attachment"><img src="${BASE_URL}/view-file/${fileId}" style="max-width: 200px; max-height: 200px; border-radius: 8px; object-fit: contain; border: 1px solid rgba(0,0,0,0.1);"></div>`;
            } else {
                let iconClass = 'fa-solid fa-file';
                if (file.name.endsWith('.pdf')) iconClass = 'fa-solid fa-file-pdf';
                else if (file.name.endsWith('.docx') || file.name.endsWith('.doc')) iconClass = 'fa-solid fa-file-word';
                else if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) iconClass = 'fa-solid fa-file-excel';
                else if (file.name.endsWith('.csv')) iconClass = 'fa-solid fa-file-csv';

                attachmentsHtml += `\n<div class="chat-attachment-card" data-file-id="${fileId}"><i class="${iconClass}"></i><span>${file.name}</span></div>`;
            }
        });

        if (attachmentsHtml) {
            message = attachmentsHtml + '<div style="margin-top: 8px;">' + message + '</div>';
        }

        appendMessage(message, 'user', null);

        currentAttachedFileIds = [];
        currentAttachedFiles.clear();

        chatInput.value = '';
        chatInput.style.height = 'auto';
        chatInput.dispatchEvent(new Event('input'));

        if (previewBar) {
            previewBar.innerHTML = '';
            previewBar.style.display = 'none';
        }




        const typingIndicator = showTypingIndicator();

        try {
            let config = { role: '', temperature: 0.7 };
            const savedConfig = localStorage.getItem(getChatbotConfigKey());
            if (savedConfig) {
                try { config = JSON.parse(savedConfig); } catch (e) { }
            }

            if (!currentSessionId) {
                const user = JSON.parse(localStorage.getItem('zeusUser') || 'null');
                const res = await fetch(`${BASE_URL}/zeus/sessions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: pendingSessionType, userid: user ? user.userid : null })
                });
                const data = await res.json();
                currentSessionId = data.id;
                loadSessions();
            }

            const payload: ZeusChatRequest = {
                session_id: currentSessionId as string,
                message: message,
                mode: currentMode,
                file_ids: sendingFileIds,
                system_instructions: config.role,
                temperature: config.temperature,
                api_conn_id: selectedSource?.type === 'api' ? selectedSource.id : null,
                db_conn_id: selectedSource?.type === 'database' ? selectedSource.id : null
            };


            const response = await fetch(`${BASE_URL}/zeus/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            const contentType = response.headers.get('content-type');
            if (contentType && contentType.includes('text/event-stream')) {
                const reader = response.body?.getReader();
                if (!reader) throw new Error("No reader on response body");
                const decoder = new TextDecoder();
                let buffer = "";
                let finalAnswer = "";
                let toolUsed = "";

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() || "";

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed) continue;
                        if (trimmed.startsWith("data:")) {
                            const dataStr = trimmed.substring(5).trim();
                            try {
                                const parsed = JSON.parse(dataStr);
                                if (parsed.type === 'status') {
                                    const textSpan = typingIndicator.querySelector('.zeus-typing-text') as HTMLSpanElement;
                                    if (textSpan) {
                                        textSpan.textContent = parsed.message;
                                    }
                                } else if (parsed.type === 'final') {
                                    finalAnswer = parsed.answer;
                                    toolUsed = parsed.tool_used;
                                }
                            } catch (e) {
                                console.error("Error parsing SSE JSON:", e, dataStr);
                            }
                        }
                    }
                }

                typingIndicator.remove();
                if (finalAnswer) {
                    appendMessage(finalAnswer, 'bot', toolUsed || null, [], true);
                } else {
                    appendMessage("⚠️ No response received from Zeus.", 'bot');
                }
                loadSessions();
            } else {
                const data: ZeusChatResponse = await response.json();
                typingIndicator.remove();
                appendMessage(data.answer, 'bot', data.tool_used, [], true);
                loadSessions();
            }
        } catch (error) {
            console.error('Error communicating with Zeus:', error);
            typingIndicator.remove();
            appendMessage("⚠️ Sorry, I encountered an error connecting to the server.", 'bot');
        }
    }

    sendBtn.addEventListener('click', handleSend);

    chatInput.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    });

    // --- 5. FILE UPLOAD & DROPDOWN MENU LOGIC ---
    if (fileBtn && mcpPlusDropdown && fileInput) {
        fileBtn.onclick = (e) => {
            e.stopPropagation();
            if (pendingSessionType === 'project') {
                fileInput.click();
            } else {
                const isOpen = mcpPlusDropdown.style.display === 'block';
                mcpPlusDropdown.style.display = isOpen ? 'none' : 'block';
                if (sourceSelectPopup) {
                    sourceSelectPopup.classList.remove('active');
                    if (sourceSelectOverlay) sourceSelectOverlay.classList.remove('active');
                }
            }
        };

        if (plusUploadBtn) {
            plusUploadBtn.onclick = (e) => {
                e.stopPropagation();
                mcpPlusDropdown.style.display = 'none';
                fileInput.click();
            };
        }

        if (plusWorkflowBtn && workflowModeBadge && workflowModeClear) {
            plusWorkflowBtn.onclick = (e) => {
                e.stopPropagation();
                mcpPlusDropdown.style.display = 'none';
                isWorkflowMode = true;
                workflowModeBadge.style.display = 'flex';
                // Clear source selection when workflow mode is activated
                selectedSource = null;
                updateSourceActiveState();
                chatInput.focus();
            };

            workflowModeClear.onclick = (e) => {
                e.stopPropagation();
                isWorkflowMode = false;
                workflowModeBadge.style.display = 'none';
            };
        }

        document.addEventListener('click', (e: Event) => {
            if (!mcpPlusDropdown.contains(e.target as Node) && !fileBtn.contains(e.target as Node)) {
                mcpPlusDropdown.style.display = 'none';
            }
        });

        fileInput.addEventListener('change', async (e: Event) => {
            const target = e.target as HTMLInputElement;

            if (target.files && target.files.length > 0) {
                const file = target.files[0];
                const originalPlaceholder = chatInput.placeholder;

                chatInput.placeholder = `Uploading ${file.name}...`;
                chatInput.disabled = true;

                try {
                    const user = JSON.parse(localStorage.getItem('zeusUser') || 'null');
                    if (!currentSessionId) {
                        const res = await fetch(`${BASE_URL}/zeus/sessions`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ type: pendingSessionType, userid: user ? user.userid : null })
                        });
                        const data = await res.json();
                        currentSessionId = data.id;
                        loadSessions();
                    }

                    const formData = new FormData();
                    formData.append('file', file);
                    formData.append('session_id', currentSessionId || '');
                    if (user && user.userid) {
                        formData.append('userid', user.userid.toString());
                    }

                    const response = await fetch(`${BASE_URL}/upload_document`, {
                        method: 'POST',
                        body: formData
                    });

                    if (!response.ok) throw new Error("Upload failed");

                    const result = await response.json();

                    currentAttachedFileIds.push(result.file_id);
                    currentAttachedFiles.set(result.file_id, file);
                    const localPreviewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : '';
                    updateFilePreview(file.name, localPreviewUrl, result.file_id);


                    chatInput.placeholder = originalPlaceholder;
                    console.log("Attached real file_id to Zeus context:", result.file_id);

                } catch (error) {
                    console.error("Upload error:", error);
                    chatInput.placeholder = "Upload failed. Please try again.";
                } finally {
                    chatInput.disabled = false;
                    target.value = '';
                }
            }
        });
    }
    chatBody.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const btn = target.closest('.zeus-view-highlights-btn') as HTMLButtonElement | null;
        if (btn) {
            const fileId = btn.getAttribute('data-file-id');
            const filename = btn.getAttribute('data-filename') || "Document";
            const mimeType = btn.getAttribute('data-mime') || "application/pdf";

            if (fileId) {
                openDocumentExtractorView();

                if (typeof (window as any).loadHistoricalDocument === 'function') {
                    const originalHtml = btn.innerHTML;
                    btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Loading...`;
                    btn.disabled = true;

                    (window as any).loadHistoricalDocument(fileId, filename, mimeType).then(() => {
                        btn.innerHTML = originalHtml;
                        btn.disabled = false;
                    }).catch((err: any) => {
                        console.error("Failed to load highlights:", err);
                        btn.innerHTML = originalHtml;
                        btn.disabled = false;
                    });
                }
            }
        }

        const workflowBtn = target.closest('.zeus-open-workflow-btn') as HTMLButtonElement | null;
        if (workflowBtn) {
            if (workflowBtn.disabled) return;
            workflowBtn.disabled = true;
            workflowBtn.innerHTML = '<i class="fas fa-spinner fa-spin" style="margin-right:6px;"></i> Opening...';

            const b64Data = workflowBtn.getAttribute('data-workflow');
            if (b64Data) {
                try {
                    const jsonStr = atob(b64Data);
                    const workflowData = JSON.parse(jsonStr);
                    if (typeof (window as any).loadGeneratedWorkflow === 'function') {
                        (window as any).loadGeneratedWorkflow(workflowData);
                    }
                } catch (e) {
                    console.error("Failed to parse workflow data:", e);
                    workflowBtn.disabled = false;
                    workflowBtn.innerHTML = '<i class="fas fa-project-diagram" style="margin-right:6px;"></i> Open Generated Workflow';
                }
            }
        }

        const approveBtn = target.closest('.zeus-approve-email-btn') as HTMLButtonElement | null;
        if (approveBtn) {
            if (approveBtn.disabled) return;
            approveBtn.disabled = true;
            approveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
            const rejectBtn = approveBtn.parentElement?.querySelector('.zeus-reject-email-btn') as HTMLButtonElement;
            if (rejectBtn) rejectBtn.disabled = true;

            const to = atob(approveBtn.getAttribute('data-to') || '');
            const subject = atob(approveBtn.getAttribute('data-subject') || '');
            const body = atob(approveBtn.getAttribute('data-body') || '');

            let userid = null;
            const userStr = localStorage.getItem('zeusUser');
            if (userStr) {
                try {
                    const user = JSON.parse(userStr);
                    userid = user.userid;
                } catch (e) { }
            }

            fetch(`${BASE_URL}/zeus/send_email_confirm`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ to_email: to, subject: subject, body: body, userid: userid })
            })
                .then(res => res.json())
                .then(() => {
                    approveBtn.innerHTML = '<i class="fas fa-check"></i> Sent';
                    approveBtn.style.background = '#059669';
                    const btnContainer = approveBtn.parentElement as HTMLElement;
                    if (btnContainer) btnContainer.style.display = 'none';

                    const card = approveBtn.closest('.zeus-email-draft-card');
                    if (card) {
                        const statusChip = card.querySelector('.zeus-email-status-chip') as HTMLElement;
                        if (statusChip) {
                            statusChip.innerText = 'Approved';
                            statusChip.className = 'zeus-email-status-chip approved';
                            statusChip.style.display = 'inline-block';
                        }
                    }

                    if (currentSessionId) {
                        fetch(`${BASE_URL}/zeus/history/update_email_status`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                session_id: currentSessionId,
                                to_email: to,
                                status: 'approved'
                            })
                        }).catch(err => console.error("Error saving approved status to DB history:", err));
                    }
                })
                .catch(err => {
                    console.error("Email send error:", err);
                    approveBtn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Error';
                    approveBtn.style.background = '#dc2626';
                    approveBtn.disabled = false;
                    if (rejectBtn) rejectBtn.disabled = false;
                });
        }

        const rejectBtn = target.closest('.zeus-reject-email-btn') as HTMLButtonElement | null;
        if (rejectBtn) {
            if (rejectBtn.disabled) return;
            const btnContainer = rejectBtn.parentElement as HTMLElement;
            if (btnContainer) btnContainer.style.display = 'none';

            const card = rejectBtn.closest('.zeus-email-draft-card');
            if (card) {
                const statusChip = card.querySelector('.zeus-email-status-chip') as HTMLElement;
                if (statusChip) {
                    statusChip.innerText = 'Rejected';
                    statusChip.className = 'zeus-email-status-chip rejected';
                    statusChip.style.display = 'inline-block';
                }
            }

            const approveBtn2 = btnContainer?.querySelector('.zeus-approve-email-btn') as HTMLButtonElement | null;
            if (approveBtn2 && currentSessionId) {
                const toEmail = atob(approveBtn2.getAttribute('data-to') || '');
                fetch(`${BASE_URL}/zeus/history/update_email_status`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        session_id: currentSessionId,
                        to_email: toEmail,
                        status: 'rejected'
                    })
                }).catch(err => console.error("Error saving rejected status to DB history:", err));
            }
        }

    });

    (window as any).renderApiConnList = fetchApiList;
}
