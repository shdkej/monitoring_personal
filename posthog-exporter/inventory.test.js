const test = require('node:test');
const assert = require('node:assert/strict');
const {projectScopes} = require('./inventory');
const {collectSnapshot, scopeSQL} = require('./calendar');

test('private discovery keeps verified apps together and separates new projects and app IDs', async () => {
  const groups = projectScopes('424014', [['virtue',null],['policycock',null],['new-app',null],
    [null,'new.aws.shdkej.com'],[null,'not-owned.example'],["bad'quote",null]]);
  assert.deepEqual(groups.map(g=>g.name), ['policycock','miniapp-image-tools','Infinity','shdkej.com',
    'Virtue','host:new.aws.shdkej.com','app:new-app','앱 미지정']);
  const {attribution,filter} = scopeSQL(groups,true);
  assert.match(attribution, /properties.app_id = 'virtue'/);
  assert.match(filter,/synthetic/);
  assert.doesNotMatch(attribution,/quote|not-owned/);
  const id = '73', isolated = projectScopes(id,[]);
  const r=await collectSnapshot(async(project,sql)=>{
    assert.equal(project,id);
    assert.doesNotMatch(sql,/IN \(\)/);
    return [[0,0,2,1,1,1]];
  },new Date('2026-11-26'),{id,groups:isolated,privateScope:true});
  assert.equal(r.rows[0].scope,'project-73 / 앱 미지정');
  assert.equal(r.rows[0].values.events,2);
});
