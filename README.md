# ⚡ Zeus Web Workspace

Zeus Web is a premium, AI-driven unified workspace combining document OCR processing, intelligent conversational agents, direct Database/REST API querying, and drag-and-drop workflow automation pipelines.

---

## 🚀 Key Modules

### 1. Document Extractor (OCR Workspace)
*   **Interactive OCR Canvas**: High-performance OCR rendering (backed by PaddleOCR) overlaying interactive bounding box highlights directly onto the document workspace.
*   **Checklist & Verification**: Automatically detects fields/keys from OCR results and displays interactive checklists to inspect and verify document data.
*   **Manual Linking**: Drag and draw custom areas on the document canvas to highlight and link bounding boxes to database entries.

### 2. Unified Zeus Chat & Auto Mode
*   **Conversational AI Assistant**: Modern chat interface supporting customized system instructions, full session history, and rich markdown rendering.
*   **Contextual File Attachments**: Attach PDFs, spreadsheets, images, and text documents directly into the chat prompt.
*   **Smart Auto Routing**: The assistant intelligently detects requested actions (e.g. scheduling Google Calendar events, database queries, web lookups) and coordinates background tasks.

### 3. Database & REST API Querying
*   **Natural Language SQL/API**: Query multi-source databases (PostgreSQL, MySQL, SQL Server, SQLite) or REST endpoints using simple natural language commands.
*   **Sleek Interactive Tables**: Query results render instantly as responsive tables inside the chat interface.
*   **One-Click Exporting**:
    *   💚 **Export to Excel**: Instantly export and download tables as Excel-compatible CSV sheets.
    *   ❤️ **Export to PDF**: Generate clean, print-friendly table layouts and trigger the browser's native PDF print/save utility.

### 4. AI Workflow (Workflow Builder & Scheduler)
*   **Interactive Node-Graph Editor**: Build complex automated pipelines by dropping flow control nodes (`Start`, `End`) and integration modules (`Gmail`, `Google Calendar`, `Database`, `REST API`, `Web Search`, `OCR/Docs`, `LLM Prompt`) onto an interactive grid canvas.
*   **Bezier-Curve Connections**: Connect node output and input ports with smooth drag-to-connect curves.
*   **Task List & Scheduler**:
    *   **Vibrant Table List**: Overview of all tasks, tools utilized, and status badges (`Running`, `Scheduled`, `Finished`).
    *   **Advanced Scheduling Sidebar**: Schedule workflows to run on-demand (`Run Once`), every day (`Daily`), or on a specific day of the week (`Weekly`) at designated times.
    *   **Schedule Visibility**: The table list displays an elegant `Schedule` column showing active timers (e.g. `⏰ Daily at 8:00 AM` or `📅 Monday at 9:00 AM`) for clear oversight.
    *   **Active Pause/Resume**: Toggle scheduled tasks instantly with play/pause icons.
    *   **Tools Column Compaction**: Lists all tool integration badges, cleanly compacting to a `...` badge with a hover tooltip preview if a workflow uses more than 4 tools.
*   **Automated Execution Engine**: A Python-based automation worker (`autoTask.py`) executes configured pipelines, using an LLM to automatically summarize data and format it into premium, responsive HTML email templates sent via Gmail.

### 5. User Access & Security
*   **Secure Authentication**: Integrated user authentication to ensure data privacy and secure workspace isolation.
*   **Private Workspaces**: Each user's chat history, saved workflows, and database configurations are strictly isolated and protected.

### 6. API and Database Configuration Management
*   **Centralized Credential Store**: An intuitive interface to securely add, manage, and test API keys and database connection strings for multiple engines (PostgreSQL, MySQL, SQL Server, SQLite) and REST endpoints.
*   **Dynamic Source Selection**: Seamlessly toggle between different configured databases or API endpoints on the fly when querying via the Unified Zeus Chat.

### 7. AI Generated Instruction DB
*   **Self-Learning Context**: A specialized database that automatically stores, indexes, and retrieves successful AI query patterns, custom system instructions, and workflow configurations.
*   **Dynamic Prompt Augmentation**: The AI dynamically fetches relevant historical instructions from this DB to continuously improve its accuracy and contextual awareness for your specific use cases.

### 8. Automated Email & Communication
*   **Smart Email Generation**: Leverages the LLM to automatically generate context-aware, premium HTML email templates directly from query results, workflow outputs, or document extractions.
*   **Direct Gmail Integration**: Seamlessly sends these customized, responsive emails to clients or internal teams automatically through integrated Gmail services.

### 9. Smart Calendar Management
*   **Automated Event Creation**: The AI can parse natural language (e.g., "Schedule a sync meeting with the team next Tuesday") to instantly organize and create events directly in your Google Calendar.
*   **Workflow-Triggered Scheduling**: Calendar events can be automatically generated as action items resulting from a larger scheduled workflow pipeline.

---

## 🛠️ Tech Stack

### Frontend
*   **Core**: HTML5, TypeScript (Strict Mode)
*   **Build Tool**: Vite
*   **Styling**: Vanilla CSS (Premium dark mode support via HSL tailored design system)
*   **Icons**: Font Awesome (Solid + Regular)

### Backend
*   **API Framework**: FastAPI (Python)
*   **OCR Engine**: PaddleOCR
*   **Automation Worker**: Python (`py_script/autoTask.py`)

---

## 💻 Installation & Setup

### Prerequisites
*   Node.js (v18+)
*   Python 3.10+
*   Anaconda or Python virtual environment setup

### Installation
1. Install frontend dependencies:
   ```bash
   npm install
   ```
2. Set up Python virtual environment and install backend dependencies:
   ```bash
   pip install -r requirements.txt
   ```

### Configuration
1. Configure credentials for database/integration capabilities (e.g. `service_account.json` for Google services).
2. Create and configure your environment files if necessary (`.env`).

### Running the Application
Run the following single command in the project root directory to boot both the frontend client and FastAPI server concurrently:
```bash
npm run dev:all
```