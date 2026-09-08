#!/usr/bin/env python3
"""Read-only Infinity dispatcher Prometheus exporter."""
import json, os, re, subprocess, time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

RUNS_DIR=Path(os.getenv("DISPATCHER_RUNS_DIR","/data/runs")); INFINITY_ROOT=Path(os.getenv("INFINITY_ROOT","/data/infinity")); PORT=int(os.getenv("PORT","9102")); RUN=re.compile(r"^\d{8}T\d{6}Z-[\w-]+\.json$")
def epoch(v): return datetime.fromisoformat(v.replace("Z","+00:00")).timestamp()
def run():
 for p in sorted((x for x in RUNS_DIR.glob("*.json") if RUN.match(x.name)),reverse=True):
  try:
   d=json.loads(p.read_text()); plan=d.get("post_handoff_plan") or d.get("plan")
   if isinstance(plan,dict) and plan.get("at") and isinstance(plan.get("counts"),dict): return plan
  except (OSError,json.JSONDecodeError): pass
 raise RuntimeError("no complete record")
def ref(name): return subprocess.check_output(["git","-C",str(INFINITY_ROOT),"rev-parse",name],text=True).strip()
def active():
 text=(INFINITY_ROOT/"INTENTS.md").read_text(); section=text.split("## Active",1)[1].split("## Waiting",1)[0]; paths=re.findall(r"^- trace: (.+)$",section,re.M)
 if not paths:return 0,0
 stamps=[]
 for path in paths:
  events=json.loads((INFINITY_ROOT/path.strip()).read_text()).get("events",[]); stamps.append(max(epoch(e.get("timestamp") or e["at"]) for e in events if e.get("timestamp") or e.get("at")))
 return len(paths),max(0,time.time()-min(stamps))
def read(fn):
 try:return 1,fn()
 except Exception:return 0,None
def render():
 rok,r=read(run); gok,g=read(lambda:(ref("origin/main"),ref("HEAD"))); lok,_=read(lambda:(INFINITY_ROOT/"INTENTS.md").read_text()); tok,t=read(active); err=int(not all((rok,gok,lok,tok)))
 out=["# TYPE infinity_dispatcher_snapshot_read_error gauge",f"infinity_dispatcher_snapshot_read_error {err}","# TYPE infinity_dispatcher_source_ok gauge"]
 for n,v in (("run_record",rok),("git_ref",gok),("ledger",lok),("trace",tok)):out.append(f'infinity_dispatcher_source_ok{{source="{n}"}} {v}')
 if rok:out += ["# TYPE infinity_dispatcher_last_run_timestamp_seconds gauge",f"infinity_dispatcher_last_run_timestamp_seconds {epoch(r['at'])}"]
 if gok:out += ["# TYPE infinity_dispatcher_revision_mismatch gauge",f"infinity_dispatcher_revision_mismatch {int(g[0]!=g[1])}"]
 if tok:out += ["# TYPE infinity_dispatcher_active_intents gauge",f"infinity_dispatcher_active_intents {t[0]}","# TYPE infinity_dispatcher_active_freshness_seconds gauge",f"infinity_dispatcher_active_freshness_seconds {t[1]}","# TYPE infinity_dispatcher_active_freshness_known gauge","infinity_dispatcher_active_freshness_known 1"]
 else:out += ["# TYPE infinity_dispatcher_active_freshness_known gauge","infinity_dispatcher_active_freshness_known 0"]
 return "\n".join(out)+"\n"
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  if self.path!="/metrics":self.send_error(404);return
  b=render().encode();self.send_response(200);self.send_header("Content-Type","text/plain; version=0.0.4");self.send_header("Content-Length",str(len(b)));self.end_headers();self.wfile.write(b)
 def log_message(self,*_):pass
if __name__=="__main__":ThreadingHTTPServer(("0.0.0.0",PORT),Handler).serve_forever()
