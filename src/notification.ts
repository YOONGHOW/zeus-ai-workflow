export function showNotification(message: string, type: 'success' | 'error' | 'info' = 'error') {
    // 1. Create or get the container
    let container = document.getElementById('zeus-notification-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'zeus-notification-container';
        document.body.appendChild(container);
    }

    // 2. Create the notification element
    const notif = document.createElement('div');
    notif.className = `zeus-notification ${type}`;

    let iconClass = '';
    if (type === 'error') {
        iconClass = 'fa-solid fa-circle-exclamation';
    } else if (type === 'success') {
        iconClass = 'fa-solid fa-circle-check';
    } else {
        iconClass = 'fa-solid fa-circle-info';
    }

    notif.innerHTML = `
        <i class="${iconClass} zeus-notification-icon ${type}"></i>
        <span class="zeus-notification-message">${message}</span>
        <button class="zeus-notification-close" onclick="this.parentElement.remove()">&times;</button>
    `;

    container.appendChild(notif);

    // 3. Trigger transition
    setTimeout(() => {
        notif.classList.add('active');
    }, 10);

    // 4. Auto remove after 4 seconds
    setTimeout(() => {
        if (notif.parentElement) {
            notif.classList.remove('active');
            setTimeout(() => {
                notif.remove();
            }, 300);
        }
    }, 4000);
}

(window as any).showZeusNotification = showNotification;

export function showConfirm(message: string, confirmText = "Confirm", cancelText = "Cancel"): Promise<boolean> {
    return new Promise((resolve) => {
        // 1. Create overlay
        const overlay = document.createElement('div');
        overlay.className = 'zeus-confirm-overlay';

        // 2. Create dialog box
        const dialog = document.createElement('div');
        dialog.className = 'zeus-confirm-dialog';

        dialog.innerHTML = `
            <div class="zeus-confirm-content-row">
                <div class="zeus-confirm-icon-box">
                    <i class="fa-solid fa-triangle-exclamation"></i>
                </div>
                <div class="zeus-confirm-text-box">
                    <h4 class="zeus-confirm-title">Confirm Action</h4>
                    <p class="zeus-confirm-message">${message}</p>
                </div>
            </div>
            <div class="zeus-confirm-actions">
                <button id="confirm-cancel-btn" class="zeus-confirm-btn zeus-confirm-btn-cancel">${cancelText}</button>
                <button id="confirm-ok-btn" class="zeus-confirm-btn zeus-confirm-btn-ok">${confirmText}</button>
            </div>
        `;

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        const cancelBtn = dialog.querySelector('#confirm-cancel-btn') as HTMLButtonElement;
        const okBtn = dialog.querySelector('#confirm-ok-btn') as HTMLButtonElement;

        setTimeout(() => {
            overlay.classList.add('active');
            dialog.classList.add('active');
        }, 10);

        const cleanup = (result: boolean) => {
            overlay.classList.remove('active');
            dialog.classList.remove('active');
            setTimeout(() => {
                overlay.remove();
                resolve(result);
            }, 200);
        };

        cancelBtn.onclick = () => cleanup(false);
        okBtn.onclick = () => cleanup(true);

        overlay.onclick = (e) => {
            if (e.target === overlay) {
                cleanup(false);
            }
        };
    });
}

(window as any).showZeusConfirm = showConfirm;

