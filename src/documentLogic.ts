declare const pdfjsLib: any;

let currentPdf: any = null;
let currentPdfPage = 1;
let currentPdfScale = 1.0;
let documentsData: any[] = [];

const BASE_URL = import.meta.env.VITE_API_BASE_URL;

export async function initializeDocumentsPage() {
    const docsList = document.getElementById('docsList');
    const docSearch = document.getElementById('docSearch') as HTMLInputElement;
    const docModalOverlay = document.getElementById('docModalOverlay');
    const closeModalBtn = document.getElementById('closeModalBtn');

    const previewTitle = document.getElementById('previewTitle');
    const previewMeta = document.getElementById('previewMeta');
    const previewDownloadBtn = document.getElementById('previewDownloadBtn') as HTMLAnchorElement;
    const previewDeleteBtn = document.getElementById('previewDeleteBtn');

    const docContentText = document.getElementById('docContentText') as HTMLTextAreaElement;
    const pdfZoomBar = document.getElementById('pdfZoomBar');
    const docPdfCanvas = document.getElementById('docPdfCanvas') as HTMLCanvasElement;
    const docImagePreview = document.getElementById('docImagePreview') as HTMLImageElement;
    const docFallbackPreview = document.getElementById('docFallbackPreview');
    const docPageNum = document.getElementById('docPageNum');
    const docZoomVal = document.getElementById('docZoomVal');

    if (!docsList) return;

    let sortAscending = false;

    function getProcessedDocs() {
        const term = docSearch ? docSearch.value.toLowerCase().trim() : '';
        let list = [...documentsData];
        if (term) {
            list = list.filter(d =>
                d.filename.toLowerCase().includes(term) ||
                d.file_id.toLowerCase().includes(term)
            );
        }
        list.sort((a, b) => {
            const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
            const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
            return sortAscending ? dateA - dateB : dateB - dateA;
        });
        return list;
    }

    // Load documents
    async function loadDocs() {
        try {
            const userStr = localStorage.getItem('zeusUser');
            let url = `${BASE_URL}/zeus/documents`;
            if (userStr) {
                const user = JSON.parse(userStr);
                if (user && user.userid) {
                    url += `?userid=${user.userid}`;
                }
            }
            const res = await fetch(url);
            if (!res.ok) throw new Error("Failed to fetch documents");
            documentsData = await res.json();
            renderDocsList(getProcessedDocs());
        } catch (err) {
            console.error(err);
            docsList!.innerHTML = `<div style="grid-column: 1 / -1; color:var(--doc-text-secondary); padding:20px; text-align:center;">Failed to load documents.</div>`;
        }
    }

    async function renderDocsList(list: any[]) {
        docsList!.innerHTML = '';
        if (list.length === 0) {
            docsList!.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; padding: 40px 20px; color: var(--doc-text-muted);">No documents found.</div>`;
            return;
        }

        for (const doc of list) {
            const isPdf = doc.mime_type === 'application/pdf';
            const card = document.createElement('div');
            card.className = 'doc-card';
            card.style.height = '280px';
            card.style.display = 'flex';
            card.style.flexDirection = 'column';

            let thumbnailContent = '';
            let thumbnailId = `thumb-${doc.file_id}`;

            if (isPdf) {
                thumbnailContent = `<canvas id="${thumbnailId}" style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); min-width: 100%; min-height: 100%; width: auto; height: auto; display: block;"></canvas>`;
            } else if (doc.mime_type && doc.mime_type.startsWith('image/')) {
                thumbnailContent = `<img src="${BASE_URL}/view-file/${doc.file_id}" style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); min-width: 100%; min-height: 100%; width: auto; height: auto; display: block;" />`;
            } else {
                thumbnailContent = `<i class="fa-solid fa-file" style="font-size: 48px; color: var(--doc-border);"></i>`;
            }

            let formattedDate = 'Unknown date';
            if (doc.created_at) {
                try {
                    const dateObj = new Date(doc.created_at);
                    formattedDate = dateObj.toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric'
                    });
                } catch (e) {
                    console.error("Error formatting date:", e);
                }
            }

            card.innerHTML = `
                <div class="doc-thumbnail" style="height: 210px; flex-shrink: 0; overflow: hidden; display: flex; align-items: center; justify-content: center; position: relative; background: var(--doc-bg-primary); border-bottom: 1px solid var(--doc-border);">
                    ${thumbnailContent}
                </div>
                <div class="doc-info" style="padding: 12px; flex: 1; display: flex; flex-direction: column; justify-content: center; overflow: hidden;">
                    <div class="doc-title" title="${doc.filename}" style="font-size: 14px; font-weight: 600; color: var(--doc-text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 4px;">${doc.filename}</div>
                    <div class="doc-meta" style="font-size: 11px; color: var(--doc-text-muted);">${formattedDate}</div>
                </div>
            `;

            card.addEventListener('click', () => {
                openDocumentModal(doc);
            });

            docsList!.appendChild(card);

            if (isPdf) {
                // Async generate thumbnail
                generatePdfThumbnail(doc.file_id, thumbnailId);
            }
        }
    }

    async function generatePdfThumbnail(fileId: string, canvasId: string) {
        try {
            const fileRes = await fetch(`${BASE_URL}/view-file/${fileId}`);
            if (!fileRes.ok) return;
            const arrayBuffer = await fileRes.arrayBuffer();
            const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
            const page = await pdf.getPage(1);
            const canvas = document.getElementById(canvasId) as HTMLCanvasElement;
            if (!canvas) return;

            // Render thumbnail at a fixed scale
            const viewport = page.getViewport({ scale: 1.0 });
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            const context = canvas.getContext('2d');
            await page.render({ canvasContext: context, viewport: viewport }).promise;
        } catch (err) {
            console.error("Failed to generate thumbnail for", fileId, err);
        }
    }

    async function openDocumentModal(doc: any) {

        if (docModalOverlay) {
            docModalOverlay.style.display = 'flex';
        }

        if (previewTitle) previewTitle.textContent = doc.filename;
        if (previewMeta) previewMeta.textContent = `${doc.mime_type ? doc.mime_type.toUpperCase() : 'UNKNOWN'} • ID: ${doc.file_id}`;
        if (previewDownloadBtn) {
            previewDownloadBtn.href = `${BASE_URL}/view-file/${doc.file_id}`;
        }

        // Delete button action
        if (previewDeleteBtn) {
            previewDeleteBtn.onclick = async () => {
                let confirmed = true;
                if (typeof (window as any).showZeusConfirm === 'function') {
                    confirmed = await (window as any).showZeusConfirm(`Are you sure you want to delete ${doc.filename}?`);
                } else {
                    confirmed = confirm(`Are you sure you want to delete ${doc.filename}?`);
                }
                if (!confirmed) return;
                try {
                    const res = await fetch(`${BASE_URL}/zeus/documents/${doc.file_id}`, { method: 'DELETE' });
                    if (!res.ok) throw new Error("Delete failed");
                    if (docModalOverlay) {
                        docModalOverlay.style.display = 'none';
                    }
                    loadDocs();
                    if (typeof (window as any).showZeusNotification === 'function') {
                        (window as any).showZeusNotification("Document deleted successfully", "success");
                    }
                } catch (err: any) {
                    alert("Delete failed: " + err.message);
                }
            };
        }

        // Load document details (OCR text)
        if (docContentText) {
            docContentText.value = "Loading content...";
            try {
                const infoRes = await fetch(`${BASE_URL}/document_info/${doc.file_id}`);
                if (infoRes.ok) {
                    const info = await infoRes.json();
                    docContentText.value = info.ocr_text || "No OCR text extracted.";
                } else {
                    docContentText.value = "Could not load document text details.";
                }
            } catch (err) {
                docContentText.value = "Error loading document details.";
            }
        }

        // Preview rendering
        if (docImagePreview) docImagePreview.style.display = 'none';

        if (doc.mime_type === 'application/pdf') {
            if (docPdfCanvas && docFallbackPreview && pdfZoomBar) {
                docPdfCanvas.style.display = 'block';
                docFallbackPreview.style.display = 'none';
                pdfZoomBar.style.display = 'flex';

                try {
                    const fileRes = await fetch(`${BASE_URL}/view-file/${doc.file_id}`);
                    if (!fileRes.ok) throw new Error("Failed to load PDF bytes");
                    const arrayBuffer = await fileRes.arrayBuffer();

                    currentPdf = await pdfjsLib.getDocument(arrayBuffer).promise;
                    currentPdfPage = 1;
                    currentPdfScale = 1.0;
                    renderPdfPage();
                } catch (err) {
                    console.error("PDF load error:", err);
                    docFallbackPreview.style.display = 'block';
                    docPdfCanvas.style.display = 'none';
                    pdfZoomBar.style.display = 'none';
                }
            }
        } else if (doc.mime_type && doc.mime_type.startsWith('image/')) {
            if (docPdfCanvas && docFallbackPreview && pdfZoomBar && docImagePreview) {
                docPdfCanvas.style.display = 'none';
                docFallbackPreview.style.display = 'none';
                pdfZoomBar.style.display = 'none';
                docImagePreview.style.display = 'block';
                docImagePreview.src = `${BASE_URL}/view-file/${doc.file_id}`;
            }
        } else {
            // Fallback for non-PDF/non-image files
            if (docPdfCanvas && docFallbackPreview && pdfZoomBar) {
                docPdfCanvas.style.display = 'none';
                docFallbackPreview.style.display = 'block';
                pdfZoomBar.style.display = 'none';
            }
        }
    }

    if (closeModalBtn && docModalOverlay) {
        closeModalBtn.addEventListener('click', () => {
            docModalOverlay.style.display = 'none';
        });
    }

    async function renderPdfPage() {
        if (!currentPdf || !docPdfCanvas) return;
        try {
            const page = await currentPdf.getPage(currentPdfPage);
            const viewport = page.getViewport({ scale: currentPdfScale });

            docPdfCanvas.height = viewport.height;
            docPdfCanvas.width = viewport.width;

            const context = docPdfCanvas.getContext('2d');
            await page.render({ canvasContext: context, viewport: viewport }).promise;

            if (docPageNum) docPageNum.textContent = `${currentPdfPage} / ${currentPdf.numPages}`;
            if (docZoomVal) docZoomVal.textContent = `${Math.round(currentPdfScale * 100)}%`;
        } catch (err) {
            console.error("Page render error:", err);
        }
    }

    // Zoom and pagination controls
    const docPrevPage = document.getElementById('docPrevPage');
    const docNextPage = document.getElementById('docNextPage');
    const docZoomOut = document.getElementById('docZoomOut');
    const docZoomIn = document.getElementById('docZoomIn');

    if (docPrevPage) {
        docPrevPage.onclick = () => {
            if (currentPdfPage > 1) {
                currentPdfPage--;
                renderPdfPage();
            }
        };
    }

    if (docNextPage) {
        docNextPage.onclick = () => {
            if (currentPdf && currentPdfPage < currentPdf.numPages) {
                currentPdfPage++;
                renderPdfPage();
            }
        };
    }

    if (docZoomOut) {
        docZoomOut.onclick = () => {
            if (currentPdfScale > 0.5) {
                currentPdfScale -= 0.1;
                renderPdfPage();
            }
        };
    }

    if (docZoomIn) {
        docZoomIn.onclick = () => {
            if (currentPdfScale < 3.0) {
                currentPdfScale += 0.1;
                renderPdfPage();
            }
        };
    }

    // Bind search
    if (docSearch) {
        docSearch.oninput = () => {
            renderDocsList(getProcessedDocs());
        };
    }

    // Bind sort button
    const docSortBtn = document.getElementById('docSortBtn');
    const docSortIcon = document.getElementById('docSortIcon');
    if (docSortBtn && docSortIcon) {
        docSortBtn.onclick = () => {
            sortAscending = !sortAscending;
            if (sortAscending) {
                docSortIcon.className = 'fa-solid fa-arrow-up-wide-short';
                docSortBtn.title = 'Sort: Old to New';
            } else {
                docSortIcon.className = 'fa-solid fa-arrow-down-wide-short';
                docSortBtn.title = 'Sort: New to Old';
            }
            renderDocsList(getProcessedDocs());
        };
    }

    // Initial load
    loadDocs();
}

(window as any).initializeDocumentsPage = initializeDocumentsPage;
