/* ============================================================
   TASK ALLOCATION — Logic Module
   ============================================================ */

// ── Types ──────────────────────────────────────────────────────
interface TaskNode {
    id: string;
    type: string;
    label: string;
    x: number;
    y: number;
    config: Record<string, string>;
}

interface TaskConnection {
    id: string;
    fromNodeId: string;
    toNodeId: string;
}

interface Task {
    id: string;
    name: string;
    description: string;
    nodes: TaskNode[];
    connections: TaskConnection[];
    status: 'finish' | 'running' | 'scheduled';
    createdAt: string;
    updatedAt: string;
    scheduleFrequency?: string;
    scheduleTime?: string;
    scheduleDay?: string;
}

// ── Tool Definitions ───────────────────────────────────────────
const TOOL_DEFS: Record<string, { label: string; icon: string; color: string }> = {
    start: { label: 'Start', icon: 'fa-solid fa-play', color: '#22c55e' },
    end: { label: 'End', icon: 'fa-solid fa-flag-checkered', color: '#ef4444' },
    gmail: { label: 'Gmail', icon: 'fa-solid fa-envelope', color: '#ea4335' },
    calendar: { label: 'Calendar', icon: 'fa-solid fa-calendar-days', color: '#4285f4' },
    database: { label: 'Database', icon: 'fa-solid fa-database', color: '#10b981' },
    api: { label: 'REST API', icon: 'fa-solid fa-plug', color: '#ec4899' },
    web_search: { label: 'Web Search', icon: 'fa-solid fa-globe', color: '#f59e0b' },
    ocr: { label: 'OCR / Docs', icon: 'fa-solid fa-file-invoice', color: '#8b5cf6' },
    llm: { label: 'LLM Prompt', icon: 'fa-solid fa-wand-magic-sparkles', color: '#6366f1' },
    report: { label: 'Report (PDF)', icon: 'fa-solid fa-file-pdf', color: '#10b981' },
};

// Flow-control node types that only have one port and no prompt body
const FLOW_NODES = new Set(['start', 'end']);

// ── Storage helpers ────────────────────────────────────────────
const BASE_URL = import.meta.env.VITE_API_BASE_URL;

function getStorageKey(): string {
    try {
        const userStr = localStorage.getItem('zeusUser');
        if (userStr) {
            const user = JSON.parse(userStr);
            if (user && user.userid) {
                return `zeus_tasks_${user.userid}`;
            }
        }
    } catch (e) {
        console.error("Failed to parse user session:", e);
    }
    return 'zeus_tasks';
}

function loadTasks(): Task[] {
    try {
        const key = getStorageKey();
        let raw = localStorage.getItem(key);

        // Migrate legacy shared workflows to user-specific storage
        if (!raw && key !== 'zeus_tasks') {
            const legacyRaw = localStorage.getItem('zeus_tasks');
            if (legacyRaw) {
                localStorage.setItem(key, legacyRaw);
                raw = legacyRaw;
                localStorage.removeItem('zeus_tasks');
                console.log(`Migrated legacy workflows to ${key}`);
            }
        }

        const tasks: Task[] = raw ? JSON.parse(raw) : [];
        // Migrate legacy statuses
        tasks.forEach(t => {
            if ((t.status as any) === 'draft' || (t.status as any) === 'stopped') {
                t.status = 'finish';
            }
        });
        return tasks;
    } catch (e) {
        return [];
    }
}

function saveTasks(tasks: Task[]) {
    localStorage.setItem(getStorageKey(), JSON.stringify(tasks));
}

