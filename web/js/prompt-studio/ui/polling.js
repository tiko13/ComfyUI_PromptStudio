/** View-owned scheduling. Disposing a view never cancels an inference job. */
export function createPollingScope({view=globalThis,online=()=>view.navigator?.onLine!==false,visible=()=>!view.document?.hidden}={}) {
  const jobs=new Set();let disposed=false;
  const add=(run,{interval=2500,hiddenInterval=30000,offlineInterval=30000,background=()=>false}={})=>{
    let timer=null,running=false,stopped=false;
    const schedule=()=>{if(!stopped&&!disposed)timer=view.setTimeout(tick,!online()?offlineInterval:(!visible()&&!background()?hiddenInterval:interval));};
    const tick=async()=>{
      if(stopped||disposed||running)return;
      if(timer!==null)view.clearTimeout(timer);timer=null;
      running=true;
      try {if(online())await run();} catch (_) { /* Callers own their visible error state. */ }
      finally {running=false;schedule();}
    };
    const job={wake(){if(!running)void tick();},stop(){stopped=true;if(timer!==null)view.clearTimeout(timer);jobs.delete(job);}};
    jobs.add(job);void tick();return job.stop;
  };
  const wake=()=>{for(const job of jobs)job.wake();};
  view.addEventListener?.('online',wake);
  view.document?.addEventListener('visibilitychange',wake);
  const dispose=()=>{
    if(disposed)return;disposed=true;for(const job of [...jobs])job.stop();
    view.removeEventListener?.('online',wake);view.removeEventListener?.('pagehide',dispose);
    view.document?.removeEventListener('visibilitychange',wake);
  };
  view.addEventListener?.('pagehide',dispose,{once:true});
  return {add,dispose,get size(){return jobs.size;}};
}

/** Identical read-only health requests share in-flight work and a short cache. */
export function createHealthReader({fetch,now=()=>Date.now(),ttl=2000,maxEntries=16}={}) {
  const cache=new Map();
  return async (endpoint,settings={})=>{
    const provider=settings.llm_provider || 'koboldcpp';
    const fields=Object.keys(settings).filter(key=>key==='llm_provider'||key.startsWith(provider==='koboldcpp'?'kobold_':provider+'_')).sort();
    const key=endpoint+JSON.stringify(fields.map(name=>[name,settings[name]]));
    const previous=cache.get(key);
    if(previous&&(previous.pending||now()-previous.time<ttl))return previous.promise.then(value=>structuredClone(value));
    if(cache.size>=maxEntries) {
      const idle=[...cache].find(([,entry])=>!entry.pending);
      if(idle)cache.delete(idle[0]);
      else throw new Error('Health checks are busy; retry shortly.');
    }
    const entry={pending:true,time:now(),promise:null};
    entry.promise=(async()=>{
      try {
        const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings),signal:AbortSignal.timeout(10000)});
        const data=await response.json();if(!response.ok)throw new Error(data.error||`Health check failed (${response.status}).`);
        entry.time=now();return data;
      } catch(error) {cache.delete(key);throw error;}
      finally {entry.pending=false;}
    })();
    cache.set(key,entry);return entry.promise.then(value=>structuredClone(value));
  };
}
