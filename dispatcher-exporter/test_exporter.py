import importlib.util,json,subprocess,tempfile,unittest
from pathlib import Path
M=Path(__file__).with_name('exporter.py')
class T(unittest.TestCase):
 def module(self,r,d):
  s=importlib.util.spec_from_file_location('x',M);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.INFINITY_ROOT=r;m.RUNS_DIR=d;return m
 def root(self,r,d,record=True):
  (r/'traces').mkdir();(r/'INTENTS.md').write_text('## Active\n- trace: traces/a.json\n## Waiting\n');(r/'traces/a.json').write_text('{"events":[{"at":"2026-09-08T14:50:03Z"}]}')
  subprocess.run(['git','init','-q',str(r)],check=True);subprocess.run(['git','-C',str(r),'config','user.email','x@example.invalid'],check=True);subprocess.run(['git','-C',str(r),'config','user.name','x'],check=True);subprocess.run(['git','-C',str(r),'add','.'],check=True);subprocess.run(['git','-C',str(r),'commit','-qm','x'],check=True);sha=subprocess.check_output(['git','-C',str(r),'rev-parse','HEAD'],text=True).strip();subprocess.run(['git','-C',str(r),'update-ref','refs/remotes/origin/main',sha],check=True)
  if record:(d/'20260908T145001Z-x.json').write_text('{"plan":{"at":"2026-09-08T14:50:03Z","counts":{}}}')
 def test_all_dashboard_metrics(self):
  with tempfile.TemporaryDirectory() as x:
   r=Path(x)/'r';d=Path(x)/'d';r.mkdir();d.mkdir();self.root(r,d);o=self.module(r,d).render()
   for q in ('snapshot_read_error 0','last_run_timestamp_seconds','revision_mismatch 0','active_freshness_seconds'):self.assertIn(q,o)
 def test_no_record_is_error_without_false_run(self):
  with tempfile.TemporaryDirectory() as x:
   r=Path(x)/'r';d=Path(x)/'d';r.mkdir();d.mkdir();self.root(r,d,False);o=self.module(r,d).render();self.assertIn('snapshot_read_error 1',o);self.assertNotIn('last_run_timestamp_seconds ',o)
 def test_mismatch_and_malformed_trace_fail_safe(self):
  with tempfile.TemporaryDirectory() as x:
   r=Path(x)/'r';d=Path(x)/'d';r.mkdir();d.mkdir();self.root(r,d)
   (r/'INTENTS.md').write_text('changed');subprocess.run(['git','-C',str(r),'add','.'],check=True);subprocess.run(['git','-C',str(r),'commit','-qm','next'],check=True);sha=subprocess.check_output(['git','-C',str(r),'rev-parse','HEAD'],text=True).strip();subprocess.run(['git','-C',str(r),'update-ref','refs/remotes/origin/main',sha+'~1'],check=True)
   o=self.module(r,d).render();self.assertIn('revision_mismatch 1',o)
   (r/'traces/a.json').write_text('{');o=self.module(r,d).render();self.assertIn('snapshot_read_error 1',o);self.assertIn('active_freshness_known 0',o);self.assertNotIn('active_freshness_seconds ',o)
if __name__=='__main__':unittest.main()
