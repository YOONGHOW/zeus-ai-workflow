import asyncio
import datetime
import json
from dbconfig.db import SessionLocal, ScheduledTask, TaskNotification, TrackError
from workflow.autoTask import execute_workflow

background_tasks = set()

def cron_matches(cron_expr: str, dt: datetime.datetime) -> bool:
    try:
        parts = cron_expr.strip().split()
        if len(parts) != 5:
            return False
        
        minute_part, hour_part, dom_part, month_part, dow_part = parts
        
        if minute_part != '*':
            if int(minute_part) != dt.minute:
                return False
                
        if hour_part != '*':
            if int(hour_part) != dt.hour:
                return False
                
        if dom_part != '*':
            if int(dom_part) != dt.day:
                return False
                
        if month_part != '*':
            if int(month_part) != dt.month:
                return False
                
        if dow_part != '*':
            py_weekday = dt.weekday()
            cron_weekday = py_weekday + 1
            
            allowed_dows = []
            for item in dow_part.split(','):
                item = item.strip().lower()
                if item == '*':
                    return True
                elif item in ('sun', 'sunday', '7', '0'):
                    allowed_dows.extend([0, 7])
                elif item in ('mon', 'monday', '1'):
                    allowed_dows.append(1)
                elif item in ('tue', 'tuesday', '2'):
                    allowed_dows.append(2)
                elif item in ('wed', 'wednesday', '3'):
                    allowed_dows.append(3)
                elif item in ('thu', 'thursday', '4'):
                    allowed_dows.append(4)
                elif item in ('fri', 'friday', '5'):
                    allowed_dows.append(5)
                elif item in ('sat', 'saturday', '6'):
                    allowed_dows.append(6)
                else:
                    try:
                        allowed_dows.append(int(item))
                    except ValueError:
                        pass
            
            if cron_weekday not in allowed_dows:
                if py_weekday == 6 and (0 in allowed_dows or 7 in allowed_dows):
                    pass
                else:
                    return False
                    
        return True
    except Exception as e:
        print(f"Error matching cron: {e}")
        return False

async def run_scheduled_workflow_bg(payload_data: dict):
    workflow_id = payload_data.get('workflow_id') or 'unnamed'
    workflow_name = "Scheduled Workflow"
    userid = payload_data.get("userid")
    
    status = "success"
    error_msg = ""
    
    try:
        print(f"[Scheduled Task] Starting workflow: {workflow_id}")
        async for event in execute_workflow(payload_data):
            try:
                ev_data = json.loads(event.strip())
                if ev_data.get("type") == "error":
                    status = "failed"
                    error_msg = ev_data.get("message", "Unknown error")
            except Exception:
                pass
        print(f"[Scheduled Task] Finished workflow: {workflow_id}")
    except Exception as e:
        print(f"[Scheduled Task] Error running workflow {workflow_id}: {e}")
        status = "failed"
        error_msg = str(e)
        
    try:
        db = SessionLocal()
        notification = TaskNotification(
            userid=userid,
            workflow_id=workflow_id,
            workflow_name=workflow_name,
            status=status,
            error_message=error_msg
        )
        db.add(notification)
        if status == "failed":
            new_error = TrackError(
                userid=userid,
                error_type="workflow_execution",
                error_message=error_msg,
                error_details=f"Workflow {workflow_id} ({workflow_name}) failed"
            )
            db.add(new_error)
        db.commit()
        db.close()
    except Exception as log_err:
        print(f"[Scheduled Task] Failed to log notification/error: {log_err}")

async def cron_scheduler_loop():
    last_run_minute = None
    print("[OK] Starting cron scheduler loop...")
    while True:
        await asyncio.sleep(30)
        
        now = datetime.datetime.now()
        current_minute = (now.year, now.month, now.day, now.hour, now.minute)
        
        if last_run_minute == current_minute:
            continue
            
        last_run_minute = current_minute
        
        db = None
        try:
            db = SessionLocal()
            tasks = db.query(ScheduledTask).filter(ScheduledTask.is_active == 1).all()
            for t in tasks:
                if cron_matches(t.cron_expression, now):
                    print(f"[Scheduled Task] Triggered workflow {t.workflow_id} at {now}")
                    task = asyncio.create_task(run_scheduled_workflow_bg(t.payload_data))
                    background_tasks.add(task)
                    task.add_done_callback(background_tasks.discard)
        except Exception as e:
            print(f"Cron scheduler error: {e}")
        finally:
            if db:
                db.close()

def start_scheduler():
    task = asyncio.create_task(cron_scheduler_loop())
    background_tasks.add(task)
    task.add_done_callback(background_tasks.discard)