export function initializeInboxNotifications() {
    const inboxToggle = document.getElementById('inboxToggle');
    const inboxDropdown = document.getElementById('inboxDropdown');
    const inboxBadge = document.getElementById('inboxBadge');
    const inboxDropdownList = document.getElementById('inboxDropdownList');
    
    const notifModalOverlay = document.getElementById('notifModalOverlay');
    const notifModalPanel = document.getElementById('notifModalPanel');
    const notifModalClose = document.getElementById('notifModalClose');
    const viewAllNotifsBtn = document.getElementById('viewAllNotifsBtn');
    
    const notifTableBody = document.getElementById('notifTableBody');
    const notifPrevPage = document.getElementById('notifPrevPage') as HTMLButtonElement;
    const notifNextPage = document.getElementById('notifNextPage') as HTMLButtonElement;
    const notifPageInfo = document.getElementById('notifPageInfo');

    let notifications: any[] = [];
    let currentPage = 1;
    const itemsPerPage = 8;
    
    async function fetchNotifications() {
        try {
            const userStr = localStorage.getItem('zeusUser');
            if (!userStr) return;
            const user = JSON.parse(userStr);
            const baseUrl = (window as any).BASE_URL || import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8080';
            
            const res = await fetch(`${baseUrl}/api/notifications?userid=${user.userid}`);
            if (res.ok) {
                notifications = await res.json();
                updateInboxDropdown();
                if (notifModalPanel && notifModalPanel.classList.contains('active')) {
                    renderModalTable();
                }
            }
        } catch (e) {
            console.error("Failed to fetch notifications", e);
        }
    }

    async function markAsRead() {
        try {
            const userStr = localStorage.getItem('zeusUser');
            if (!userStr) return;
            const user = JSON.parse(userStr);
            const baseUrl = (window as any).BASE_URL || import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8080';
            
            await fetch(`${baseUrl}/api/notifications/read`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userid: user.userid })
            });
            // Update local state immediately
            notifications.forEach(n => n.is_read = 1);
            if (inboxBadge) inboxBadge.style.display = 'none';
        } catch (e) {
            console.error("Failed to mark notifications as read", e);
        }
    }

    function updateInboxDropdown() {
        if (!inboxDropdownList || !inboxBadge) return;
        
        const unreadCount = notifications.filter(n => n.is_read === 0).length;
        if (unreadCount > 0) {
            inboxBadge.style.display = 'block';
        } else {
            inboxBadge.style.display = 'none';
        }
        
        // Show today's notifications only in dropdown
        const todayStr = new Date().toDateString();
        const todaysNotifs = notifications.filter(n => new Date(n.created_at).toDateString() === todayStr);
        
        if (todaysNotifs.length === 0) {
            inboxDropdownList.innerHTML = '<div class="inbox-empty">No tasks executed today.</div>';
            return;
        }
        
        inboxDropdownList.innerHTML = todaysNotifs.slice(0, 10).map(n => `
            <div class="inbox-item">
                <div class="inbox-item-header">
                    <span>${new Date(n.created_at).toLocaleTimeString()}</span>
                    <span class="inbox-item-status ${n.status === 'success' ? 'success' : 'failed'}">
                        ${n.status === 'success' ? '<i class="fa-solid fa-check"></i> Success' : '<i class="fa-solid fa-xmark"></i> Failed'}
                    </span>
                </div>
                <div class="inbox-item-name">${n.workflow_name || n.workflow_id}</div>
                ${n.error_message ? `<div style="font-size: 11px; color: #ef4444; margin-top:2px;">${n.error_message}</div>` : ''}
            </div>
        `).join('');
    }

    function renderModalTable() {
        if (!notifTableBody || !notifPageInfo || !notifPrevPage || !notifNextPage) return;
        
        const totalPages = Math.ceil(notifications.length / itemsPerPage) || 1;
        if (currentPage > totalPages) currentPage = totalPages;
        
        notifPageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
        notifPrevPage.disabled = currentPage === 1;
        notifNextPage.disabled = currentPage === totalPages;
        
        const start = (currentPage - 1) * itemsPerPage;
        const pageItems = notifications.slice(start, start + itemsPerPage);
        
        if (pageItems.length === 0) {
            notifTableBody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding: 20px;">No notifications found.</td></tr>';
            return;
        }
        
        notifTableBody.innerHTML = pageItems.map(n => {
            const dt = new Date(n.created_at);
            const dateStr = `${dt.toLocaleDateString()} ${dt.toLocaleTimeString()}`;
            return `
                <tr>
                    <td style="white-space: nowrap;">${dateStr}</td>
                    <td>${n.workflow_name || n.workflow_id}</td>
                    <td style="color: ${n.status === 'success' ? '#22c55e' : '#ef4444'}; font-weight:500;">
                        ${n.status === 'success' ? 'Success' : 'Failed'}
                    </td>
                    <td style="color: #ef4444; font-size:12px;">${n.error_message || ''}</td>
                </tr>
            `;
        }).join('');
    }

    // Event Listeners
    if (inboxToggle && inboxDropdown) {
        inboxToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = inboxDropdown.style.display === 'block';
            inboxDropdown.style.display = isVisible ? 'none' : 'block';
            if (!isVisible) {
                markAsRead();
            }
        });
        
        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!inboxDropdown.contains(e.target as Node) && !inboxToggle.contains(e.target as Node)) {
                inboxDropdown.style.display = 'none';
            }
        });
    }

    function openModal() {
        if (inboxDropdown) inboxDropdown.style.display = 'none';
        if (notifModalPanel && notifModalOverlay) {
            notifModalPanel.classList.add('active');
            notifModalOverlay.classList.add('active');
            currentPage = 1;
            renderModalTable();
            markAsRead();
        }
    }
    
    function closeModal() {
        if (notifModalPanel && notifModalOverlay) {
            notifModalPanel.classList.remove('active');
            notifModalOverlay.classList.remove('active');
        }
    }

    if (viewAllNotifsBtn) viewAllNotifsBtn.addEventListener('click', openModal);
    if (notifModalClose) notifModalClose.addEventListener('click', closeModal);
    if (notifModalOverlay) notifModalOverlay.addEventListener('click', closeModal);
    
    if (notifPrevPage) {
        notifPrevPage.addEventListener('click', () => {
            if (currentPage > 1) {
                currentPage--;
                renderModalTable();
            }
        });
    }
    
    if (notifNextPage) {
        notifNextPage.addEventListener('click', () => {
            const totalPages = Math.ceil(notifications.length / itemsPerPage);
            if (currentPage < totalPages) {
                currentPage++;
                renderModalTable();
            }
        });
    }

    // Initial fetch and start polling every 30 seconds
    fetchNotifications();
    setInterval(fetchNotifications, 30000);
}