function genId(): string {
    return 'ta_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// ── Module State ───────────────────────────────────────────────
let currentNodes: TaskNode[] = [];
let currentConnections: TaskConnection[] = [];
let editingTaskId: string | null = null;
let currentScheduleTaskId: string | null = null;
let selectedNodeId: string | null = null;
let selectedConnectionId: string | null = null;

// Undo / Redo Stacks
interface CanvasState {
    nodes: TaskNode[];
    connections: TaskConnection[];
}
const undoStack: CanvasState[] = [];
const redoStack: CanvasState[] = [];
let preDragState: CanvasState | null = null;

// Connection drawing state
let isDrawingConnection = false;
let connectionStartNodeId: string | null = null;
let tempConnectionLine: SVGPathElement | null = null;

// Node dragging state
let isDraggingNode = false;
let dragNodeId: string | null = null;
let dragOffsetX = 0;
let dragOffsetY = 0;

// ── DOM References (set during init) ───────────────────────────
let listingView: HTMLElement;
let editorView: HTMLElement;
let emptyState: HTMLElement;
let tableWrapper: HTMLElement;
let tableBody: HTMLElement;
let canvasEl: HTMLElement;
let canvasWrapper: HTMLElement;
let svgEl: SVGSVGElement;
let configPanel: HTMLElement;
let canvasHint: HTMLElement;
let executionLogs: HTMLElement;
let logsBody: HTMLElement;

// Canvas view transform state
let canvasScale = 1;
let canvasPanX = 0;
let canvasPanY = 0;
let isPanningCanvas = false;

function getDeterministicWorkflowId(workflowData: any): string {
    if (!workflowData) return 'ta_gen_empty';
    const name = workflowData.name || "Generated Workflow";
    const nodes = (workflowData.nodes || []).map((n: any) => ({
        name: n.name || "",
        tool: n.tool || ""
    }));
    const connections = (workflowData.connections || []).map((c: any) => ({
        from: c.from || "",
        to: c.to || ""
    }));
    const payloadStr = JSON.stringify({ name, nodes, connections });

    let hash = 0;
    for (let i = 0; i < payloadStr.length; i++) {
        const char = payloadStr.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return 'ta_gen_det_' + Math.abs(hash).toString(36);
}

// ================================================================
//  EXTERNAL API — called by Chat logic
// ================================================================
export function loadGeneratedWorkflow(workflowData: any) {
    const tasks = loadTasks();
    const targetId = workflowData.id || getDeterministicWorkflowId(workflowData);

    // Check if task already exists
    const existingTask = tasks.find(t => t.id === targetId);

    if (!existingTask) {
        // Create new task object
        const newTask: Task = {
            id: targetId,
            name: workflowData.name || "Generated Workflow",
            description: workflowData.description || "Automatically generated by Zeus",
            nodes: workflowData.nodes || [],
            connections: workflowData.connections || [],
            status: 'finish',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        // Default configs if missing
        newTask.nodes.forEach((n: TaskNode) => {
            if (!n.config) n.config = {};
            if (!n.x || n.x < 10) n.x = 100;
            if (!n.y || n.y < 10) n.y = 100;
        });

        tasks.push(newTask);
        saveTasks(tasks);
    }

    // Ensure we are in the right workspace
    if (typeof (window as any).navigate === 'function') {
        (window as any).pendingWorkflowOpenId = targetId;
        (window as any).navigate('menu-task-allocation');
    } else {
        renderTaskList();
        openEditor(targetId);
    }
}

// ================================================================
//  PUBLIC ENTRY — called after partial HTML is injected
// ================================================================
export function initializeTaskAllocation() {
    // Grab DOM refs
    listingView = document.getElementById('taListingView')!;
    editorView = document.getElementById('taEditorView')!;
    emptyState = document.getElementById('taEmptyState')!;
    tableWrapper = document.getElementById('taTableWrapper')!;
    tableBody = document.getElementById('taTableBody')!;
    canvasEl = document.getElementById('taCanvas')!;
    canvasWrapper = document.getElementById('taCanvasWrapper')!;
    svgEl = document.getElementById('taConnectionsSvg') as unknown as SVGSVGElement;
    configPanel = document.getElementById('taConfigPanel')!;
    canvasHint = document.getElementById('taCanvasHint')!;
    executionLogs = document.getElementById('taExecutionLogs')!;
    logsBody = document.getElementById('taLogsBody')!;

    // Event listeners
    document.getElementById('taCreateBtn')?.addEventListener('click', () => openEditor(null));
    document.getElementById('taEmptyCreateBtn')?.addEventListener('click', () => openEditor(null));
    document.getElementById('taBackBtn')?.addEventListener('click', closeEditor);
    document.getElementById('taCancelBtn')?.addEventListener('click', closeEditor);
    document.getElementById('taSaveBtn')?.addEventListener('click', saveCurrentTask);
    document.getElementById('taEditorRunBtn')?.addEventListener('click', runCurrentTask);

    document.getElementById('taScheduleClose')?.addEventListener('click', closeScheduleSidebar);
    document.getElementById('taScheduleCloseAlt')?.addEventListener('click', closeScheduleSidebar);
    document.getElementById('taScheduleSaveBtn')?.addEventListener('click', saveSchedule);

    // Schedule: freq radio cards → hidden select + visibility
    document.querySelectorAll('.ta-sched-freq-card').forEach(card => {
        card.addEventListener('click', () => {
            const freq = (card as HTMLElement).dataset.freq || 'once';
            const freqEl = document.getElementById('taScheduleFrequency') as HTMLSelectElement;
            freqEl.value = freq;
            freqEl.dispatchEvent(new Event('change'));
        });
    });

    document.getElementById('taScheduleFrequency')?.addEventListener('change', () => {
        updateScheduleUI();
    });

    // Schedule: day pills → hidden select
    document.querySelectorAll('.ta-sched-day-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            const radio = pill.querySelector('input[type=radio]') as HTMLInputElement;
            if (radio) {
                document.getElementById('taScheduleDay')!.setAttribute('value', radio.value);
                (document.getElementById('taScheduleDay') as HTMLSelectElement).value = radio.value;
            }
            updateScheduleSummary();
        });
    });

    // Schedule time changes → summary
    document.getElementById('taScheduleTime')?.addEventListener('change', updateScheduleSummary);

    document.getElementById('taLogsClose')?.addEventListener('click', () => {
        executionLogs.style.display = 'none';
        document.getElementById('taLogsToggleBtn')?.classList.remove('active');
    });
    document.getElementById('taLogsToggleBtn')?.addEventListener('click', () => {
        const btn = document.getElementById('taLogsToggleBtn');
        if (executionLogs.style.display === 'none' || !executionLogs.style.display) {
            executionLogs.style.display = 'flex';
            btn?.classList.add('active');
        } else {
            executionLogs.style.display = 'none';
            btn?.classList.remove('active');
        }
    });

    document.getElementById('taTemplateBtn')?.addEventListener('click', () => {
        saveStateToHistory();
        currentNodes = [];
        currentConnections = [];
        const startId = genId();
        const dbId = genId();
        const endId = genId();

        const startNode: TaskNode = {
            id: startId,
            type: 'start',
            label: TOOL_DEFS['start'].label,
            x: 100,
            y: 150,
            config: {},
        };

        const dbNode: TaskNode = {
            id: dbId,
            type: 'database',
            label: TOOL_DEFS['database'].label,
            x: 350,
            y: 150,
            config: {},
        };

        const endNode: TaskNode = {
            id: endId,
            type: 'end',
            label: TOOL_DEFS['end'].label,
            x: 600,
            y: 150,
            config: {},
        };

        currentNodes.push(startNode, dbNode, endNode);

        const conn1: TaskConnection = {
            id: 'conn_' + Math.random().toString(36).slice(2, 8),
            fromNodeId: startId,
            toNodeId: dbId,
        };

        const conn2: TaskConnection = {
            id: 'conn_' + Math.random().toString(36).slice(2, 8),
            fromNodeId: dbId,
            toNodeId: endId,
        };

        currentConnections.push(conn1, conn2);

        renderCanvas();
    });

    // Bind undo / redo buttons
    document.getElementById('taUndoBtn')?.addEventListener('click', performUndo);
    document.getElementById('taRedoBtn')?.addEventListener('click', performRedo);

    // Bind config panel
    document.getElementById('taConfigClose')?.addEventListener('click', closeConfigPanel);
    document.getElementById('taConfigApply')?.addEventListener('click', applyNodeConfig);


    // Setup drag-and-drop from tool sidebar
    setupToolDragDrop();

    // Canvas mouse events for node dragging and connection drawing
    setupCanvasEvents();

    // Keyboard events
    document.addEventListener('keydown', handleKeyDown);

    // Initial render
    if ((window as any).pendingWorkflowOpenId) {
        const idToOpen = (window as any).pendingWorkflowOpenId;
        (window as any).pendingWorkflowOpenId = null;
        renderTaskList();
        setTimeout(() => openEditor(idToOpen), 50);
    } else {
        renderTaskList();
    }
}

// ================================================================
//  LISTING VIEW
// ================================================================
function renderTaskList() {
    const tasks = loadTasks();

    if (tasks.length === 0) {
        emptyState.style.display = 'flex';
        tableWrapper.style.display = 'none';
    } else {
        emptyState.style.display = 'none';
        tableWrapper.style.display = '';
        tableBody.innerHTML = '';

        tasks.forEach(task => {
            const tr = document.createElement('tr');

            // Name
            const tdName = document.createElement('td');
            tdName.textContent = task.name || 'Untitled Task';
            tr.appendChild(tdName);

            // Description
            const tdDesc = document.createElement('td');
            tdDesc.className = 'ta-task-desc-cell';
            tdDesc.textContent = task.description || '—';
            tdDesc.title = task.description || '';
            tr.appendChild(tdDesc);

            // Tools badges
            const tdTools = document.createElement('td');
            const badgesDiv = document.createElement('div');
            badgesDiv.className = 'ta-tools-badges';
            const uniqueTypes = [...new Set(task.nodes.map(n => n.type))].filter(t => !FLOW_NODES.has(t));

            const maxVisible = 4;
            const typesToRender = uniqueTypes.slice(0, maxVisible);

            typesToRender.forEach(t => {
                const def = TOOL_DEFS[t];
                if (!def) return;
                const badge = document.createElement('span');
                badge.className = 'ta-tool-badge';
                badge.innerHTML = `<i class="${def.icon}"></i> ${def.label}`;
                badgesDiv.appendChild(badge);
            });

            if (uniqueTypes.length > maxVisible) {
                const moreBadge = document.createElement('span');
                moreBadge.className = 'ta-tool-badge ta-tool-badge-more';
                moreBadge.textContent = '...';
                moreBadge.title = uniqueTypes.slice(maxVisible).map(t => TOOL_DEFS[t]?.label || t).join(', ');
                badgesDiv.appendChild(moreBadge);
            }

            if (uniqueTypes.length === 0) {
                badgesDiv.innerHTML = '<span style="color:rgba(255,255,255,.3)">None</span>';
            }
            tdTools.appendChild(badgesDiv);
            tr.appendChild(tdTools);

            // Status
            const tdStatus = document.createElement('td');
            const statusSpan = document.createElement('span');
            statusSpan.className = `ta-status ${task.status}`;
            statusSpan.innerHTML = `<span class="ta-status-dot"></span> ${capitalize(task.status)}`;
            tdStatus.appendChild(statusSpan);
            tr.appendChild(tdStatus);

            // Created date
            const tdDate = document.createElement('td');
            tdDate.textContent = formatDate(task.createdAt);
            tdDate.style.whiteSpace = 'nowrap';
            tr.appendChild(tdDate);

            // Schedule
            const tdSchedule = document.createElement('td');
            tdSchedule.style.whiteSpace = 'nowrap';
            const scheduleSpan = document.createElement('span');

            const freq = task.scheduleFrequency || 'once';
            const time = task.scheduleTime || '';
            const day = task.scheduleDay || 'Monday';

            if (freq === 'daily' && time) {
                let fmtTime = time;
                const [h, m] = time.split(':');
                const hour = parseInt(h);
                const ampm = hour >= 12 ? 'PM' : 'AM';
                const hour12 = hour % 12 || 12;
                fmtTime = `${hour12}:${m} ${ampm}`;

                scheduleSpan.className = 'ta-schedule-badge active';
                scheduleSpan.innerHTML = `<i class="fa-regular fa-clock"></i> Daily at ${fmtTime}`;
            } else if (freq === 'weekly' && time) {
                let fmtTime = time;
                const [h, m] = time.split(':');
                const hour = parseInt(h);
                const ampm = hour >= 12 ? 'PM' : 'AM';
                const hour12 = hour % 12 || 12;
                fmtTime = `${hour12}:${m} ${ampm}`;

                scheduleSpan.className = 'ta-schedule-badge active';
                scheduleSpan.innerHTML = `<i class="fa-regular fa-calendar"></i> ${day} at ${fmtTime}`;
            } else {
                scheduleSpan.className = 'ta-schedule-badge inactive';
                scheduleSpan.textContent = '—';
            }
            tdSchedule.appendChild(scheduleSpan);
            tr.appendChild(tdSchedule);

            // Actions
            const tdActions = document.createElement('td');
            const actionsDiv = document.createElement('div');
            actionsDiv.className = 'ta-actions';

            // Start / Running
            if (task.status === 'running') {
                actionsDiv.appendChild(makeActionBtn('fa-solid fa-spinner fa-spin', 'start', 'Running...', () => { }));
            } else if (task.status === 'scheduled') {
                actionsDiv.appendChild(makeActionBtn('fa-solid fa-pause', 'start', 'Pause schedule', () => pauseSchedule(task.id)));
            } else {
                actionsDiv.appendChild(makeActionBtn('fa-solid fa-play', 'start', 'Run task', () => {
                    if (task.scheduleFrequency === 'daily' || task.scheduleFrequency === 'weekly') {
                        startSchedule(task.id);
                    } else {
                        runTask(task.id);
                    }
                }));
            }
            actionsDiv.appendChild(makeActionBtn('fa-solid fa-pen', 'edit', 'Edit task', () => openEditor(task.id)));
            actionsDiv.appendChild(makeActionBtn('fa-solid fa-trash', 'delete', 'Delete task', () => deleteTask(task.id)));
            actionsDiv.appendChild(makeActionBtn('fa-regular fa-clock', 'schedule', 'Schedule task', () => openScheduleSidebar(task.id)));
            tdActions.appendChild(actionsDiv);
            tr.appendChild(tdActions);

            tableBody.appendChild(tr);
        });
    }
}

