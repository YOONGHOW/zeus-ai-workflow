import { showNotification } from './notification';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || (window as any).BASE_URL || 'http://127.0.0.1:8080';
let currentFile: File | null = null;
let currentDocumentId: string | null = null;
let currentScale = 1.0;
let currentData: any = {};
let selectionMode = { active: false, field: "" };
let allOCRDetails: any[] = [];

let pageCanvases: HTMLCanvasElement[] = [];
let currentPageIndex = 0;
let ocrDocumentLoader: ((file: File, autoProcess?: boolean, fileId?: string) => Promise<void>) | null = null;
declare const pdfjsLib: any;

export async function loadDocumentIntoOCR(file: File, autoProcess = false, fileId?: string): Promise<boolean> {
    if (!ocrDocumentLoader) {
        console.warn("OCR workspace is not ready yet.");
        return false;
    }

    await ocrDocumentLoader(file, autoProcess, fileId);
    return true;
}

export function initializeOCRPage() {
    console.log("Initializing Unified Workspace (Extract + Highlight Mode)...");

    // --- DOM ELEMENTS ---
    const elements = {
        fileInput: document.getElementById('ocrFileInput') as HTMLInputElement | null,
        uploadBtn: document.getElementById('ocrUploadBtn') as HTMLButtonElement | null,
        processBtn: document.getElementById('processBtn') as HTMLButtonElement | null,
        container: document.getElementById('ocrContainer') as HTMLDivElement,
        resultsContainer: document.getElementById('jsonOutput') as HTMLDivElement,
        fileName: document.getElementById('fileNameDisplay') as HTMLDivElement | null,
        textResults: document.getElementById('textResults') as HTMLDivElement,
        checklist: document.getElementById('fieldChecklist') as HTMLDivElement,

        statusMessage: document.getElementById('ocrStatusMessage') as HTMLDivElement,

        zoomIn: document.getElementById('zoomIn') as HTMLButtonElement,
        zoomOut: document.getElementById('zoomOut') as HTMLButtonElement,
        zoomLevel: document.getElementById('zoomLevel') as HTMLSpanElement,
        prevPageBtn: document.getElementById('prevPageBtn') as HTMLButtonElement | null,
        nextPageBtn: document.getElementById('nextPageBtn') as HTMLButtonElement | null,
        pageIndicator: document.getElementById('pageIndicator') as HTMLSpanElement | null,
        paginationSeparator: document.getElementById('paginationSeparator') as HTMLDivElement | null,

    };
    // 1. SETUP UI
    if (elements.checklist) {
        elements.checklist.innerHTML = `
        <p style="font-size: 12px; color: #7f8c8d; text-align: center; padding: 20px;">
            Upload and process a file to see detected fields.
        </p>`;
    }

    const updatePaginationUI = () => {
        if (pageCanvases.length <= 1) {
            if (elements.prevPageBtn) elements.prevPageBtn.style.display = 'none';
            if (elements.nextPageBtn) elements.nextPageBtn.style.display = 'none';
            if (elements.pageIndicator) elements.pageIndicator.style.display = 'none';
            if (elements.paginationSeparator) elements.paginationSeparator.style.display = 'none';
            pageCanvases.forEach(canvas => canvas.style.display = 'block');
            return;
        }

        if (elements.prevPageBtn) elements.prevPageBtn.style.display = 'flex';
        if (elements.nextPageBtn) elements.nextPageBtn.style.display = 'flex';
        if (elements.paginationSeparator) elements.paginationSeparator.style.display = 'block';
        if (elements.pageIndicator) {
            elements.pageIndicator.style.display = 'inline-block';
            elements.pageIndicator.textContent = `${currentPageIndex + 1} / ${pageCanvases.length}`;
        }

        pageCanvases.forEach((canvas, idx) => {
            canvas.style.display = idx === currentPageIndex ? 'block' : 'none';
        });
    };

    if (elements.prevPageBtn) {
        elements.prevPageBtn.onclick = () => {
            if (currentPageIndex > 0) {
                currentPageIndex--;
                updatePaginationUI();
            }
        };
    }
    if (elements.nextPageBtn) {
        elements.nextPageBtn.onclick = () => {
            if (currentPageIndex < pageCanvases.length - 1) {
                currentPageIndex++;
                updatePaginationUI();
            }
        };
    }


    // 2. FILE UPLOAD HANDLER
    if (elements.uploadBtn && elements.fileInput) {
        elements.uploadBtn.onclick = () => elements.fileInput?.click();
    }

    const loadSelectedFile = async (file: File, autoProcess = false, fileId?: string) => {
        currentFile = file;
        if (elements.fileName) {
            elements.fileName.textContent = file.name;
        }
        if (elements.processBtn) {
            elements.processBtn.disabled = false;
        }
        setExtractorStatus(elements.statusMessage, `Loading ${file.name}...`, 'loading');

        currentDocumentId = fileId || null;
        elements.container.innerHTML = "";
        pageCanvases = [];
        elements.textResults.classList.add('hidden');
        elements.resultsContainer.innerHTML = "";
        elements.checklist.innerHTML = `
        <div class="ocr-processing-state">
            <i class="fas fa-spinner fa-spin"></i>
            <span>Preparing document preview...</span>
        </div>`;

        if (file.type === 'application/pdf') {
            await renderPDF(file, elements.container);
        } else {
            await renderSingleImage(file, elements.container);
        }
        
        currentPageIndex = 0;
        updatePaginationUI();

        setExtractorStatus(elements.statusMessage, `${file.name} is ready to process.`, 'info');
        elements.checklist.innerHTML = `
        <p style="font-size: 12px; color: #7f8c8d; text-align: center; padding: 20px;">
            Document loaded. Processing will start shortly.
        </p>`;

        if (autoProcess) {
            await processCurrentFile();
        }
    };

    const processCurrentFile = async () => {
        if (!currentFile) return;

        if (elements.processBtn) {
            toggleLoading(true, elements.processBtn);
        }
        setExtractorStatus(elements.statusMessage, `Extracting text from ${currentFile.name}...`, 'loading');
        elements.checklist.innerHTML = `
        <div class="ocr-processing-state">
            <i class="fas fa-spinner fa-spin"></i>
            <span>Document is processing...</span>
        </div>`;

        try {
            let fileId = currentDocumentId;
            if (!fileId) {
                const uploadRes = await addDocumentRecord(currentFile);
                fileId = uploadRes.fileId || uploadRes.file_id;
                currentDocumentId = fileId;
            }

            const response = await fetch(`${API_BASE_URL}/process_document/${fileId}`);
            if (!response.ok || !response.body) throw new Error("Extraction Failed");

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let done = false;
            let finalData: any = null;

            while (!done) {
                const { value, done: readerDone } = await reader.read();
                done = readerDone;
                if (value) {
                    const chunk = decoder.decode(value, { stream: true });
                    const events = chunk.split('\n\n');
                    for (const eventStr of events) {
                        if (!eventStr.trim()) continue;
                        try {
                            const data = JSON.parse(eventStr.trim());
                            if (data.error) throw new Error(data.error);
                            
                            if (data.progress) {
                                setExtractorStatus(elements.statusMessage, `${data.progress} (${data.percent}%)`, 'loading');
                            }
                            
                            if (data.percent === 100 && (data.extracted_data || data.ocr_text)) {
                                finalData = data;
                            }
                        } catch (e: any) {
                            if (e.message && !e.message.includes('JSON')) {
                                throw e;
                            }
                        }
                    }
                }
            }

            if (!finalData) throw new Error("No final data received");

            const rawExtracted = finalData.extracted_data || finalData.final_data || finalData;
            currentData = flattenDocumentData(rawExtracted);
            const rawOCRDetails = currentData.ocr_details || [];
            if (rawOCRDetails.length > 0 && (rawOCRDetails[0].dt_polys || rawOCRDetails[0].res?.dt_polys)) {
                allOCRDetails = [];
                rawOCRDetails.forEach((pageResult: any, pageIdx: number) => {
                    const polys = pageResult?.res?.dt_polys ?? pageResult?.dt_polys ?? [];
                    const texts = pageResult?.res?.rec_texts ?? pageResult?.rec_texts ?? [];
                    for (let i = 0; i < texts.length; i++) {
                        const poly = polys[i];
                        const flatBox = poly ? poly.reduce((acc: number[], pt: number[]) => acc.concat(pt), []) : [];
                        allOCRDetails.push({
                            text: texts[i],
                            box: flatBox,
                            page: pageIdx
                        });
                    }
                });
            } else {
                allOCRDetails = rawOCRDetails;
            }

            const ocrPages: any[] = finalData.ocr_details || [];
            ocrPages.forEach((pageResult: any, pageIdx: number) => {
                const targetCanvas = pageCanvases[pageIdx];
                if (!targetCanvas) return;
                const ctx = targetCanvas.getContext('2d');
                if (!ctx) return;

                const polys: number[][][] = pageResult?.res?.dt_polys ?? pageResult?.dt_polys ?? [];
                const angles: number[] = pageResult?.res?.textline_orientation_angles ?? pageResult?.textline_orientation_angles ?? [];
                const srcW: number = pageResult?.img_width ?? 0;
                const srcH: number = pageResult?.img_height ?? 0;
                const scaleX = srcW > 0 ? targetCanvas.width / srcW : (targetCanvas as any).imageScale || 1;
                const scaleY = srcH > 0 ? targetCanvas.height / srcH : (targetCanvas as any).imageScale || 1;

                drawOCRPolygons(ctx, polys, scaleX, scaleY, angles);
            });

            const extractedKeys = Object.keys(currentData).filter(k => k !== 'ocr_text' && k !== 'ocr_details');

            generateDynamicChecklist(elements.checklist, extractedKeys);
            elements.resultsContainer.innerHTML = formatReadableHTML(currentData, extractedKeys);
            elements.textResults.classList.remove('hidden');

            const checkboxes = document.querySelectorAll('.ocr-checkbox:checked');
            const selectedFields = Array.from(checkboxes).map((cb: any) => cb.value);

            selectedFields.forEach(field => {
                const fieldData = currentData[field];
                if (fieldData && fieldData.box) {
                    if (Array.isArray(fieldData.box) && fieldData.box.length > 0 && Array.isArray(fieldData.box[0])) {
                        fieldData.box.forEach((singleBox: number[], idx: number) => {
                            const pageIdx = (Array.isArray(fieldData.page) ? fieldData.page[idx] : fieldData.page) ?? 0;
                            const targetCanvas = pageCanvases[pageIdx];
                            if (targetCanvas) {
                                const ctx = targetCanvas.getContext('2d');
                                if (ctx) drawBoundingBox(ctx, singleBox, field, "#e63946");
                            }
                        });
                    } else {
                        const pageIdx = fieldData.page !== undefined ? fieldData.page : 0;
                        const targetCanvas = pageCanvases[pageIdx];
                        if (targetCanvas) {
                            const ctx = targetCanvas.getContext('2d');
                            if (ctx) drawBoundingBox(ctx, fieldData.box, field, "#e63946");
                        }
                    }
                }
            });

            if (extractedKeys.length > 0 && typeof (window as any).appendZeusMessage === 'function') {
                const messageObj: any = {};
                extractedKeys.forEach(k => {
                    const val = currentData[k];
                    messageObj[k] = (val && typeof val === 'object' && val.value !== undefined) ? val.value : val;
                });
                const messageHtml = "```json\n" + JSON.stringify(messageObj, null, 2) + "\n```";
                (window as any).appendZeusMessage(messageHtml, 'bot', 'Document Extractor');
                if (typeof (window as any).saveZeusHistory === 'function') {
                    (window as any).saveZeusHistory('bot', messageHtml, 'Document Extractor');
                }
            }

            const detectedType = currentData.document_type || "Document";
            setExtractorStatus(elements.statusMessage, `Detected ${detectedType} and extracted fields.`, 'success');

        } catch (error) {
            setExtractorStatus(elements.statusMessage, "Extraction failed. Please check the document and try again.", 'error');
            showNotification("Extraction failed: " + error, "error");
        } finally {
            if (elements.processBtn) {
                toggleLoading(false, elements.processBtn);
            }
        }
    };

    const loadHistoricalDocument = async (fileId: string, filename: string, mimeType: string) => {
        // 1. Fetch file info (ocr_details, extracted_data)
        const infoRes = await fetch(`${API_BASE_URL}/document_info/${fileId}`);
        if (!infoRes.ok) throw new Error("Failed to load document info");
        const docInfo = await infoRes.json();
        if (!docInfo) return;

        // 2. Fetch the file blob
        const fileRes = await fetch(`${API_BASE_URL}/view-file/${fileId}`);
        if (!fileRes.ok) throw new Error("Failed to load document file");
        const blob = await fileRes.blob();
        const fileObj = new File([blob], filename, { type: mimeType });

        currentFile = fileObj;
        currentDocumentId = fileId;

        if (elements.fileName) {
            elements.fileName.textContent = filename;
        }
        if (elements.processBtn) {
            elements.processBtn.disabled = true;
        }
        setExtractorStatus(elements.statusMessage, `Loading ${filename}...`, 'loading');

        elements.container.innerHTML = "";
        pageCanvases = [];
        elements.textResults.classList.add('hidden');
        elements.resultsContainer.innerHTML = "";
        elements.checklist.innerHTML = `
        <div class="ocr-processing-state">
            <i class="fas fa-spinner fa-spin"></i>
            <span>Preparing document preview...</span>
        </div>`;

        if (mimeType === 'application/pdf') {
            await renderPDF(fileObj, elements.container);
        } else {
            await renderSingleImage(fileObj, elements.container);
        }
        
        currentPageIndex = 0;
        updatePaginationUI();

        currentData = flattenDocumentData(docInfo.extracted_data || {});

        const rawOCRDetails = docInfo.ocr_details || [];
        if (rawOCRDetails.length > 0 && (rawOCRDetails[0].dt_polys || rawOCRDetails[0].res?.dt_polys)) {
            allOCRDetails = [];
            rawOCRDetails.forEach((pageResult: any, pageIdx: number) => {
                const polys = pageResult?.res?.dt_polys ?? pageResult?.dt_polys ?? [];
                const texts = pageResult?.res?.rec_texts ?? pageResult?.rec_texts ?? [];
                for (let i = 0; i < texts.length; i++) {
                    const poly = polys[i];
                    const flatBox = poly ? poly.reduce((acc: number[], pt: number[]) => acc.concat(pt), []) : [];
                    allOCRDetails.push({
                        text: texts[i],
                        box: flatBox,
                        page: pageIdx
                    });
                }
            });
        } else {
            allOCRDetails = rawOCRDetails;
        }

        const ocrPages: any[] = docInfo.ocr_details || [];
        ocrPages.forEach((pageResult: any, pageIdx: number) => {
            const targetCanvas = pageCanvases[pageIdx];
            if (!targetCanvas) return;
            const ctx = targetCanvas.getContext('2d');
            if (!ctx) return;

            const polys: number[][][] = pageResult?.res?.dt_polys ?? pageResult?.dt_polys ?? [];
            const angles: number[] = pageResult?.res?.textline_orientation_angles ?? pageResult?.textline_orientation_angles ?? [];

            const srcW: number = pageResult?.img_width ?? 0;
            const srcH: number = pageResult?.img_height ?? 0;
            const scaleX = srcW > 0 ? targetCanvas.width / srcW : (targetCanvas as any).imageScale || 1;
            const scaleY = srcH > 0 ? targetCanvas.height / srcH : (targetCanvas as any).imageScale || 1;

            drawOCRPolygons(ctx, polys, scaleX, scaleY, angles);
        });

        const extractedKeys = Object.keys(currentData).filter(k => k !== 'ocr_text' && k !== 'ocr_details');
        generateDynamicChecklist(elements.checklist, extractedKeys);
        elements.resultsContainer.innerHTML = formatReadableHTML(currentData, extractedKeys);
        elements.textResults.classList.remove('hidden');

        const checkboxes = document.querySelectorAll('.ocr-checkbox:checked');
        const selectedFields = Array.from(checkboxes).map((cb: any) => cb.value);

        selectedFields.forEach(field => {
            const fieldData = currentData[field];
            if (fieldData && fieldData.box) {
                if (Array.isArray(fieldData.box) && fieldData.box.length > 0 && Array.isArray(fieldData.box[0])) {
                    fieldData.box.forEach((singleBox: number[], idx: number) => {
                        const pageIdx = (Array.isArray(fieldData.page) ? fieldData.page[idx] : fieldData.page) ?? 0;
                        const targetCanvas = pageCanvases[pageIdx];
                        if (targetCanvas) {
                            const ctx = targetCanvas.getContext('2d');
                            if (ctx) drawBoundingBox(ctx, singleBox, field, "#e63946");
                        }
                    });
                } else {
                    const pageIdx = fieldData.page !== undefined ? fieldData.page : 0;
                    const targetCanvas = pageCanvases[pageIdx];
                    if (targetCanvas) {
                        const ctx = targetCanvas.getContext('2d');
                        if (ctx) drawBoundingBox(ctx, fieldData.box, field, "#e63946");
                    }
                }
            }
        });

        const detectedType = currentData.document_type || "Document";
        setExtractorStatus(elements.statusMessage, `Loaded ${detectedType} from history.`, 'success');
    };

    // History Modal Event Listeners
    const historyBtn = document.getElementById('extractorHistoryBtn');
    const historyModal = document.getElementById('ocrHistoryModal');
    const closeHistoryBtn = document.getElementById('closeOcrHistoryBtn');
    const historyTableBody = document.getElementById('ocrHistoryTableBody');

    console.log("[Zeus OCR History] Binding check:", {
        historyBtn: !!historyBtn,
        historyModal: !!historyModal,
        closeHistoryBtn: !!closeHistoryBtn,
        historyTableBody: !!historyTableBody
    });

    if (historyBtn && historyModal && closeHistoryBtn && historyTableBody) {
        historyBtn.onclick = async (event) => {
            console.log("[Zeus OCR History] Button clicked!");
            event.preventDefault();
            const sessId = (window as any).currentSessionId;
            if (!sessId) {
                showNotification("Please select or start a chat session first.", "error");
                return;
            }

            historyTableBody.innerHTML = `
                <tr>
                    <td colspan="3" style="text-align:center; padding:20px; color:#64748b;">
                        <i class="fas fa-spinner fa-spin"></i> Loading documents...
                    </td>
                </tr>
            `;
            historyModal.classList.add('active');

            try {
                const response = await fetch(`${API_BASE_URL}/zeus/session_documents?session_id=${sessId}`);
                if (!response.ok) throw new Error("Failed to fetch documents");
                const docs = await response.json();

                if (docs.length === 0) {
                    historyTableBody.innerHTML = `
                        <tr>
                            <td colspan="3" style="text-align:center; padding:20px; color:#64748b;">
                                No document records found in this chat session.
                            </td>
                        </tr>
                    `;
                    return;
                }

                historyTableBody.innerHTML = docs.map((doc: any) => {
                    const timestampStr = doc.file_id.startsWith('FILE-')
                        ? new Date(parseInt(doc.file_id.split('-')[1]) * 1000).toLocaleString()
                        : 'N/A';
                    return `
                        <tr>
                            <td style="font-weight:500;">${doc.filename}</td>
                            <td style="color:#64748b;">${timestampStr}</td>
                            <td>
                                <button class="zeus-history-select-btn" data-id="${doc.file_id}" data-name="${doc.filename}" data-mime="${doc.mime_type}">
                                    Select
                                </button>
                            </td>
                        </tr>
                    `;
                }).join('');

                historyTableBody.querySelectorAll('.zeus-history-select-btn').forEach(btn => {
                    btn.addEventListener('click', async (e) => {
                        const target = e.currentTarget as HTMLButtonElement;
                        const docId = target.dataset.id!;
                        const docName = target.dataset.name!;
                        const docMime = target.dataset.mime!;

                        const allBtns = historyTableBody.querySelectorAll('.zeus-history-select-btn');
                        allBtns.forEach((b: any) => b.disabled = true);

                        const originalText = target.innerHTML;
                        target.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Loading...`;

                        try {
                            await loadHistoricalDocument(docId, docName, docMime);
                            historyModal.classList.remove('active');
                        } catch (err) {
                            console.error("Failed to load historical document:", err);
                            showNotification("Failed to load document: " + err, "error");
                        } finally {
                            allBtns.forEach((b: any) => b.disabled = false);
                            target.innerHTML = originalText;
                        }
                    });
                });

            } catch (err) {
                console.error(err);
                historyTableBody.innerHTML = `
                    <tr>
                        <td colspan="3" style="text-align:center; padding:20px; color:#ef4444;">
                            Failed to load documents.
                        </td>
                    </tr>
                `;
            }
        };

        closeHistoryBtn.onclick = () => {
            historyModal.classList.remove('active');
        };

        historyModal.addEventListener('click', (e) => {
            if (e.target === historyModal) {
                historyModal.classList.remove('active');
            }
        });
    }
    const clearOCRWorkspace = () => {
        currentFile = null;
        currentDocumentId = null;
        currentData = {};
        allOCRDetails = [];
        pageCanvases = [];
        currentPageIndex = 0;
        if (elements.fileName) {
            elements.fileName.textContent = "";
        }
        if (elements.processBtn) {
            elements.processBtn.disabled = true;
        }
        elements.container.innerHTML = `<div class="ocr-empty-state">No document loaded</div>`;
        elements.checklist.innerHTML = `
        <p style="font-size: 12px; color: #7f8c8d; text-align: center; padding: 20px;">
            Upload and process a file to see detected fields.
        </p>`;
        elements.resultsContainer.innerHTML = "";
        elements.textResults.classList.add('hidden');
        setExtractorStatus(elements.statusMessage, "Upload and process a document to begin extraction.", 'info');
    };
    (window as any).clearZeusOCRWorkspace = clearOCRWorkspace;
    (window as any).loadHistoricalDocument = loadHistoricalDocument;

    ocrDocumentLoader = loadSelectedFile;

    if (elements.fileInput) {
        elements.fileInput.onchange = async (e) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;
            await loadSelectedFile(file);
        };
    }

    // 3. EXTRACTION
    if (elements.processBtn) {
        elements.processBtn.onclick = processCurrentFile;
    }
    // 4. CHECKBOX LISTENER (For Toggling Highlights)
    elements.checklist.addEventListener('change', (e) => {
        if ((e.target as HTMLElement).tagName !== 'INPUT') return;

        pageCanvases.forEach(canvas => {
            const ctx = canvas.getContext('2d');
            const img = (canvas as any).originalImage;
            if (ctx && img) {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            }
        });

        const checkboxes = document.querySelectorAll('.ocr-checkbox:checked');
        const selectedFields = Array.from(checkboxes).map((cb: any) => cb.value);

        selectedFields.forEach(field => {
            const fieldData = currentData[field];
            if (fieldData && fieldData.box) {
                // Check if we have multiple boxes (nested arrays/dicts)
                if (Array.isArray(fieldData.box) && fieldData.box.length > 0 && Array.isArray(fieldData.box[0])) {
                    fieldData.box.forEach((singleBox: number[], idx: number) => {
                        const pageIdx = (Array.isArray(fieldData.page) ? fieldData.page[idx] : fieldData.page) ?? 0;
                        const targetCanvas = pageCanvases[pageIdx];
                        if (targetCanvas) {
                            const ctx = targetCanvas.getContext('2d');
                            if (ctx) drawBoundingBox(ctx, singleBox, field, "#e63946");
                        }
                    });
                } else {
                    const pageIdx = fieldData.page !== undefined ? fieldData.page : 0;
                    const targetCanvas = pageCanvases[pageIdx];
                    if (targetCanvas) {
                        const ctx = targetCanvas.getContext('2d');
                        if (ctx) drawBoundingBox(ctx, fieldData.box, field, "#e63946");
                    }
                }
            }
        });

        elements.resultsContainer.innerHTML = formatReadableHTML(currentData, selectedFields);
    });

    elements.container.addEventListener('mousedown', (e) => {
        if (!selectionMode.active || !allOCRDetails.length) return;

        const targetCanvas = e.target as HTMLCanvasElement;
        if (!(targetCanvas instanceof HTMLCanvasElement)) return;

        const rect = targetCanvas.getBoundingClientRect();

        const mouseX = (e.clientX - rect.left) / currentScale;
        const mouseY = (e.clientY - rect.top) / currentScale;

        const pageIndex = pageCanvases.indexOf(targetCanvas);

        const clickedBox = allOCRDetails.find(item => {
            const boxPage = item.page !== undefined ? item.page : 0;
            if (boxPage !== pageIndex) return false;

            const b = item.box;
            if (!b || b.length < 4) return false;

            const imgScale = (targetCanvas as any).imageScale || 1.0;

            const x = b[0] * imgScale;
            const y = b[1] * imgScale;
            const w = (b[2] - b[0]) * imgScale;
            const h = (b[5] - b[1]) * imgScale;

            return mouseX >= x && mouseX <= x + w && mouseY >= y && mouseY <= y + h;
        });

        if (clickedBox) {
            console.log(`Field Updated: ${selectionMode.field} -> ${clickedBox.text}`);

            currentData[selectionMode.field] = clickedBox.text;

            updateHighlights();

            const checkboxes = document.querySelectorAll('.ocr-checkbox:checked');
            const selectedFields = Array.from(checkboxes).map((cb: any) => cb.value);

            elements.resultsContainer.innerHTML = formatReadableHTML(currentData, selectedFields);

            selectionMode.active = false;
            targetCanvas.style.cursor = "default";
            setExtractorStatus(elements.statusMessage, `Updated ${selectionMode.field.replace(/_/g, ' ')}.`, 'success');
        }
    });

    async function updateHighlights() {
        if (!currentDocumentId) return;
        const checkboxes = document.querySelectorAll('.ocr-checkbox:checked');
        const fieldMap = Array.from(checkboxes).map((cb: any) => {
            const fieldName = cb.value;
            return {
                field: fieldName,
                value: currentData[fieldName] || null
            };
        });
        pageCanvases.forEach(canvas => {
            const ctx = canvas.getContext('2d');
            const img = (canvas as any).originalImage;
            if (ctx && img) {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            }
        });

        if (fieldMap.length === 0) return;
        try {
            const response = await fetch(`${API_BASE_URL}/highlight_fields`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file_id: currentDocumentId,
                    fields: fieldMap.map(f => f.field),
                    existing_values: currentData
                })
            });
            const data = await response.json();

            if (data.highlights) {
                data.highlights.forEach((item: any) => {
                    if (item.value && !currentData[item.field]) {
                        currentData[item.field] = item.value;
                    }
                    if (item.box) {
                        const pageIndex = item.box.page !== undefined ? item.box.page : (item.page || 0);
                        const targetCanvas = pageCanvases[pageIndex];

                        if (targetCanvas) {
                            const ctx = targetCanvas.getContext('2d');
                            if (ctx) {
                                drawBoundingBox(ctx, item.box, item.field, "#e63946");
                            }
                        }
                    }
                });
            }
        } catch (err) { console.error(err); }
    }
    // 5. ZOOM HANDLERS
    const updateZoomUI = () => {
        if (!elements.container) return;

        elements.container.style.transform = `scale(${currentScale})`;

        if (elements.zoomLevel) {
            elements.zoomLevel.textContent = `${Math.round(currentScale * 100)}%`;
        }

        const wrapper = elements.container.parentElement;
        if (wrapper) {
            const scaledHeight = elements.container.scrollHeight * currentScale;
            elements.container.style.marginBottom = `${scaledHeight - elements.container.scrollHeight}px`;
        }
    };

    if (elements.zoomIn) {
        elements.zoomIn.onclick = () => {
            if (currentScale < 3.0) {
                currentScale += 0.1;
                updateZoomUI();
            }
        };
    }

    if (elements.zoomOut) {
        elements.zoomOut.onclick = () => {
            if (currentScale > 0.3) {
                currentScale -= 0.1;
                updateZoomUI();
            }
        };
    }

    async function renderPDF(file: File, container: HTMLElement) {
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;

        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const viewport = page.getViewport({ scale: 1.5 });

            const canvas = document.createElement('canvas');
            canvas.style.boxShadow = "0 4px 6px rgba(0,0,0,0.1)";
            canvas.style.marginBottom = "20px";

            const context = canvas.getContext('2d');
            canvas.height = viewport.height;
            canvas.width = viewport.width;

            await page.render({ canvasContext: context, viewport: viewport }).promise;

            createImageBitmap(canvas).then(imgBitmap => {
                (canvas as any).originalImage = imgBitmap;
                (canvas as any).imageScale = viewport.scale;
            });

            container.appendChild(canvas);
            pageCanvases.push(canvas);
        }
    }
}

// --- HELPER FUNCTIONS ---
function renderSingleImage(file: File, container: HTMLElement): Promise<void> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = (e) => {
            const img = new Image();
            img.onerror = () => reject(new Error("Image render failed"));
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                const maxWidth = 800;
                const natWidth = img.naturalWidth || img.width;
                const natHeight = img.naturalHeight || img.height;

                const scale = maxWidth / natWidth;
                canvas.width = maxWidth;
                canvas.height = natHeight * scale;

                ctx?.drawImage(img, 0, 0, canvas.width, canvas.height);

                (canvas as any).originalImage = img;
                (canvas as any).imageScale = scale;

                container.appendChild(canvas);
                pageCanvases.push(canvas);
                resolve();
            };
            img.src = e.target?.result as string;
        };
        reader.readAsDataURL(file);
    });
}

// @ts-ignore
function renderResultsUI(elements: any) {
    const checkboxes = document.querySelectorAll('.ocr-checkbox:checked');
    const selectedFields = Array.from(checkboxes).map((cb: any) => cb.value);

    elements.resultsContainer.innerHTML = formatReadableHTML(currentData, selectedFields);
    elements.textResults.classList.remove('hidden');
}

function setExtractorStatus(element: HTMLElement | null, message: string, tone: 'info' | 'success' | 'error' | 'loading' = 'info') {
    if (!element) return;
    element.textContent = message;
    element.dataset.tone = tone;
}

/**
 * @param ctx    - The 2D rendering context of the target canvas
 * @param polys  - Array of polygons; each polygon is [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]
 * @param scaleX - Horizontal scale factor: canvas.width / source_image_width
 * @param scaleY - Vertical scale factor:   canvas.height / source_image_height
 * @param _angles - Per-textline orientation angles (reserved for future rotation support)
 */
function drawOCRPolygons(
    ctx: CanvasRenderingContext2D,
    polys: number[][][],
    scaleX: number,
    scaleY: number,
    _angles: number[] = []
) {
    if (!polys || polys.length === 0) return;

    ctx.save();
    ctx.fillStyle = 'rgba(255, 0, 0, 0.18)';
    polys.forEach((poly) => {
        if (!Array.isArray(poly) || poly.length < 3) return;
        ctx.beginPath();
        const [fx, fy] = poly[0];
        ctx.moveTo(fx * scaleX, fy * scaleY);
        for (let i = 1; i < poly.length; i++) {
            const [px, py] = poly[i];
            ctx.lineTo(px * scaleX, py * scaleY);
        }
        ctx.closePath();
        ctx.fill();
    });

    ctx.restore();
}

function drawBoundingBox(
    ctx: CanvasRenderingContext2D,
    box: number[],
    label: string,
    color: string
) {
    const canvas = ctx.canvas as any;
    const imgScale = canvas.imageScale || 1.0;

    if (Array.isArray(box) && box.length >= 4) {
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.lineJoin = "round";

        if (box.length >= 8) {
            ctx.moveTo(box[0] * imgScale, box[1] * imgScale);
            ctx.lineTo(box[2] * imgScale, box[3] * imgScale);
            ctx.lineTo(box[4] * imgScale, box[5] * imgScale);
            ctx.lineTo(box[6] * imgScale, box[7] * imgScale);
            ctx.closePath();
        } else {
            const x = box[0] * imgScale;
            const y = box[1] * imgScale;
            const w = (box[2] - box[0]) * imgScale;
            const h = (box[3] - box[1]) * imgScale;
            ctx.rect(x, y, w, h);
        }

        ctx.stroke();

        if (label) {
            ctx.font = "bold 12px sans-serif";
            const textWidth = ctx.measureText(label).width;
            const startX = box[0] * imgScale;
            const startY = box[1] * imgScale;

            ctx.fillStyle = color;
            ctx.fillRect(startX, startY - 22, textWidth + 10, 22);

            ctx.fillStyle = "white";
            ctx.fillText(label.toUpperCase(), startX + 5, startY - 7);
        }
    }
}

function formatReadableHTML(data: any, fields: string[]): string {
    if (!fields || fields.length === 0) {
        return '<div style="color: #64748b; font-style: italic; text-align: center; padding: 20px; font-size: 13px;">No selected data</div>';
    }
    let html = '<div style="display: flex; flex-direction: column; gap: 8px;">';

    fields.forEach(field => {
        const label = field.replace(/_/g, ' ').toUpperCase();
        let rawValue = data[field];

        let displayValue: string = "N/A";
        if (rawValue && typeof rawValue === 'object' && rawValue.value !== undefined) {
            displayValue = String(rawValue.value);
        } else if (rawValue !== undefined && rawValue !== null) {
            displayValue = String(rawValue);
        }

        if (displayValue.length > 100) {
            displayValue = displayValue.substring(0, 97) + "...";
        }

        html += `
            <div class="result-row zeus-result-row" data-field="${field}" style="cursor: pointer;" title="Click to highlight only this field">
                <div style="display:flex; flex-direction:column; max-width: 80%; pointer-events: none;">
                    <span class="zeus-field-label">${label}</span>
                    <span class="zeus-field-value">${displayValue}</span>
                </div>
                <button class="target-btn" data-field="${field}" style="background:none; border:none; cursor:pointer; font-size:18px;" title="Select from Image">
                    
                </button>
            </div>
        `;
    });
    html += '</div>';

    // Re-attach target listeners and row click listener
    setTimeout(() => {
        document.querySelectorAll('.target-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const field = (e.currentTarget as HTMLElement).dataset.field!;
                activateSelectionMode(field);
            });
        });

        document.querySelectorAll('.zeus-result-row').forEach(row => {
            row.addEventListener('click', (e) => {
                const field = (e.currentTarget as HTMLElement).dataset.field;
                if (!field) return;

                // Uncheck all other checkboxes and check this one
                const checkboxes = document.querySelectorAll('.ocr-checkbox');
                checkboxes.forEach((cb: any) => {
                    cb.checked = (cb.value === field);
                });

                // Trigger change event to redraw highlights
                const checklistContainer = document.getElementById('checklist');
                if (checklistContainer) {
                    checklistContainer.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });
        });
    }, 0);

    return html;
}

// @ts-ignore
function generateDynamicChecklist(container: HTMLElement, keys: string[]) {
    if (!container) return;
    if (!keys || keys.length === 0) {
        container.innerHTML = `<p style="font-size:12px; padding:10px;">No fields detected.</p>`;
        return;
    }
    container.innerHTML = `
        <div style="padding: 12px 14px 6px 14px; margin: 0; font-size: 11px; color: #7f8c8d; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px;">
            Detected Fields
        </div>
        <div id="dynamic-checklist" style="display: flex; flex-direction: column; gap: 8px;">
            ${keys.map((key: string) => `
                <label class="checkbox-item">
                    <input type="checkbox" value="${key}" class="ocr-checkbox" checked />
                    <span>${key.replace(/_/g, ' ').toUpperCase()}</span>
                </label>
            `).join('')}
        </div>
    `;
}

function flattenDocumentData(data: any) {
    if (!data) return {};
    const flat = { ...data };
    if (data.buyer && typeof data.buyer === 'object') {
        flat.buyer_name = data.buyer.name || flat.buyer_name;
        flat.buyer_address = data.buyer.address || flat.buyer_address;
    }
    if (data.seller && typeof data.seller === 'object') {
        flat.seller_name = data.seller.name || flat.seller_name;
        flat.seller_address = data.seller.address || flat.seller_address;
    }
    return flat;
}

function activateSelectionMode(field: string) {
    selectionMode = { active: true, field: field };
    pageCanvases.forEach(canvas => {
        const ctx = canvas.getContext('2d');
        canvas.style.cursor = "crosshair";
        if (!ctx || allOCRDetails.length === 0) return;

        allOCRDetails.forEach(item => {
            const pageIndex = item.page !== undefined ? item.page : 0;
            if (pageCanvases[pageIndex] === canvas && item.box) {
                drawBoundingBox(ctx, item.box, "", "rgba(0, 0, 0, 0.1)");
            }
        });
    });
    console.log(`Selection mode active for: ${field}`);
}

// --- MERGED SERVICES & UTILITIES ---

export async function saveChatMessage(fileId: string, content: string, sender: 'user' | 'bot') {
    const response = await fetch(`${API_BASE_URL}/chat/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_id: fileId, content, sender })
    });
    return await response.json();
}

export async function getChatHistory(fileId: string) {
    const response = await fetch(`${API_BASE_URL}/chat/history/${fileId}`);
    return await response.json();
}

export async function addDocumentRecord(file: File) {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("filename", file.name);

    const sessId = (window as any).currentSessionId;
    if (sessId) {
        formData.append("session_id", sessId);
    }

    const userStr = localStorage.getItem('zeusUser');
    if (userStr) {
        try {
            const user = JSON.parse(userStr);
            if (user && user.userid) {
                formData.append("userid", user.userid.toString());
            }
        } catch (e) {}
    }

    const response = await fetch(`${API_BASE_URL}/upload`, {
        method: "POST",
        body: formData,
    });

    if (!response.ok) throw new Error("Upload failed");
    return await response.json();
}

export async function searchDocuments(term: string): Promise<any[]> {
    try {
        const response = await fetch(`${API_BASE_URL}/search/documents?term=${encodeURIComponent(term)}`);

        if (!response.ok) throw new Error("Search request failed");

        const data = await response.json();
        return data;
    } catch (error) {
        console.error("Search failed:", error);
        return [];
    }
}

export function addChatMessage(container: HTMLElement, text: string, sender: 'user' | 'bot' | 'system') {
    if (!container) return null;
    const msg = document.createElement('div');
    msg.className = `message ${sender}`;
    msg.innerText = text;
    container.appendChild(msg);
    container.scrollTop = container.scrollHeight;
    return msg;
}

export function toggleLoading(isLoading: boolean, btn: HTMLButtonElement, originalText?: string) {
    if (isLoading) {
        if (!btn.dataset.originalText) {
            btn.dataset.originalText = btn.innerHTML;
        }

        btn.disabled = true;
        btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Processing...`;
    } else {
        btn.disabled = false;
        btn.innerHTML = originalText || btn.dataset.originalText || "Submit";
    }
}
