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