function makeActionBtn(iconClass: string, type: string, title: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = `ta-action-btn ${type}`;
    btn.title = title;
    btn.innerHTML = `<i class="${iconClass}"></i>`;
    btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return btn;
}

function saveCurrentTaskData() {
    const nameInput = document.getElementById('taTaskNameInput') as HTMLInputElement;
    const descInput = document.getElementById('taTaskDescInput') as HTMLInputElement;
    const name = nameInput.value.trim() || 'Untitled Task';
    const description = descInput.value.trim();

    const tasks = loadTasks();
    const now = new Date().toISOString();

    if (editingTaskId) {
        const idx = tasks.findIndex(t => t.id === editingTaskId);
        if (idx >= 0) {
            tasks[idx].name = name;
            tasks[idx].description = description;
            tasks[idx].nodes = currentNodes;
            tasks[idx].connections = currentConnections;
            tasks[idx].updatedAt = now;
        }
    } else {
        const newId = genId();
        editingTaskId = newId;
        const newTask: Task = {
            id: newId,
            name,
            description,
            nodes: currentNodes,
            connections: currentConnections,
            status: 'finish',
            createdAt: now,
            updatedAt: now,
        };
        tasks.unshift(newTask);
    }

    saveTasks(tasks);
}

async function runCurrentTask() {
    const isValid = await validateGoogleIntegration();
    if (!isValid) return;

    saveCurrentTaskData();
    if (!editingTaskId) return;
    executionLogs.style.display = 'flex';
    document.getElementById('taLogsToggleBtn')?.classList.add('active');
    logsBody.innerHTML = '';
    await runTask(editingTaskId);
}