export function showPrompt(message: string, defaultValue = "", confirmText = "Confirm", cancelText = "Cancel"): Promise<string | null> {
    return new Promise((resolve) => {
        // 1. Create overlay
        const overlay = document.createElement('div');
        overlay.className = 'zeus-confirm-overlay';

        // 2. Create dialog box
        const dialog = document.createElement('div');
        dialog.className = 'zeus-confirm-dialog';

        dialog.innerHTML = `
            <div class="zeus-confirm-content-row" style="margin-bottom: 15px;">
                <div class="zeus-confirm-icon-box" style="background: rgba(59, 130, 246, 0.15); color: #3b82f6;">
                    <i class="fa-solid fa-pen-to-square"></i>
                </div>
                <div class="zeus-confirm-text-box">
                    <h4 class="zeus-confirm-title">Rename</h4>
                    <p class="zeus-confirm-message">${message}</p>
                </div>
            </div>
            <div style="margin-bottom: 20px;">
                <input type="text" id="zeus-prompt-input" value="${defaultValue}" style="
                    width: 100%;
                    padding: 10px 12px;
                    background: rgba(255, 255, 255, 0.05);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    border-radius: 8px;
                    color: white;
                    font-size: 13.5px;
                    font-family: inherit;
                    outline: none;
                    box-sizing: border-box;
                    transition: border-color 0.2s;
                "/>
            </div>
            <div class="zeus-confirm-actions">
                <button id="confirm-cancel-btn" class="zeus-confirm-btn zeus-confirm-btn-cancel">${cancelText}</button>
                <button id="confirm-ok-btn" class="zeus-confirm-btn zeus-confirm-btn-ok" style="background: #3b82f6; box-shadow: 0 4px 12px rgba(59, 130, 246, 0.2); border: none;">${confirmText}</button>
            </div>
        `;

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        const input = dialog.querySelector('#zeus-prompt-input') as HTMLInputElement;
        const cancelBtn = dialog.querySelector('#confirm-cancel-btn') as HTMLButtonElement;
        const okBtn = dialog.querySelector('#confirm-ok-btn') as HTMLButtonElement;

        // Focus input and select all text
        setTimeout(() => {
            input.focus();
            input.select();
        }, 50);

        // Hover effects for the Blue OK button
        okBtn.onmouseenter = () => okBtn.style.background = '#2563eb';
        okBtn.onmouseleave = () => okBtn.style.background = '#3b82f6';

        // Trigger animations
        setTimeout(() => {
            overlay.classList.add('active');
            dialog.classList.add('active');
        }, 10);

        const cleanup = (result: string | null) => {
            overlay.classList.remove('active');
            dialog.classList.remove('active');
            setTimeout(() => {
                overlay.remove();
                resolve(result);
            }, 200);
        };

        cancelBtn.onclick = () => cleanup(null);
        okBtn.onclick = () => cleanup(input.value.trim());

        input.onkeydown = (e) => {
            if (e.key === 'Enter') {
                cleanup(input.value.trim());
            } else if (e.key === 'Escape') {
                cleanup(null);
            }
        };

        overlay.onclick = (e) => {
            if (e.target === overlay) {
                cleanup(null);
            }
        };
    });
}

(window as any).showZeusPrompt = showPrompt;
