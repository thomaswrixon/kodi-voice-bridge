const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { confirmedName, createCallSaver, isGoodbye } = require('../call-audit-policy');
const { decideTransferEligibility } = require('../transfer-eligibility');

let effective;
const compile = Module.prototype._compile;
Module.prototype._compile = function(source, filename) {
  if (filename === path.resolve(__dirname, '../server.js')) { effective = source; return; }
  return compile.call(this, source, filename);
};
try {
  require('../security-patch-helper').installSecurityPatchWrapper();
  require('../server-with-guidance');
} finally { Module.prototype._compile = compile; }
assert.ok(effective);
new vm.Script(effective);

test('trusted contact name survives transcription error; acknowledgements cannot become names', () => {
  assert.equal(confirmedName([{ role:'user', content:'Bob here from Clarendon.' }], {name:'Poppy'}), 'Poppy');
  for (const word of ['Yeah', 'Yes', 'Thanks', 'It is your mum']) {
    assert.equal(confirmedName([{role:'user',content:word}], null), '');
  }
  assert.equal(confirmedName([], {name:'Lilly Wrixon'}), 'Lilly Wrixon');
  assert.equal(confirmedName([], {name:'Liam',contact_conflict:true}), '');
});
test('concurrent saves create once, then update the same record', async () => {
  const calls=[];
  const save=createCallSaver(async (id,payload)=>{calls.push({id,payload}); await Promise.resolve(); return {id:id||'one'};});
  await Promise.all([save({text:'first'}),save({text:'second'}),save({text:'final'})]);
  assert.deepEqual(calls.map(c=>c.id), ['', 'one', 'one']);
  assert.equal(calls[2].payload.text,'final');
});
test('failed saves reject and leave the next attempt able to create',async()=>{
  let n=0;const save=createCallSaver(async id=>{if(!n++)throw Error('HTTP 500');return {id:id||'retry'};});
  await assert.rejects(save({}),/HTTP 500/);
  assert.equal((await save({})).id,'retry');
});
test('natural closing and transfer gate regressions',()=>{
  assert.equal(isGoodbye('See ya.'),true);assert.equal(isGoodbye('Cheers.'),true);
  assert.equal(isGoodbye('Tommy will get back to you. Anything else?'),false);
  for(const text of ['Can I please talk to my father, Tommy Wrixon?', 'Can I please have my father talk to me?']) {
    assert.equal(decideTransferEligibility({callerText:text,isFriendsFamily:true,knownContactName:'Lilly'}).allowed,true);
    assert.equal(decideTransferEligibility({callerText:text,isFriendsFamily:false}).allowed,false);
  }
  assert.equal(decideTransferEligibility({callerText:"This is Bob. Can I please talk to my father?",isFriendsFamily:true,knownContactName:'Lilly'}).allowed,false);
});

