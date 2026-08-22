// Validates the UPGRADED multi-set Gate 2 runner before it is used for real.
// Provider responses are intercepted so pagination, printedTotal divergence and
// cross-set integrity are all genuinely exercised.
const {chromium}=require('playwright');
let f=0,n=0; const t=(c,m)=>{n++;c?console.log('  ok   '+m):(f++,console.log('  FAIL '+m));};
const SETS={
  // printedTotal === total, single page — cannot prove the fix (like real base1)
  base1:{ id:'base1', name:'Base', printedTotal:102, total:102, releaseDate:'1999/01/09', ptcgoCode:'BS', n:102 },
  // printedTotal != total AND >250 cards — proves BOTH the fix and pagination
  swsh7:{ id:'swsh7', name:'Evolving Skies', printedTotal:203, total:237, releaseDate:'2021/08/27', ptcgoCode:'EVS', n:280 },
  // alphanumeric TG numbers
  swsh9:{ id:'swsh9', name:'Brilliant Stars', printedTotal:172, total:186, releaseDate:'2022/02/25', ptcgoCode:'BRS', n:30 }
};
function cards(set){
  const out=[];
  for(let i=1;i<=set.n;i++){
    const num = set.id==='swsh9' ? ('TG'+String(i).padStart(2,'0')) : String(i);
    out.push({ id:set.id+'-'+num, name:set.name+'Mon'+i, number:num,
      rarity: i>set.printedTotal ? 'Secret Rare' : (i%7===0?'Rare Holo':'Common'),
      supertype:'Pokémon', hp:String(50+(i%9)*10), set:{id:set.id,name:set.name,
      printedTotal:set.printedTotal,total:set.total,releaseDate:set.releaseDate,ptcgoCode:set.ptcgoCode},
      images:{small:'https://x.invalid/'+set.id+'-'+num+'.png'} });
  }
  return out;
}
(async()=>{
const b=await chromium.launch({args:['--no-sandbox']});
const page=await b.newPage(); const errs=[]; page.on('pageerror',e=>errs.push(e.message));
let reqCount=0;
await page.route('**/*',async r=>{
  const u=r.request().url();
  if(u.startsWith('http://127.0.0.1:8099')) return r.continue();
  if(u.includes('api.pokemontcg.io')){
    reqCount++;
    const m=u.match(/set\.id%3A(\w+)/)||u.match(/set\.id:(\w+)/);
    const sid=m?m[1]:'base1'; const set=SETS[sid];
    if(!set) return r.fulfill({contentType:'application/json',body:JSON.stringify({data:[],totalCount:0})});
    const ps=parseInt((u.match(/pageSize=(\d+)/)||[,'250'])[1],10);
    const pg=parseInt((u.match(/page=(\d+)/)||[,'1'])[1],10);
    const all=cards(set); const slice=all.slice((pg-1)*ps, pg*ps);
    return r.fulfill({contentType:'application/json',
      headers:{'content-type':'application/json','x-ratelimit-remaining':'19000'},
      body:JSON.stringify({data:slice,totalCount:all.length,page:pg,pageSize:ps})});
  }
  if(u.includes('chart')) return r.fulfill({contentType:'application/javascript',body:'window.Chart=function(){this.destroy=function(){};this.update=function(){}};window.Chart.register=function(){};window.Chart.defaults={font:{},plugins:{legend:{}}};'});
  return r.fulfill({status:200,contentType:'text/plain',body:''});
});
await page.goto('http://127.0.0.1:8099/index.html',{waitUntil:'commit'});
await page.waitForFunction('typeof _bootDone!=="undefined" && _bootDone===true',null,{timeout:25000,polling:100});
const M=await page.evaluate(()=>runRecognitionGate2({sets:['base1','swsh7','swsh9']}));

console.log('\n--- MULTI-SET ORCHESTRATION ---');
t(M.perSet.length===3,`all 3 sets processed (${M.perSet.length})`);
const b1=M.perSet[0], s7=M.perSet[1], s9=M.perSet[2];
t(b1.inserted===102,`base1 inserted ${b1.inserted}`);
t(s7.inserted===280,`swsh7 inserted ${s7.inserted}`);
t(s9.inserted===30,`swsh9 inserted ${s9.inserted}`);

console.log('\n--- PAGINATION (the gap base1 could not cover) ---');
t(b1.pagesFetched===1,`base1: 1 page (102 < 250) — loop not exercised (${b1.pagesFetched})`);
t(s7.pagesFetched===2,`swsh7: ${s7.pagesFetched} pages for 280 cards — PAGING PROVEN`);
t(s7.fetched===s7.reportedTotal,`no truncation: fetched ${s7.fetched} === providerTotal ${s7.reportedTotal}`);
t(s7.truncationSuspected===false,'truncation detector reports clean');

console.log('\n--- printedTotal (the fix base1 could NOT validate) ---');
t(b1.printedTotal.valuesDiffer===false,'base1: printedTotal === total, so it proves nothing (as warned)');
t(s7.printedTotal.valuesDiffer===true,`swsh7: printedTotal ${s7.printedTotal.livePrintedTotal} != total ${s7.printedTotal.liveTotal}`);
t(s7.printedTotal.usesPrintedTotal===true,`swsh7 stored denominator = ${s7.printedTotal.storedDenominator} (printedTotal) — FIX VALIDATED`);
t(s7.printedTotal.incorrectlyUsesTotal===false,'total was NOT substituted');

console.log('\n--- INCREMENTAL IMPORT / CROSS-SET INTEGRITY ---');
t(b1.recordsAfter===102&&s7.recordsBefore===102,'set 2 started from set 1 intact');
t(s7.recordsAfter===382,`catalog grew 102 -> ${s7.recordsAfter} (no wipe)`);
t(s9.recordsAfter===412,`catalog grew to ${s9.recordsAfter}`);
t(M.crossSet.every(c=>c.recordsPresent>0),`every set still present: ${JSON.stringify(M.crossSet.map(c=>c.setId+':'+c.recordsPresent))}`);
t(M.crossSet.every(c=>c.stillQueryable),'every set still QUERYABLE after later imports');

console.log('\n--- CROSS-SET AMBIGUITY (real-world Umbreon case) ---');
t(M.crossSetAmbiguity.returned>1,`number "1" spans multiple sets (${M.crossSetAmbiguity.returned} candidates)`);
t(M.crossSetAmbiguity.ambiguous===true,'correctly flagged ambiguous');
console.log('    sets:',JSON.stringify(M.crossSetAmbiguity.distinctSets));

console.log('\n--- VARIANT AUDIT ON REAL-SHAPED DATA ---');
console.log('    swsh7 variants:',JSON.stringify(s7.variantAudit.counts));
t(s7.variantAudit.distinctVariants>1,`inference produced ${s7.variantAudit.distinctVariants} variants`);
t(typeof s7.variantAudit.fractionCollapsedToNormal==='number',
  `collapsed-to-normal measured: ${s7.variantAudit.fractionCollapsedToNormal}`);

console.log('\n--- SCALE ---');
console.log(`    query median by set: base1 ${b1.queryMedianMs}ms | swsh7 ${s7.queryMedianMs}ms | swsh9 ${s9.queryMedianMs}ms`);
console.log(`    perRecord bytes: ${s9.perRecordBytes}B at ${M.totals.records} records`);
t(s9.queryMedianMs<100,`query still <100ms at ${M.totals.records} records (${s9.queryMedianMs}ms)`);

console.log('\n--- REPORT + OVERALL ---');
t(/MULTI-SET/.test(M.reportText),'multi-set report header');
t(/Cross-set integrity/.test(M.reportText),'cross-set section present');
t(/UNRESOLVED/.test(M.reportText),'licensing still reported UNRESOLVED');
t(M.gate2Pass===true,`overall PASS (problems: ${JSON.stringify(M.problems)})`);
t(errs.length===0,`zero page errors (${errs.length})`);
console.log(f?`\n${f}/${n} FAILURES`:`\nALL ${n} PASS`);
await b.close(); process.exit(f?1:0);
})();
