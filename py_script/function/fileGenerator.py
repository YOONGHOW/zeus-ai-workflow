import os
import re
import json
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

from dbconfig.db import SessionLocal, FileTable

TEMPLATE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "templates")
REPORT_TEMPLATE = "email-report.html"


def _safe_filename(filename: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_. -]", "_", filename or "report.pdf").strip()
    if not cleaned.lower().endswith(".pdf"):
        cleaned += ".pdf"
    return cleaned or "report.pdf"


def _stringify_cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def _normalize_rows(rows: Optional[Sequence[Any]], columns: Optional[Sequence[str]] = None) -> Tuple[List[str], List[Dict[str, Any]]]:
    rows = list(rows or [])
    if not rows:
        return list(columns or []), []

    normalized: List[Dict[str, Any]] = []
    inferred_columns: List[str] = list(columns or [])

    for row in rows:
        if hasattr(row, "_mapping"):
            row_dict = dict(row._mapping)
        elif isinstance(row, dict):
            row_dict = dict(row)
        else:
            if not inferred_columns:
                inferred_columns = [f"Column {idx + 1}" for idx, _ in enumerate(row)]
            row_dict = {col: row[idx] if idx < len(row) else None for idx, col in enumerate(inferred_columns)}

        for key in row_dict.keys():
            if key not in inferred_columns:
                inferred_columns.append(str(key))
        normalized.append(row_dict)

    return inferred_columns, normalized


def _parse_markdown_table(content: str) -> Tuple[List[str], List[Dict[str, str]], str]:
    lines = content.splitlines()
    table_lines = [line.strip() for line in lines if line.strip().startswith("|") and line.strip().endswith("|")]
    if len(table_lines) < 2:
        return [], [], content

    headers = [cell.strip() for cell in table_lines[0].strip("|").split("|")]
    rows: List[Dict[str, str]] = []
    for line in table_lines[2:]:
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if len(cells) != len(headers):
            continue
        rows.append(dict(zip(headers, cells)))

    table_set = set(table_lines)
    note = "\n".join(line for line in lines if line.strip() not in table_set).strip()
    return headers, rows, note or "Generated from workflow output."