function runtime() {
  let socketServer;const sockets=[],writes=[],timers=[],sent=[];
  class Socket extends EventEmitter {
    static OPEN=1;
    constructor(){super();this.readyState=1;sockets.push(this);}
    send(data){sent.push(JSON.parse(data));}
    close(){this.readyState=3;}
    async deliver(data){for(const handler of this.listeners('message'))await handler(Buffer.from(JSON.stringify(data)));}
  }
  class WSS extends EventEmitter {constructor(){super();socketServer=this;}}
  const app={use(){},post(){},get(){},put(){}};
  const express=()=>app;express.urlencoded=express.json=express.static=()=>()=>{};
  const twilio=()=>({calls:()=>({update:async()=>({})})});twilio.twiml={VoiceResponse:class{}};
  const context={console:{log(){},error(){}},Buffer,URL,Date,Intl,AbortSignal,process:{env:{BASE44_API_KEY:'test',TWILIO_ACCOUNT_SID:'test',LCM_LOOKUP_URL:'https://example.test/lcm',LCM_LOOKUP_SECRET:'test'}},__dirname:path.resolve(__dirname,'..'),
    setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout(){},setImmediate(){},
    fetch:async(url,options={})=>{
      if((options.method==='POST'||options.method==='PUT') && url.includes('/Contact')) return {ok:true,status:200,json:async()=>({id:'contact'})};
      if(options.method==='POST'||options.method==='PUT'){writes.push({url,options,payload:JSON.parse(options.body)});return {ok:true,status:200,json:async()=>({id:'record-one'})};}
      return {ok:true,status:200,json:async()=>[]};
    },
    require(name){if(name==='dotenv')return {config(){}};if(name==='express')return express;if(name==='http')return {createServer:()=>({listen(){}})};if(name==='ws')return {WebSocket:Socket,WebSocketServer:WSS};if(name==='twilio')return twilio;return require(name.startsWith('.')?path.resolve(__dirname,'..',name):name);}
  };
  vm.runInNewContext(effective,context);
  const caller=new Socket();socketServer.emit('connection',caller);
  return {caller,sockets,writes,timers,sent,context};
}
test('production wrapper saves once, updates final transcript, and does not request speech after saving',async()=>{
  const r=runtime();
  await r.caller.deliver({event:'start',start:{streamSid:'MZtest',callSid:'CAtest',customParameters:{callerNumber:'+61411111111'}}});
  const ai=r.sockets[1];
  await ai.deliver({type:'conversation.item.input_audio_transcription.completed',transcript:'Jordan here from Clarendon.'});
  const save={type:'response.function_call_arguments.done',name:'save_caller_info',call_id:'tool1',arguments:JSON.stringify({name:'Jordan',reason:'Callback requested'})};
  await ai.deliver(save);await ai.deliver({...save,call_id:'tool2'});
  assert.equal(r.writes.length,2);
  assert.equal(r.writes[0].options.method,'POST');assert.equal(r.writes[1].options.method,'PUT');
  assert.equal(r.writes[0].payload.from_name,'Jordan');
  assert.equal(r.sent.filter(x=>x.type==='response.create').length,0);
  ai.emit('close',1000,'');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(r.writes.length,3);assert.equal(r.writes[2].options.method,'PUT');
});
test('builder lookup does not combine number with address or remove repeated digits',async()=>{
  const r=runtime();const requests=[];
  r.context.fetch=async(url,options)=>{requests.push(JSON.parse(options.body));return {ok:true,status:200,text:async()=>JSON.stringify({jobs:[]})};};
  const result=await vm.runInNewContext('lookupJobSchedule({search_term:"2111054",builder_job_number:"2111054",address:"2111054"})',r.context);
  assert.equal(result.status,'not_found');assert.equal(requests.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].query)),{limit:20,job_number:'2111054'});
});
test('save failure is reported truthfully by the production handler',async()=>{
  const r=runtime();await r.caller.deliver({event:'start',start:{streamSid:'MZtest',callSid:'CAtest',customParameters:{callerNumber:'+61411111111'}}});
  r.context.fetch=async()=>({ok:false,status:500});
  await r.sockets[1].deliver({type:'response.function_call_arguments.done',name:'save_caller_info',call_id:'failed',arguments:'{}'});
  const output=r.sent.find(x=>x.item?.call_id==='failed').item.output;
  assert.equal(JSON.parse(output).status,'save_failed');
});
test('goodbye drains queued audio and saving cannot generate a second goodbye',async()=>{
  const r=runtime();await r.caller.deliver({event:'start',start:{streamSid:'MZtest',callSid:'CAtest',customParameters:{callerNumber:'+61411111111'}}});
  const ai=r.sockets[1];
  await ai.deliver({type:'response.output_audio.delta',delta:Buffer.alloc(16000).toString('base64')});
  await ai.deliver({type:'response.output_audio_transcript.done',transcript:'Goodbye.'});
  await ai.deliver({type:'response.function_call_arguments.done',name:'save_caller_info',call_id:'saved',arguments:'{}'});
  assert.ok(r.timers.some(t=>t.ms>=2300),'wait for the queued two seconds of audio');
  const mediaCount=r.sent.filter(x=>x.event==='media').length;
  await ai.deliver({type:'response.output_audio.delta',delta:Buffer.alloc(8000).toString('base64')});
  assert.equal(r.sent.filter(x=>x.event==='media').length,mediaCount);
  assert.equal(r.sent.filter(x=>x.type==='response.create').length,0);
});
