// MyTCG Vision Batch A — deterministic tests. Runs in REAL Chromium against
// REAL IndexedDB (no fake shim), because the indexes are the thing under test.
const {chromium}=require('playwright');
let f=0,n=0; const t=(c,m)=>{n++;c?console.log('  ok   '+m):(f++,console.log('  FAIL '+m));};
const J=x=>JSON.stringify(x);
(async()=>{
const b=await chromium.launch({args:['--no-sandbox']});
const page=await b.newPage();
const errs=[]; page.on('pageerror',e=>errs.push(e.message));
await page.goto('http://127.0.0.1:8099/index.html',{waitUntil:'commit'});
await page.waitForFunction('typeof _bootDone!=="undefined" && _bootDone===true',null,{timeout:25000,polling:100});

console.log('\n--- NORMALIZATION ---');
const norm=await page.evaluate(()=>({
  names:['Giratina V','GIRATINA V','  giratina v  ','Pokémon'].map(rcNormalizeName),
  mrmime:[rcNormalizeName('Mr. Mime'),rcNormalizeName('MrMime')],
  nums:['186/196','TG23/TG30','GG44/GG70','SV107/SV122','SWSH123','199/165',''].map(rcNormalizeNumber),
  langs:['','English','eng','JA','Japanese','de'].map(rcNormalizeLanguage),
  variants:['Holo','reverse holo','ALT-ART','nonsense'].map(rcNormalizeVariant)
}));
t(norm.names[0]==='giratina v'&&norm.names[1]==='giratina v'&&norm.names[2]==='giratina v','name normalizes across case/space');
t(norm.names[3]==='pokemon','accents folded (Pokémon -> pokemon)');
t(norm.mrmime[0]!==norm.mrmime[1],`"Mr. Mime" stays distinct from "MrMime" (${J(norm.mrmime)})`);
t(norm.nums[0].number==='186'&&norm.nums[0].denominator==='196','186/196 splits');
t(norm.nums[1].number==='TG23'&&norm.nums[1].prefix==='TG'&&norm.nums[1].digits==='23','TG23/TG30 keeps prefix+digits');
t(norm.nums[2].number==='GG44'&&norm.nums[2].denominator==='GG70','GG44/GG70 alphanumeric denominator');
t(norm.nums[3].number==='SV107','SV107/SV122 parses');
t(norm.nums[4].number==='SWSH123'&&!norm.nums[4].hasDenominator,'SWSH123 has no denominator');
t(norm.nums[5].number==='199'&&norm.nums[5].denominator==='165','199/165 preserved, NOT "corrected"');
t(norm.nums[0].display==='186/196','original display value retained');
t(norm.nums[6].display===''&&norm.nums[6].number==='','empty number safe');
t(J(norm.langs)===J(['en','en','en','ja','ja','de']),`language normalizes + stays extensible (${J(norm.langs)})`);
t(J(norm.variants)===J(['holo','reverse_holo','alt_art','nonsense']),`variant normalizes (${J(norm.variants)})`);

console.log('\n--- SEED + IDEMPOTENCY ---');
await page.evaluate(()=>rcClear());
const s1=await page.evaluate(()=>seedRecognitionFixtures());
const c1=await page.evaluate(()=>rcCount());
const s2=await page.evaluate(()=>seedRecognitionFixtures());
const c2=await page.evaluate(()=>rcCount());
t(c1>0,`seeded ${c1} records from ${s1.fixtures} fixtures`);
t(c1===c2,`re-seeding is IDEMPOTENT (${c1} -> ${c2}, no duplicates)`);
t(s1.unique===c1,`record key (cardId|language|variant) is unique per printing (${s1.unique})`);

console.log('\n--- CANONICAL LINKAGE ---');
const link=await page.evaluate(async()=>{
  const r=await findRecognitionCandidates({name:'Charizard',number:'4/102',setId:'base1'});
  return {top:r.candidates[0], hasCardId:!!(r.candidates[0]&&r.candidates[0].cardId)};});
t(link.hasCardId&&link.top.cardId==='base1-4',`candidate carries the EXISTING canonical cardId (${link.top&&link.top.cardId})`);
const noNew=await page.evaluate(()=>typeof makeRecognitionRecord({cardId:'x'}).canonicalId);
t(noNew==='undefined','no second canonical ID field invented');

console.log('\n--- EXACT MATCH ---');
const ex=await page.evaluate(()=>findRecognitionCandidates({name:'Rayquaza VMAX',number:'218/203',setId:'swsh7',language:'en'}));
t(ex.candidates[0].cardId==='swsh7-218',`exact -> ${ex.candidates[0].cardId} score ${ex.candidates[0].score}`);
t(!ex.ambiguous,'exact match is NOT flagged ambiguous');
console.log('    evidence:',J(ex.candidates[0].evidence));
t(ex.candidates[0].evidence.includes('collector number exact')&&ex.candidates[0].evidence.includes('set exact'),'evidence is explainable, not an opaque score');

console.log('\n--- SAME NUMBER ACROSS SETS ---');
const dup=await page.evaluate(()=>findRecognitionCandidates({number:'4'}));
const ids=dup.candidates.map(c=>c.cardId).sort();
t(ids.length>=3,`number "4" alone returns multiple sets: ${J(ids)}`);
t(dup.ambiguous,'number-only query correctly reported AMBIGUOUS');
const disamb=await page.evaluate(()=>findRecognitionCandidates({number:'4',setId:'sm1'}));
t(disamb.candidates[0].cardId==='sm1-4'&&!disamb.ambiguous,`adding set disambiguates -> ${disamb.candidates[0].cardId}`);

console.log('\n--- OCR-LIKE FUZZY MATCH ---');
// which PART is misread differs per case, so assert the right thing for each:
//   218/2O3 -> denominator misread, number still exact
//   21B/203 -> number misread (B<->8)
//   S8/102  -> number misread (S<->5)
for(const [bad,want,expect] of [['218/2O3','swsh7-218','exact'],['21B/203','swsh7-218','ocr'],['S8/102','base1-58','ocr']]){
  const r=await page.evaluate(q=>findRecognitionCandidates({number:q}),bad);
  const hit=r.candidates.some(c=>c.cardId===want);
  t(hit,`OCR misread "${bad}" still finds ${want} (${r.candidates.length} candidates)`);
  if(hit){const c=r.candidates.find(c=>c.cardId===want);
    const viaOcr=c.evidence.some(e=>/OCR-confusable/.test(e));
    const viaExact=c.evidence.includes('collector number exact');
    t(expect==='ocr'?viaOcr:viaExact,`  …via ${expect} path: ${J(c.evidence)}`);}
}
const exactBeatsFuzzy=await page.evaluate(async()=>{
  const a=await findRecognitionCandidates({number:'218/203',setId:'swsh7'});
  const b=await findRecognitionCandidates({number:'218/2O3',setId:'swsh7'});
  return {exact:a.candidates[0].score, fuzzy:b.candidates[0].score};});
t(exactBeatsFuzzy.exact>exactBeatsFuzzy.fuzzy,
  `EXACT evidence outranks fuzzy (${exactBeatsFuzzy.exact} > ${exactBeatsFuzzy.fuzzy})`);

console.log('\n--- FUZZY IS BOUNDED (no unrelated cards) ---');
const bounded=await page.evaluate(()=>findRecognitionCandidates({number:'218/203'}));
t(!bounded.candidates.some(c=>c.cardId==='base1-1'),'unrelated card (base1-1) is NOT a candidate for 218');

console.log('\n--- SIMILAR NAMES STAY DISTINCT ---');
const mime=await page.evaluate(()=>findRecognitionCandidates({name:'Mr. Mime',setId:'swsh4'}));
t(mime.candidates[0].cardId==='swsh4-44',`"Mr. Mime" -> ${mime.candidates[0].cardId} not Mime Jr.`);
const ray=await page.evaluate(()=>findRecognitionCandidates({name:'Rayquaza V',setId:'swsh7'}));
t(ray.candidates[0].cardId==='swsh7-110',`"Rayquaza V" -> ${ray.candidates[0].cardId} not the VMAX`);

console.log('\n--- VARIANT AMBIGUITY (metadata alone CANNOT resolve) ---');
const amb=await page.evaluate(()=>findRecognitionCandidates({name:'Umbreon VMAX',number:'215/203',setId:'swsh7',language:'en'}));
const enV=amb.candidates.filter(c=>c.cardId==='swsh7-215'&&c.record.language==='en').map(c=>c.record.variant).sort();
const jaV=amb.candidates.filter(c=>c.record.language==='ja');
t(J(enV)===J(['alt_art','normal','reverse']),`all three English presentations returned: ${J(enV)}`);
t(amb.ambiguous,'flagged AMBIGUOUS — the engine does not guess a variant');
t(amb.candidates[0].score===amb.candidates[1].score,'tied scores, honestly reported (this is what Batch D/E resolves)');
// language is additive EVIDENCE, not a hard filter: OCR can misdetect language,
// so the ja printing stays a candidate but must rank BELOW the en ones.
t(jaV.length===1&&jaV[0].score<amb.candidates[0].score,
  `ja printing kept as a lower-ranked candidate (${jaV[0]&&jaV[0].score} < ${amb.candidates[0].score})`);

console.log('\n--- LANGUAGE ---');
const ja=await page.evaluate(()=>findRecognitionCandidates({number:'215/203',language:'ja'}));
const jaTop=ja.candidates.find(c=>c.record.language==='ja');
t(!!jaTop,'Japanese printing is retrievable');
t(jaTop.evidence.includes('language exact'),'language counted as evidence');
const en=await page.evaluate(()=>findRecognitionCandidates({number:'215/203',language:'en'}));
t(en.candidates[0].record.language==='en','English query ranks an English printing first');

console.log('\n--- NO MATCH ---');
const none=await page.evaluate(()=>findRecognitionCandidates({name:'Zzzznotacard',number:'9999/9999',setId:'nope'}));
t(none.candidates.length===0,`unknown card returns ZERO candidates, not a bad guess (${none.candidates.length})`);
const empty=await page.evaluate(()=>findRecognitionCandidates({}));
t(empty.candidates.length===0,'empty query returns nothing');

console.log('\n--- PERFORMANCE ---');
const perf=await page.evaluate(async()=>{
  const runs=[];
  for(let i=0;i<40;i++){
    const r=await findRecognitionCandidates({name:'Charizard',number:'4/102',setId:'base1'});
    runs.push(r.ms);
  }
  runs.sort((a,b)=>a-b);
  return {median:runs[20], p95:runs[38], max:runs[39], min:runs[0]};});
console.log(`    indexed lookup: median ${perf.median}ms  p95 ${perf.p95}ms  max ${perf.max}ms`);
t(perf.median<100,`median indexed lookup under 100ms (${perf.median}ms)`);

console.log('\n--- STORAGE FOOTPRINT ---');
const size=await page.evaluate(async()=>{
  const est=(navigator.storage&&navigator.storage.estimate)?await navigator.storage.estimate():null;
  const recs=RECOGNITION_FIXTURES.map(f=>makeRecognitionRecord(f));
  const bytes=new Blob([JSON.stringify(recs)]).size;
  return {jsonBytes:bytes, perRecord:Math.round(bytes/recs.length), usage:est?est.usage:null};});
console.log(`    ${size.jsonBytes} bytes JSON for 24 records = ~${size.perRecord} bytes/record`);
t(size.perRecord>0,`per-record size measured (${size.perRecord} B)`);

console.log('\n--- ISOLATION FROM USER DATA ---');
const iso=await page.evaluate(()=>({
  dbs:['mytcg_recognition','mytcg_collection','mytcg_pcache'],
  colUntouched: typeof collection!=='undefined' ? collection.length : null,
  writesCollection: /collection\s*\.\s*push/.test(seedRecognitionFixtures.toString()+findRecognitionCandidates.toString())
}));
t(iso.writesCollection===false,'recognition code never pushes to collection');
t(errs.length===0,`zero page errors (${errs.length})`);
console.log(f?`\n${f}/${n} FAILURES`:`\nALL ${n} PASS`);
await b.close(); process.exit(f?1:0);
})();