async function runTask(id: string) {
    const tasks = loadTasks();
    const task = tasks.find(t => t.id === id);
    if (!task) return;

    if (task.status === 'running') return; // already running

    task.status = 'running';
    task.updatedAt = new Date().toISOString();
    saveTasks(tasks);
    renderTaskList();

    // Reset node glows
    document.querySelectorAll('.ta-node').forEach(node => {
        node.classList.remove('node-glow-executing', 'node-glow-success', 'node-glow-error');
    });

    if (typeof (window as any).showZeusNotification === 'function') {
        (window as any).showZeusNotification(`Task "${task.name}" is executing...`, 'info');
    }

    let userid = undefined;
    const userStr = localStorage.getItem('zeusUser');
    if (userStr) {
        try {
            const user = JSON.parse(userStr);
            userid = user.userid;
        } catch (e) { }
    }

    try {
        const response = await fetch(`${BASE_URL}/api/workflow/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nodes: task.nodes,
                connections: task.connections,
                userid: userid
            })
        });

        if (!response.ok || !response.body) throw new Error('Stream failed');

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let done = false;

        while (!done) {
            const { value, done: readerDone } = await reader.read();
            done = readerDone;
            if (value) {
                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n');
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const data = JSON.parse(line.trim());
                        if (data.type === 'log') {
                            const entry = document.createElement('div');
                            entry.className = 'ta-log-entry';
                            entry.textContent = `[${data.node_id || 'sys'}] ${data.message}`;
                            logsBody.appendChild(entry);
                            logsBody.scrollTop = logsBody.scrollHeight;
                        } else if (data.type === 'status') {
                            const domNode = document.querySelector(`.ta-node[data-node-id="${data.node_id}"]`);
                            if (domNode) {
                                domNode.classList.remove('node-glow-executing', 'node-glow-success', 'node-glow-error');
                                domNode.classList.add(`node-glow-${data.status}`);
                            }
                        } else if (data.type === 'error') {
                            const entry = document.createElement('div');
                            entry.className = 'ta-log-entry error';
                            entry.textContent = `[ERROR] ${data.message}`;
                            logsBody.appendChild(entry);
                            logsBody.scrollTop = logsBody.scrollHeight;
                        }
                    } catch (e) {
                        // might be partial JSON if chunked
                    }
                }
            }
        }

        const currentTasks = loadTasks();
        const currentTask = currentTasks.find(t => t.id === id);
        if (currentTask) {
            currentTask.status = 'finish';
            currentTask.updatedAt = new Date().toISOString();
            saveTasks(currentTasks);
            renderTaskList();
        }

        if (typeof (window as any).showZeusNotification === 'function') {
            (window as any).showZeusNotification(`Task "${task.name}" completed!`, 'success');
        }
    } catch (error: any) {
        console.error('Workflow execution error:', error);
        const currentTasks = loadTasks();
        const currentTask = currentTasks.find(t => t.id === id);
        if (currentTask) {
            currentTask.status = 'finish';
            saveTasks(currentTasks);
            renderTaskList();
        }
        if (typeof (window as any).showZeusNotification === 'function') {
            (window as any).showZeusNotification(`Task Failed: ${error.message || 'Unknown error'}`, 'error');
        }
    }
}

async function deleteTask(id: string) {
    const tasks = loadTasks();
    const task = tasks.find(t => t.id === id);
    if (!task) return;

    let confirmed = true;
    if (typeof (window as any).showZeusConfirm === 'function') {
        confirmed = await (window as any).showZeusConfirm(`Are you sure you want to delete "${task.name || 'Untitled Task'}"?`);
    } else {
        confirmed = confirm(`Delete "${task.name || 'Untitled Task'}"?`);
    }
    if (!confirmed) return;

    const updated = tasks.filter(t => t.id !== id);
    saveTasks(updated);
    renderTaskList();

    if (typeof (window as any).showZeusNotification === 'function') {
        (window as any).showZeusNotification('Task deleted.', 'success');
    }
}

// ================================================================
//  UNDO / REDO STATE HISTORY MANAGEMENT
// ================================================================
function saveStateToHistory() {
    const serialized = JSON.stringify({
        nodes: currentNodes,
        connections: currentConnections
    });

    if (undoStack.length > 0) {
        const lastState = undoStack[undoStack.length - 1];
        const lastSerialized = JSON.stringify({
            nodes: lastState.nodes,
            connections: lastState.connections
        });
        if (serialized === lastSerialized) {
            return; // State is identical, don't save duplicate
        }
    }

    undoStack.push({
        nodes: JSON.parse(JSON.stringify(currentNodes)),
        connections: JSON.parse(JSON.stringify(currentConnections))
    });

    redoStack.length = 0; // Clear redo
    if (undoStack.length > 50) {
        undoStack.shift();
    }
    updateUndoRedoButtons();
}

function performUndo() {
    if (undoStack.length === 0) return;

    const currentState: CanvasState = {
        nodes: JSON.parse(JSON.stringify(currentNodes)),
        connections: JSON.parse(JSON.stringify(currentConnections))
    };
    redoStack.push(currentState);

    const prevState = undoStack.pop()!;
    currentNodes = prevState.nodes;
    currentConnections = prevState.connections;

    // Clear selections
    selectedNodeId = null;
    selectedConnectionId = null;
    closeConfigPanel();

    renderCanvas();
}

function performRedo() {
    if (redoStack.length === 0) return;

    const currentState: CanvasState = {
        nodes: JSON.parse(JSON.stringify(currentNodes)),
        connections: JSON.parse(JSON.stringify(currentConnections))
    };
    undoStack.push(currentState);

    const nextState = redoStack.pop()!;
    currentNodes = nextState.nodes;
    currentConnections = nextState.connections;

    // Clear selections
    selectedNodeId = null;
    selectedConnectionId = null;
    closeConfigPanel();

    renderCanvas();
}

function updateUndoRedoButtons() {
    const undoBtn = document.getElementById('taUndoBtn') as HTMLButtonElement;
    const redoBtn = document.getElementById('taRedoBtn') as HTMLButtonElement;
    if (undoBtn) undoBtn.disabled = undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = redoStack.length === 0;
}

// ================================================================
//  EDITOR — Open / Close
// ================================================================
function openEditor(taskId: string | null) {
    editingTaskId = taskId;
    selectedNodeId = null;
    selectedConnectionId = null;

    // Reset Undo/Redo stacks
    undoStack.length = 0;
    redoStack.length = 0;
    updateUndoRedoButtons();

    if (taskId) {
        const tasks = loadTasks();
        const task = tasks.find(t => t.id === taskId);
        if (task) {
            currentNodes = JSON.parse(JSON.stringify(task.nodes));
            currentConnections = JSON.parse(JSON.stringify(task.connections));
            (document.getElementById('taTaskNameInput') as HTMLInputElement).value = task.name;
            (document.getElementById('taTaskDescInput') as HTMLInputElement).value = task.description || '';
        }
    } else {
        currentNodes = [];
        currentConnections = [];
        (document.getElementById('taTaskNameInput') as HTMLInputElement).value = '';
        (document.getElementById('taTaskDescInput') as HTMLInputElement).value = '';
    }

    listingView.style.display = 'none';
    editorView.style.display = 'flex';
    closeConfigPanel();
    renderCanvas();
}

function closeEditor() {
    editorView.style.display = 'none';
    listingView.style.display = 'flex';
    currentNodes = [];
    currentConnections = [];
    editingTaskId = null;
    selectedNodeId = null;
    renderTaskList();
}

// ================================================================
//  SAVE TASK
// ================================================================
async function validateGoogleIntegration(): Promise<boolean> {
    const hasGmailNode = currentNodes.some(n => n.type === 'gmail');
    const hasCalendarNode = currentNodes.some(n => n.type === 'calendar');

    if (!hasGmailNode && !hasCalendarNode) {
        return true;
    }

    let userid = null;
    const userStr = localStorage.getItem('zeusUser');
    if (userStr) {
        try {
            const user = JSON.parse(userStr);
            userid = user.userid;
        } catch (e) { }
    }

    if (!userid) {
        const msg = "Please connect Google Account first.";
        if (typeof (window as any).showZeusNotification === 'function') {
            (window as any).showZeusNotification(msg, 'error');
        } else {
            alert(msg);
        }
        return false;
    }

    try {
        const response = await fetch(`${BASE_URL}/user/settings?userid=${userid}`);
        if (!response.ok) throw new Error("Failed to fetch settings");
        const settings = await response.json();

        if (!settings.google_connected) {
            const msg = "Please connect Google Account first.";
            if (typeof (window as any).showZeusNotification === 'function') {
                (window as any).showZeusNotification(msg, 'error');
            } else {
                alert(msg);
            }
            return false;
        }

        if (hasGmailNode && !settings.email_enabled) {
            const msg = "Gmail integration is disabled. Please enable Gmail integration in Settings.";
            if (typeof (window as any).showZeusNotification === 'function') {
                (window as any).showZeusNotification(msg, 'error');
            } else {
                alert(msg);
            }
            return false;
        }

        if (hasCalendarNode && !settings.calendar_enabled) {
            const msg = "Google Calendar integration is disabled. Please enable Calendar integration in Settings.";
            if (typeof (window as any).showZeusNotification === 'function') {
                (window as any).showZeusNotification(msg, 'error');
            } else {
                alert(msg);
            }
            return false;
        }
    } catch (e) {
        console.error("Integration validation check failed:", e);
        const msg = "Failed to validate Google integration status. Please check your network connection.";
        if (typeof (window as any).showZeusNotification === 'function') {
            (window as any).showZeusNotification(msg, 'error');
        } else {
            alert(msg);
        }
        return false;
    }

    return true;
}

async function saveCurrentTask() {
    const isValid = await validateGoogleIntegration();
    if (!isValid) return;

    saveCurrentTaskData();
    closeEditor();

    const nameInput = document.getElementById('taTaskNameInput') as HTMLInputElement;
    const name = nameInput.value.trim() || 'Untitled Task';
    if (typeof (window as any).showZeusNotification === 'function') {
        (window as any).showZeusNotification(`Task "${name}" saved successfully.`, 'success');
    }
}

// ================================================================
//  CANVAS RENDERING
// ================================================================
function renderCanvas() {
    // Clear canvas nodes (keep hint)
    const existingNodes = canvasEl.querySelectorAll('.ta-node');
    existingNodes.forEach(n => n.remove());

    // Render each node
    currentNodes.forEach(node => renderNodeElement(node));

    // Render connections
    renderConnections();

    // Show/hide hint
    updateCanvasHint();
}

function getConfigSummary(node: TaskNode): string {
    const c = node.config || {};
    switch (node.type) {
        case 'gmail': return c.to ? `To: ${c.to}` : '';
        case 'calendar': return c.date ? `Date: ${c.date}` : '';
        case 'database': return c.db ? `DB: ${c.db}` : '';
        case 'api': return c.api ? `API: ${c.api}` : '';
        case 'web_search': return c.url ? `URL: ${c.url}` : '';
        case 'ocr': return 'Extract Text';
        case 'llm': return c.prompt || '';
        case 'report': return c.filename ? `File: ${c.filename}` : '';
        default: return '';
    }
}

function renderNodeElement(node: TaskNode) {
    const def = TOOL_DEFS[node.type] || { label: node.type, icon: 'fa-solid fa-cube', color: '#6366f1' };
    const isStart = node.type === 'start';
    const isEnd = node.type === 'end';
    const isFlow = isStart || isEnd;

    const el = document.createElement('div');
    el.className = 'ta-node' + (node.id === selectedNodeId ? ' selected' : '') + (isFlow ? ' ta-node-flow' : '');
    el.dataset.nodeId = node.id;
    el.dataset.type = node.type;
    el.style.left = node.x + 'px';
    el.style.top = node.y + 'px';

    // Start nodes: output port only. End nodes: input port only. Tools: both.
    const inputPortHtml = !isStart ? `<div class="ta-port ta-port-input" data-port="input" data-node-id="${node.id}"></div>` : '';
    const outputPortHtml = !isEnd ? `<div class="ta-port ta-port-output" data-port="output" data-node-id="${node.id}"></div>` : '';

    // Flow nodes don't show the prompt body
    const summary = getConfigSummary(node);
    const bodyHtml = isFlow ? '' : `
        <div class="ta-node-body">
            <div class="ta-node-prompt-preview ${summary ? 'has-prompt' : ''}" data-config-node="${node.id}">
                ${summary ? escapeHtml(summary) : '<i style="opacity:.6">Click to configure…</i>'}
            </div>
        </div>
    `;

    el.innerHTML = `
        ${inputPortHtml}
        ${outputPortHtml}
        <div class="ta-node-header">
            <div class="ta-node-icon"><i class="${def.icon}"></i></div>
            <span class="ta-node-label">${def.label}</span>
            <button class="ta-node-delete" data-delete-node="${node.id}" title="Remove node">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
        ${bodyHtml}
    `;

    canvasEl.appendChild(el);

    // Delete button
    el.querySelector(`[data-delete-node="${node.id}"]`)?.addEventListener('click', (e) => {
        e.stopPropagation();
        removeNode(node.id);
    });

    // Click prompt preview to open config (only for tool nodes)
    if (!isFlow) {
        el.querySelector(`[data-config-node="${node.id}"]`)?.addEventListener('click', (e) => {
            e.stopPropagation();
            selectNode(node.id);
        });
    }

    // Click the node itself to select
    el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isFlow) {
            // Just highlight, don't open config for flow nodes
            selectedNodeId = node.id;
            selectedConnectionId = null;
            canvasEl.querySelectorAll('.ta-node').forEach(n => n.classList.remove('selected'));
            el.classList.add('selected');
            svgEl.querySelectorAll('path').forEach(p => p.classList.remove('ta-conn-selected'));
            closeConfigPanel();
        } else {
            selectNode(node.id);
        }
    });

    // Node header mousedown for dragging
    const header = el.querySelector('.ta-node-header') as HTMLElement;
    header.addEventListener('mousedown', (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest('.ta-node-delete')) return;
        e.stopPropagation();
        startNodeDrag(node.id, e);
    });

    // Port events for connection drawing
    const outputPort = el.querySelector('[data-port="output"]') as HTMLElement;
    const inputPort = el.querySelector('[data-port="input"]') as HTMLElement;

    if (outputPort) {
        outputPort.addEventListener('mousedown', (e: MouseEvent) => {
            e.stopPropagation();
            e.preventDefault();
            startConnectionDraw(node.id, e);
        });
    }

    if (inputPort) {
        inputPort.addEventListener('mouseup', (e: MouseEvent) => {
            e.stopPropagation();
            finishConnectionDraw(node.id);
        });
    }
}

function updateCanvasHint() {
    if (currentNodes.length > 0) {
        canvasHint.classList.add('hidden');
    } else {
        canvasHint.classList.remove('hidden');
    }
}

function removeNode(nodeId: string) {
    saveStateToHistory();
    currentNodes = currentNodes.filter(n => n.id !== nodeId);
    currentConnections = currentConnections.filter(c => c.fromNodeId !== nodeId && c.toNodeId !== nodeId);
    if (selectedNodeId === nodeId) {
        selectedNodeId = null;
        closeConfigPanel();
    }
    renderCanvas();
}

// ================================================================
//  NODE SELECTION & CONFIG PANEL
// ================================================================
function selectNode(nodeId: string) {
    // Deselect connection
    selectedConnectionId = null;

    selectedNodeId = nodeId;

    // Highlight the node
    canvasEl.querySelectorAll('.ta-node').forEach(n => n.classList.remove('selected'));
    const nodeEl = canvasEl.querySelector(`[data-node-id="${nodeId}"]`);
    nodeEl?.classList.add('selected');

    // Deselect connections visually
    svgEl.querySelectorAll('path').forEach(p => p.classList.remove('ta-conn-selected'));

    // Open config panel
    const node = currentNodes.find(n => n.id === nodeId);
    if (!node) return;

    const def = TOOL_DEFS[node.type] || { label: node.type, icon: 'fa-solid fa-cube', color: '#6366f1' };

    const configIcon = document.getElementById('taConfigIcon') as HTMLElement;
    const configTitle = document.getElementById('taConfigTitle') as HTMLElement;
    configIcon.className = def.icon;
    configIcon.style.color = def.color;
    configTitle.textContent = def.label;

    // Dynamic config rendering
    const dynamicConfigContainer = document.getElementById('taNodeDynamicConfig');
    if (dynamicConfigContainer) {
        let configHtml = '';
        const c = node.config || {};
        switch (node.type) {
            case 'gmail':
                configHtml = `
                    <div class="ta-config-group"><label>To Email</label><input type="email" id="cfg_to" class="ta-task-name-input" value="${c.to || ''}" placeholder="recipient@example.com" /></div>
                    <div class="ta-config-group"><label>CC Email</label><input type="email" id="cfg_cc" class="ta-task-name-input" value="${c.cc || ''}" placeholder="cc@example.com" /></div>
                `;
                break;
            case 'calendar':
                configHtml = `
                    <div class="ta-config-group"><label>Date</label><input type="date" id="cfg_date" class="ta-task-name-input" value="${c.date || ''}" /></div>
                    <div class="ta-config-group"><label>Time</label><input type="time" id="cfg_time" class="ta-task-name-input" value="${c.time || ''}" /></div>
                    <div class="ta-config-group"><label>Event Info</label><input type="text" id="cfg_info" class="ta-task-name-input" value="${c.info || ''}" placeholder="Meeting topic..." /></div>
                `;
                break;
            case 'database':
                configHtml = `
                    <div class="ta-config-group"><label>Target Database</label>
                    <select id="cfg_db">
                        <option value="">Loading Databases...</option>
                    </select></div>
                `;
                fetch(`${BASE_URL}/api/db_connections`)
                    .then(r => r.json())
                    .then(dbs => {
                        const selectEl = document.getElementById('cfg_db') as HTMLSelectElement;
                        if (selectEl) {
                            selectEl.innerHTML = '<option value="">Select Database...</option>' +
                                dbs.map((db: any) => `<option value="${db.database_name || db.name}" ${c.db === (db.database_name || db.name) ? 'selected' : ''}>${db.name}</option>`).join('');
                        }
                    })
                    .catch(e => console.error("Failed to load DBs", e));
                break;
            case 'api':
                configHtml = `
                    <div class="ta-config-group"><label>Target API</label>
                    <select id="cfg_api">
                        <option value="">Loading APIs...</option>
                    </select></div>
                `;
                fetch(`${BASE_URL}/api/api_connections`)
                    .then(r => r.json())
                    .then(apis => {
                        const selectEl = document.getElementById('cfg_api') as HTMLSelectElement;
                        if (selectEl) {
                            selectEl.innerHTML = '<option value="">Select API Endpoint...</option>' +
                                apis.map((api: any) => `<option value="${api.apiName || api.name}" ${c.api === (api.apiName || api.name) ? 'selected' : ''}>${api.apiName || api.name}</option>`).join('');
                        }
                    })
                    .catch(e => console.error("Failed to load APIs", e));
                break;
            case 'web_search':
                configHtml = `
                    <div class="ta-config-group"><label>Search URL / Query</label><input type="text" id="cfg_url" class="ta-task-name-input" value="${c.url || ''}" placeholder="https://..." /></div>
                `;
                break;
            case 'ocr':
                configHtml = `<div class="ta-config-group"><label style="opacity:0.6; font-weight:normal; text-transform:none; margin-bottom:0;">No configuration required. Automatically extracts text from provided documents.</label></div>`;
                break;
            case 'llm':
                configHtml = `
                    <div class="ta-config-group"><label>LLM Prompt</label><textarea id="cfg_prompt" rows="5" placeholder="Write instructions for the AI...">${c.prompt || ''}</textarea></div>
                `;
                break;
            case 'report':
                configHtml = `
                    <div class="ta-config-group"><label>PDF Filename</label><input type="text" id="cfg_filename" class="ta-task-name-input" value="${c.filename || ''}" placeholder="report.pdf" /></div>
                `;
                break;
        }
        dynamicConfigContainer.innerHTML = configHtml;
    }

    configPanel.style.display = 'flex';
}

function closeConfigPanel() {
    configPanel.style.display = 'none';
    selectedNodeId = null;
    canvasEl.querySelectorAll('.ta-node').forEach(n => n.classList.remove('selected'));
}

function applyNodeConfig() {
    if (!selectedNodeId) return;
    const node = currentNodes.find(n => n.id === selectedNodeId);
    if (!node) return;

    saveStateToHistory();

    // Save dynamic config
    const c: Record<string, string> = {};
    switch (node.type) {
        case 'gmail':
            c.to = (document.getElementById('cfg_to') as HTMLInputElement)?.value || '';
            c.cc = (document.getElementById('cfg_cc') as HTMLInputElement)?.value || '';
            break;
        case 'calendar':
            c.date = (document.getElementById('cfg_date') as HTMLInputElement)?.value || '';
            c.time = (document.getElementById('cfg_time') as HTMLInputElement)?.value || '';
            c.info = (document.getElementById('cfg_info') as HTMLInputElement)?.value || '';
            break;
        case 'database':
            c.db = (document.getElementById('cfg_db') as HTMLSelectElement)?.value || '';
            break;
        case 'api':
            c.api = (document.getElementById('cfg_api') as HTMLSelectElement)?.value || '';
            break;
        case 'web_search':
            c.url = (document.getElementById('cfg_url') as HTMLInputElement)?.value || '';
            break;
        case 'llm':
            c.prompt = (document.getElementById('cfg_prompt') as HTMLTextAreaElement)?.value || '';
            break;
        case 'report':
            c.filename = (document.getElementById('cfg_filename') as HTMLInputElement)?.value || '';
            break;
    }
    node.config = c;

    // Update the prompt preview on the node
    const nodeEl = canvasEl.querySelector(`[data-node-id="${selectedNodeId}"]`);
    const preview = nodeEl?.querySelector('.ta-node-prompt-preview');
    if (preview) {
        const summary = getConfigSummary(node);
        if (summary) {
            preview.classList.add('has-prompt');
            preview.textContent = summary;
        } else {
            preview.classList.remove('has-prompt');
            preview.innerHTML = '<i style="opacity:.6">Click to configure…</i>';
        }
    }

    if (typeof (window as any).showZeusNotification === 'function') {
        (window as any).showZeusNotification('Node configuration applied.', 'success');
    }
}



// ================================================================
//  DRAG & DROP — Tool Sidebar → Canvas
// ================================================================
function setupToolDragDrop() {
    const toolCards = document.querySelectorAll('.ta-tool-card[draggable="true"]');
    toolCards.forEach(card => {
        card.addEventListener('dragstart', (e: Event) => {
            const de = e as DragEvent;
            const toolType = (card as HTMLElement).dataset.toolType || '';
            de.dataTransfer?.setData('text/plain', toolType);
            de.dataTransfer!.effectAllowed = 'copy';

            // Create custom drag ghost
            const def = TOOL_DEFS[toolType];
            if (def) {
                const ghost = document.createElement('div');
                ghost.className = 'ta-drag-ghost';
                ghost.innerHTML = `<i class="${def.icon}" style="color:${def.color}"></i> ${def.label}`;
                document.body.appendChild(ghost);
                de.dataTransfer?.setDragImage(ghost, 40, 20);
                setTimeout(() => ghost.remove(), 0);
            }
        });
    });

    canvasWrapper.addEventListener('dragover', (e: DragEvent) => {
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'copy';
        canvasWrapper.classList.add('drag-over');
    });

    canvasWrapper.addEventListener('dragleave', () => {
        canvasWrapper.classList.remove('drag-over');
    });

    canvasWrapper.addEventListener('drop', (e: DragEvent) => {
        e.preventDefault();
        canvasWrapper.classList.remove('drag-over');

        const toolType = e.dataTransfer?.getData('text/plain');
        if (!toolType || !TOOL_DEFS[toolType]) return;

        if (toolType === 'start' || toolType === 'end') {
            const exists = currentNodes.some(n => n.type === toolType);
            if (exists) {
                const label = TOOL_DEFS[toolType].label;
                if (typeof (window as any).showZeusNotification === 'function') {
                    (window as any).showZeusNotification(`Only one ${label} node is allowed in a workflow.`, 'error');
                } else {
                    alert(`Only one ${label} node is allowed in a workflow.`);
                }
                return;
            }
        }

        const rect = canvasWrapper.getBoundingClientRect();
        const x = e.clientX - rect.left - 90; // center the node roughly
        const y = e.clientY - rect.top - 30;

        const newNode: TaskNode = {
            id: genId(),
            type: toolType,
            label: TOOL_DEFS[toolType].label,
            x: Math.max(10, x),
            y: Math.max(10, y),
            config: {},
        };

        saveStateToHistory();
        currentNodes.push(newNode);
        renderNodeElement(newNode);
        updateCanvasHint();
    });
}

// ================================================================
//  NODE DRAGGING ON CANVAS
// ================================================================
function startNodeDrag(nodeId: string, e: MouseEvent) {
    preDragState = {
        nodes: JSON.parse(JSON.stringify(currentNodes)),
        connections: JSON.parse(JSON.stringify(currentConnections))
    };
    isDraggingNode = true;
    dragNodeId = nodeId;
    const nodeEl = canvasEl.querySelector(`[data-node-id="${nodeId}"]`) as HTMLElement;
    if (!nodeEl) return;
    const rect = nodeEl.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    nodeEl.style.zIndex = '10';
    nodeEl.style.transition = 'none';
}

function applyCanvasTransform() {
    const transform = `translate(${canvasPanX}px, ${canvasPanY}px) scale(${canvasScale})`;
    canvasEl.style.transform = transform;
    svgEl.style.transform = transform;
    canvasEl.style.transformOrigin = '0 0';
    svgEl.style.transformOrigin = '0 0';
}

function setupCanvasEvents() {
    canvasWrapper.addEventListener('wheel', (e: WheelEvent) => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            canvasScale *= delta;
            canvasScale = Math.min(Math.max(0.2, canvasScale), 3);
            applyCanvasTransform();
        } else {
            // Pan with mouse wheel/trackpad
            canvasPanY -= e.deltaY;
            canvasPanX -= e.deltaX;
            applyCanvasTransform();
        }
    }, { passive: false });

    canvasWrapper.addEventListener('mousedown', (e: MouseEvent) => {
        if (e.target === canvasWrapper || e.target === canvasEl || (e.target as HTMLElement).closest('.ta-canvas-hint')) {
            isPanningCanvas = true;
        }
    });

    canvasWrapper.addEventListener('mousemove', (e: MouseEvent) => {
        if (isPanningCanvas) {
            canvasPanX += e.movementX;
            canvasPanY += e.movementY;
            applyCanvasTransform();
            return;
        }

        // Node dragging
        if (isDraggingNode && dragNodeId) {
            const wrapperRect = canvasWrapper.getBoundingClientRect();
            const x = (e.clientX - wrapperRect.left - dragOffsetX - canvasPanX) / canvasScale;
            const y = (e.clientY - wrapperRect.top - dragOffsetY - canvasPanY) / canvasScale;

            const node = currentNodes.find(n => n.id === dragNodeId);
            if (node) {
                node.x = Math.max(0, x);
                node.y = Math.max(0, y);
                const nodeEl = canvasEl.querySelector(`[data-node-id="${dragNodeId}"]`) as HTMLElement;
                if (nodeEl) {
                    nodeEl.style.left = node.x + 'px';
                    nodeEl.style.top = node.y + 'px';
                }
                renderConnections();
            }
        }

        // Connection drawing
        if (isDrawingConnection && connectionStartNodeId && tempConnectionLine) {
            const wrapperRect = canvasWrapper.getBoundingClientRect();
            const mx = (e.clientX - wrapperRect.left - canvasPanX) / canvasScale;
            const my = (e.clientY - wrapperRect.top - canvasPanY) / canvasScale;

            const startNode = currentNodes.find(n => n.id === connectionStartNodeId);
            if (startNode) {
                const startEl = canvasEl.querySelector(`[data-node-id="${connectionStartNodeId}"]`) as HTMLElement;
                if (startEl) {
                    const startPort = startEl.querySelector('.ta-port-output') as HTMLElement;
                    const portRect = startPort.getBoundingClientRect();
                    const sx = (portRect.left + portRect.width / 2 - wrapperRect.left - canvasPanX) / canvasScale;
                    const sy = (portRect.top + portRect.height / 2 - wrapperRect.top - canvasPanY) / canvasScale;
                    tempConnectionLine.setAttribute('d', makeBezierPath(sx, sy, mx, my));
                }
            }
        }
    });

    canvasWrapper.addEventListener('mouseup', () => {
        // End node drag
        if (isDraggingNode && dragNodeId) {
            const nodeEl = canvasEl.querySelector(`[data-node-id="${dragNodeId}"]`) as HTMLElement;
            if (nodeEl) {
                nodeEl.style.zIndex = '3';
                nodeEl.style.transition = '';
            }
            isDraggingNode = false;
            dragNodeId = null;

            // Check if position changed
            if (preDragState) {
                const serializedCurrent = JSON.stringify(currentNodes);
                const serializedPre = JSON.stringify(preDragState.nodes);
                if (serializedCurrent !== serializedPre) {
                    undoStack.push(preDragState);
                    redoStack.length = 0; // Clear redo
                    updateUndoRedoButtons();
                }
                preDragState = null;
            }
        }

        // Cancel connection drawing if not dropped on port
        if (isDrawingConnection) {
            cancelConnectionDraw();
        }
        isPanningCanvas = false;
    });

    // Deselect nodes/connections when clicking empty canvas
    canvasWrapper.addEventListener('click', (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (target === canvasEl || target === canvasWrapper || target.closest('.ta-canvas-hint')) {
            selectedNodeId = null;
            selectedConnectionId = null;
            canvasEl.querySelectorAll('.ta-node').forEach(n => n.classList.remove('selected'));
            svgEl.querySelectorAll('path').forEach(p => p.classList.remove('ta-conn-selected'));
            closeConfigPanel();
        }
    });
}

// ================================================================
//  CONNECTION DRAWING
// ================================================================
function startConnectionDraw(fromNodeId: string, e: MouseEvent) {
    isDrawingConnection = true;
    connectionStartNodeId = fromNodeId;

    const wrapperRect = canvasWrapper.getBoundingClientRect();
    const portEl = e.currentTarget as HTMLElement;
    const portRect = portEl.getBoundingClientRect();

    const sx = (portRect.left + portRect.width / 2 - wrapperRect.left - canvasPanX) / canvasScale;
    const sy = (portRect.top + portRect.height / 2 - wrapperRect.top - canvasPanY) / canvasScale;

    tempConnectionLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tempConnectionLine.setAttribute('class', 'ta-conn-temp');
    tempConnectionLine.setAttribute('d', makeBezierPath(sx, sy, sx, sy));
    svgEl.appendChild(tempConnectionLine);
}

function finishConnectionDraw(toNodeId: string) {
    if (!isDrawingConnection || !connectionStartNodeId) return;
    if (connectionStartNodeId === toNodeId) { cancelConnectionDraw(); return; }

    // Check for duplicate
    const exists = currentConnections.some(
        c => c.fromNodeId === connectionStartNodeId && c.toNodeId === toNodeId
    );
    if (!exists) {
        saveStateToHistory();
        currentConnections.push({
            id: genId(),
            fromNodeId: connectionStartNodeId!,
            toNodeId,
        });
    }

    cancelConnectionDraw();
    renderConnections();
}

function cancelConnectionDraw() {
    isDrawingConnection = false;
    connectionStartNodeId = null;
    if (tempConnectionLine && tempConnectionLine.parentNode) {
        tempConnectionLine.parentNode.removeChild(tempConnectionLine);
    }
    tempConnectionLine = null;
}

// ================================================================
//  CONNECTION RENDERING (SVG Bezier)
// ================================================================
function renderConnections() {
    // Remove all existing groups and paths except temp
    svgEl.querySelectorAll('g.ta-conn-group').forEach(g => g.remove());
    svgEl.querySelectorAll('path:not(.ta-conn-temp)').forEach(p => p.remove());

    const wrapperRect = canvasWrapper.getBoundingClientRect();

    currentConnections.forEach(conn => {
        const fromEl = canvasEl.querySelector(`[data-node-id="${conn.fromNodeId}"]`) as HTMLElement;
        const toEl = canvasEl.querySelector(`[data-node-id="${conn.toNodeId}"]`) as HTMLElement;
        if (!fromEl || !toEl) return;

        const fromPort = fromEl.querySelector('.ta-port-output') as HTMLElement;
        const toPort = toEl.querySelector('.ta-port-input') as HTMLElement;
        if (!fromPort || !toPort) return;

        const fromRect = fromPort.getBoundingClientRect();
        const toRect = toPort.getBoundingClientRect();

        const sx = fromRect.left + fromRect.width / 2 - wrapperRect.left;
        const sy = fromRect.top + fromRect.height / 2 - wrapperRect.top;
        const ex = toRect.left + toRect.width / 2 - wrapperRect.left;
        const ey = toRect.top + toRect.height / 2 - wrapperRect.top;

        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.setAttribute('class', 'ta-conn-group');
        g.dataset.connectionId = conn.id;

        const pathVisible = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        pathVisible.setAttribute('d', makeBezierPath(sx, sy, ex, ey));
        pathVisible.dataset.connectionId = conn.id;
        pathVisible.style.pointerEvents = 'stroke';
        pathVisible.style.cursor = 'pointer';

        if (conn.id === selectedConnectionId) {
            pathVisible.classList.add('ta-conn-selected');
        }

        const pathInteractive = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        pathInteractive.setAttribute('d', makeBezierPath(sx, sy, ex, ey));
        pathInteractive.setAttribute('class', 'ta-conn-interactive');
        pathInteractive.dataset.connectionId = conn.id;

        g.addEventListener('click', (e) => {
            e.stopPropagation();
            selectConnection(conn.id);
        });

        g.appendChild(pathVisible);
        g.appendChild(pathInteractive);
        svgEl.appendChild(g);
    });
}

function makeBezierPath(sx: number, sy: number, ex: number, ey: number): string {
    const dx = Math.abs(ex - sx) * 0.5;
    const cp1x = sx + dx;
    const cp2x = ex - dx;
    return `M ${sx} ${sy} C ${cp1x} ${sy}, ${cp2x} ${ey}, ${ex} ${ey}`;
}

function selectConnection(connId: string) {
    selectedConnectionId = connId;
    selectedNodeId = null;
    canvasEl.querySelectorAll('.ta-node').forEach(n => n.classList.remove('selected'));
    closeConfigPanel();

    svgEl.querySelectorAll('path:not(.ta-conn-interactive)').forEach(p => {
        if ((p as SVGPathElement).dataset.connectionId === connId) {
            p.classList.add('ta-conn-selected');
        } else {
            p.classList.remove('ta-conn-selected');
        }
    });
}

// ================================================================
//  KEYBOARD HANDLING
// ================================================================
function handleKeyDown(e: KeyboardEvent) {
    // Only act if editor is visible
    if (editorView.style.display === 'none') return;

    // Don't intercept if user is typing in an input/textarea
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    const isCtrlOrMeta = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    // Ctrl+Z (Undo)
    if (isCtrlOrMeta && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        performUndo();
        return;
    }

    // Ctrl+Y or Ctrl+Shift+Z (Redo)
    if (isCtrlOrMeta && (key === 'y' || (key === 'z' && e.shiftKey))) {
        e.preventDefault();
        performRedo();
        return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedConnectionId) {
            saveStateToHistory();
            currentConnections = currentConnections.filter(c => c.id !== selectedConnectionId);
            selectedConnectionId = null;
            renderConnections();
        } else if (selectedNodeId) {
            removeNode(selectedNodeId);
        }
    }

    if (e.key === 'Escape') {
        if (configPanel.style.display !== 'none') {
            closeConfigPanel();
        } else if (isDrawingConnection) {
            cancelConnectionDraw();
        }
    }
}

// ================================================================
//  UTILITIES
// ================================================================
function capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function formatDate(iso: string): string {
    try {
        const d = new Date(iso);
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch {
        return iso;
    }
}

function escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ================================================================
//  SCHEDULE SIDEBAR LOGIC
// ================================================================

function openScheduleSidebar(taskId: string) {
    currentScheduleTaskId = taskId;
    const task = loadTasks().find(t => t.id === taskId);
    if (!task) return;

    // Set task name in subtitle
    const subtitleEl = document.getElementById('taScheduleTaskName');
    if (subtitleEl) subtitleEl.textContent = task.name || 'Untitled Task';

    const freqEl = document.getElementById('taScheduleFrequency') as HTMLSelectElement;
    const timeEl = document.getElementById('taScheduleTime') as HTMLInputElement;
    const savedFreq = task.scheduleFrequency || 'once';

    freqEl.value = savedFreq;
    timeEl.value = task.scheduleTime || '';

    // Sync day pills
    const savedDay = task.scheduleDay || 'Monday';
    document.querySelectorAll('.ta-sched-day-pill input[type=radio]').forEach(radio => {
        (radio as HTMLInputElement).checked = (radio as HTMLInputElement).value === savedDay;
    });
    (document.getElementById('taScheduleDay') as HTMLSelectElement).value = savedDay;

    // Update UI (card highlights + section visibility + summary)
    updateScheduleUI();

    document.getElementById('taScheduleSidebar')!.style.display = 'flex';
}

function closeScheduleSidebar() {
    currentScheduleTaskId = null;
    document.getElementById('taScheduleSidebar')!.style.display = 'none';
}

function saveSchedule() {
    if (!currentScheduleTaskId) return;
    const tasks = loadTasks();
    const task = tasks.find(t => t.id === currentScheduleTaskId);
    if (!task) return;

    const freqEl = document.getElementById('taScheduleFrequency') as HTMLSelectElement;
    const timeEl = document.getElementById('taScheduleTime') as HTMLInputElement;

    task.scheduleFrequency = freqEl.value;
    task.scheduleTime = timeEl.value;

    // Read day from radio group
    const checkedDayRadio = document.querySelector('.ta-sched-day-pill input[type=radio]:checked') as HTMLInputElement;
    task.scheduleDay = checkedDayRadio ? checkedDayRadio.value : 'Monday';

    // If already scheduled and changed to "once", stop schedule
    if (task.status === 'scheduled' && task.scheduleFrequency === 'once') {
        task.status = 'finish';
    }

    saveTasks(tasks);
    closeScheduleSidebar();
    renderTaskList();

    if (typeof (window as any).showZeusNotification === 'function') {
        (window as any).showZeusNotification('Schedule saved', 'success');
    }
}

function startSchedule(taskId: string) {
    const tasks = loadTasks();
    const task = tasks.find(t => t.id === taskId);
    if (task) {
        task.status = 'scheduled';
        saveTasks(tasks);
        renderTaskList();
        if (typeof (window as any).showZeusNotification === 'function') {
            (window as any).showZeusNotification('Task scheduled successfully', 'success');
        }
    }
}

function pauseSchedule(taskId: string) {
    const tasks = loadTasks();
    const task = tasks.find(t => t.id === taskId);
    if (task) {
        task.status = 'finish';
        saveTasks(tasks);
        renderTaskList();
        if (typeof (window as any).showZeusNotification === 'function') {
            (window as any).showZeusNotification('Schedule paused', 'success');
        }
    }
}

function updateScheduleUI() {
    const freqEl = document.getElementById('taScheduleFrequency') as HTMLSelectElement;
    const val = freqEl?.value || 'once';

    const dayContainer = document.getElementById('taScheduleDayContainer')!;
    const timeContainer = document.getElementById('taScheduleTimeContainer')!;

    // Show/hide sections
    if (val === 'weekly') {
        dayContainer.style.display = 'flex';
        timeContainer.style.display = 'flex';
    } else if (val === 'daily') {
        dayContainer.style.display = 'none';
        timeContainer.style.display = 'flex';
    } else {
        dayContainer.style.display = 'none';
        timeContainer.style.display = 'none';
    }

    // Sync freq card highlight
    document.querySelectorAll('.ta-sched-freq-card').forEach(card => {
        const radio = card.querySelector('input[type=radio]') as HTMLInputElement;
        if (radio) radio.checked = radio.value === val;
    });

    updateScheduleSummary();
}

function updateScheduleSummary() {
    const freqEl = document.getElementById('taScheduleFrequency') as HTMLSelectElement;
    const dayEl = document.getElementById('taScheduleDay') as HTMLSelectElement;
    const timeEl = document.getElementById('taScheduleTime') as HTMLInputElement;
    const summaryEl = document.getElementById('taSchedSummaryText');
    if (!summaryEl) return;

    const freq = freqEl?.value || 'once';
    const time = timeEl?.value || '';
    const day = dayEl?.value || 'Monday';

    let fmtTime = time;
    if (time) {
        const [h, m] = time.split(':');
        const hour = parseInt(h);
        const ampm = hour >= 12 ? 'PM' : 'AM';
        const hour12 = hour % 12 || 12;
        fmtTime = `${hour12}:${m} ${ampm}`;
    }

    if (freq === 'once') {
        summaryEl.textContent = 'Task will run once when you press the Play button.';
    } else if (freq === 'daily') {
        summaryEl.textContent = time
            ? `Task will run every day at ${fmtTime}. Press Play to activate — Pause to stop.`
            : 'Choose a time for the daily run.';
    } else if (freq === 'weekly') {
        summaryEl.textContent = time
            ? `Task will run every ${day} at ${fmtTime}. Press Play to activate — Pause to stop.`
            : `Task will run every ${day}. Set a time to complete the schedule.`;
    }
}