def _build_chart_payload(rows: Sequence[Dict[str, Any]], chart_config: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    config = dict(chart_config or {})
    if not rows or not config:
        return {"enabled": False}

    x_key_raw = config.get("x_axis") or config.get("label_key") or config.get("x")
    y_key_raw = config.get("y_axis") or config.get("value_key") or config.get("y")
    if not x_key_raw or not y_key_raw:
        return {"enabled": False}

    labels: List[str] = []
    values: List[float] = []

    for row in rows:
        # Case-insensitive key lookup
        row_lower = {str(k).lower(): v for k, v in row.items()}
        x_val = row_lower.get(str(x_key_raw).lower())
        y_val = row_lower.get(str(y_key_raw).lower())

        labels.append(_stringify_cell(x_val))
        try:
            values.append(float(str(y_val).replace(",", "")))
        except (TypeError, ValueError):
            values.append(0.0)

    # Ensure at least one valid value exists to render the chart
    if sum(values) == 0 and all(v == 0.0 for v in values):
        return {"enabled": False}

    return {
        "enabled": True,
        "type": config.get("type", "bar"),
        "title": config.get("title") or f"{y_key_raw} by {x_key_raw}",
        "labels": labels,
        "values": values,
        "x_axis": x_key_raw,
        "y_axis": y_key_raw,
    }


def _generate_chart_image_base64(chart_payload: Dict[str, Any]) -> Optional[str]:
    if not chart_payload or not chart_payload.get("enabled"):
        return None

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import io
        import base64

        chart_type = chart_payload.get("type", "bar")
        title = chart_payload.get("title", "")
        labels = chart_payload.get("labels", [])
        values = chart_payload.get("values", [])
        x_axis = chart_payload.get("x_axis", "")
        y_axis = chart_payload.get("y_axis", "")

        # Create plot
        fig, ax = plt.subplots(figsize=(8, 4.5), dpi=150)

        primary_color = "#10b981"  # emerald
        edge_color = "#047857"

        if chart_type == "line":
            ax.plot(labels, values, marker="o", color=primary_color, linewidth=2)
            ax.fill_between(labels, values, color=primary_color, alpha=0.1)
        elif chart_type == "pie":
            ax.pie(
                values,
                labels=labels,
                autopct="%1.1f%%",
                startangle=90,
                colors=["#10b981", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"],
            )
        else:  # default to bar
            bars = ax.bar(labels, values, color=primary_color, edgecolor=edge_color, width=0.6)
            for bar in bars:
                height = bar.get_height()
                ax.annotate(
                    f"{height:g}",
                    xy=(bar.get_x() + bar.get_width() / 2, height),
                    xytext=(0, 3),
                    textcoords="offset points",
                    ha="center",
                    va="bottom",
                    fontsize=8,
                )

        if chart_type != "pie":
            ax.set_title(title, fontsize=12, fontweight="bold", pad=15, color="#111827")
            ax.set_xlabel(x_axis, fontsize=10, labelpad=8, color="#374151")
            ax.set_ylabel(y_axis, fontsize=10, labelpad=8, color="#374151")

            # Style details
            ax.spines["top"].set_visible(False)
            ax.spines["right"].set_visible(False)
            ax.spines["left"].set_color("#d1d5db")
            ax.spines["bottom"].set_color("#d1d5db")

            ax.yaxis.grid(True, linestyle="--", alpha=0.5, color="#e5e7eb")
            ax.set_axisbelow(True)

            plt.xticks(
                rotation=45 if any(len(str(l)) > 8 for l in labels) else 0,
                ha="right" if any(len(str(l)) > 8 for l in labels) else "center",
            )

        plt.tight_layout()

        # Save to buffer
        buf = io.BytesIO()
        plt.savefig(buf, format="png", bbox_inches="tight", transparent=True)
        plt.close(fig)
        buf.seek(0)

        # Encode to base64
        return base64.b64encode(buf.read()).decode("utf-8")
    except Exception as e:
        print(f"[Report Renderer] Failed to generate chart image: {e}")
        return None


def render_report_html(
    report_title: str,
    summary_note: str,
    rows: Optional[Sequence[Any]] = None,
    columns: Optional[Sequence[str]] = None,
    chart_config: Optional[Dict[str, Any]] = None,
    report_subtitle: str = "Generated data report",
    sql_query: str = "",
) -> str:
    from jinja2 import Environment, FileSystemLoader, select_autoescape

    table_columns, table_rows = _normalize_rows(rows, columns)
    chart_payload = _build_chart_payload(table_rows, chart_config)
    if chart_payload.get("enabled"):
        chart_payload["image_b64"] = _generate_chart_image_base64(chart_payload)
    env = Environment(
        loader=FileSystemLoader(TEMPLATE_DIR),
        autoescape=select_autoescape(["html", "xml"]),
    )
    template = env.get_template(REPORT_TEMPLATE)
    return template.render(
        report_title=report_title or "Generated Report",
        report_subtitle=report_subtitle,
        summary_note=summary_note or "Report generated successfully.",
        columns=table_columns,
        rows=table_rows,
        chart=chart_payload,
        chart_json=json.dumps(chart_payload),
        sql_query=sql_query,
        generated_at=datetime.now(timezone.utc).strftime("%d %b %Y %H:%M UTC"),
    )



def _render_pdf_with_weasyprint(html_content: str) -> bytes:
    from weasyprint import HTML

    return HTML(string=html_content, base_url=TEMPLATE_DIR).write_pdf()


def _render_pdf_with_fpdf(report_title: str, summary_note: str, rows: Sequence[Dict[str, Any]], columns: Sequence[str]) -> bytes:
    from fpdf import FPDF

    pdf = FPDF()
    pdf.alias_nb_pages()
    pdf.add_page()
    pdf.set_font("helvetica", "B", 15)
    pdf.cell(0, 10, report_title.encode("latin-1", "replace").decode("latin-1"), ln=1, align="C")
    pdf.ln(4)
    pdf.set_font("helvetica", size=10)
    for line in (summary_note or "").splitlines():
        pdf.multi_cell(0, 6, line.encode("latin-1", "replace").decode("latin-1"), new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)
    if columns and rows:
        pdf.set_font("helvetica", "B", 8)
        pdf.multi_cell(0, 5, " | ".join(columns).encode("latin-1", "replace").decode("latin-1"), new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("helvetica", size=8)
        for row in rows[:100]:
            pdf.multi_cell(0, 5, " | ".join(_stringify_cell(row.get(col)) for col in columns).encode("latin-1", "replace").decode("latin-1"), new_x="LMARGIN", new_y="NEXT")
    pdf_bytes = pdf.output()
    return bytes(pdf_bytes.encode("latin1") if isinstance(pdf_bytes, str) else pdf_bytes)



def html_to_pdf_bytes(html_content: str, report_title: str, summary_note: str, rows: Sequence[Dict[str, Any]], columns: Sequence[str]) -> bytes:
    try:
        return bytes(_render_pdf_with_weasyprint(html_content))
    except Exception as weasy_error:
        print(f"[Report Renderer] WeasyPrint failed, trying fpdf fallback: {weasy_error}")

    return bytes(_render_pdf_with_fpdf(report_title, summary_note, rows, columns))



def save_generated_pdf(pdf_bytes: bytes, filename: str, session_id: str = None, userid: int = None, status: str = "generated_report") -> Dict[str, Any]:
    db = SessionLocal()
    try:
        file_id = str(uuid.uuid4())
        filename = _safe_filename(filename)
        from dbconfig.firebase import upload_file_to_firebase

        firebase_url = upload_file_to_firebase(pdf_bytes, file_id, "application/pdf")
        new_file = FileTable(
            file_id=file_id,
            filename=filename,
            firebase_url=firebase_url,
            mime_type="application/pdf",
            status=status,
            session_id=session_id,
            userid=userid,
        )
        db.add(new_file)
        db.commit()
        return {
            "success": True,
            "file_id": file_id,
            "filename": filename,
            "firebase_url": firebase_url,
        }
    except Exception as exc:
        db.rollback()
        import traceback
        traceback.print_exc()
        return {"success": False, "error": str(exc)}
    finally:
        db.close()


def generate_structured_pdf_report(
    report_title: str,
    summary_note: str,
    rows: Optional[Sequence[Any]],
    filename: str,
    session_id: str = None,
    userid: int = None,
    columns: Optional[Sequence[str]] = None,
    chart_config: Optional[Dict[str, Any]] = None,
    sql_query: str = "",
    report_subtitle: str = "Generated data report",
) -> Dict[str, Any]:
    table_columns, table_rows = _normalize_rows(rows, columns)
    html_content = render_report_html(
        report_title=report_title,
        summary_note=summary_note,
        rows=table_rows,
        columns=table_columns,
        chart_config=chart_config,
        report_subtitle=report_subtitle,
        sql_query=sql_query,
    )
    pdf_bytes = html_to_pdf_bytes(html_content, report_title, summary_note, table_rows, table_columns)
    result = save_generated_pdf(pdf_bytes, filename, session_id=session_id, userid=userid)
    if result.get("success"):
        result["row_count"] = len(table_rows)
        result["columns"] = table_columns
    return result


def generate_pdf_report(content: str, filename: str, session_id: str = None, userid: int = None, chart_config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    headers, rows, note = _parse_markdown_table(content or "")
    title_match = re.search(r"^#\s+(.+)$", content or "", flags=re.MULTILINE)
    report_title = title_match.group(1).strip() if title_match else "Zeus AI Generated Report"
    if not rows:
        rows = [{"Content": paragraph.strip()} for paragraph in re.split(r"\n\s*\n", content or "") if paragraph.strip()]
        headers = ["Content"] if rows else []
        note = "Generated from assistant output."

    return generate_structured_pdf_report(
        report_title=report_title,
        summary_note=note,
        rows=rows,
        columns=headers,
        filename=filename,
        session_id=session_id,
        userid=userid,
        report_subtitle="Assistant generated report",
        chart_config=chart_config,
    )
