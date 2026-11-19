#!/usr/bin/env python3
"""Validate the DPoP pilot dataset, then generate reproducible tables/figures."""
import csv, json, math, statistics, sys
from pathlib import Path

try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
except ImportError:
    print('Install research/dpop-durability/requirements-analysis.txt in a virtualenv.', file=sys.stderr)
    raise

ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT / 'results' / 'dpop-durability'
ALL_SCENARIOS=['memory_normal','memory_process_restart','redis_normal_cross_instance','redis_primary_sigkill','primary_only_detached','wait_replica_acked','wait_ack_insufficient','waitaof_local_replica_acked']
BASE_SCENARIOS=ALL_SCENARIOS[:4]
requested = [Path(p).resolve() for p in sys.argv[1:]]
folders = requested or sorted(p for p in BASE.iterdir() if p.is_dir())
complete, exclusions = [], []
for folder in folders:
    if folder.name == 'validation': continue
    meta = folder / 'metadata' / 'run.json'
    req_path = folder / 'raw' / 'requests.csv'
    ev_path = folder / 'raw' / 'events.jsonl'
    if not meta.exists() or not req_path.exists() or not ev_path.exists():
        reason = 'incomplete/failed pilot: no complete run metadata and normalized raw dataset'
        failure = folder / 'logs' / 'failure.txt'
        if failure.exists(): reason += '; ' + failure.read_text().splitlines()[0][:180]
        exclusions.append({'experiment_id': folder.name, 'valid': False, 'reason': reason})
        continue
    m = json.loads(meta.read_text())
    if m.get('pilot'):
        exclusions.append({'experiment_id':m['experiment_id'],'valid':False,'reason':'one-repetition replicated-topology pilot excluded by predeclared inclusion policy'})
        continue
    if m.get('invalid_for_main_analysis'):
        exclusions.append({'experiment_id':m['experiment_id'],'valid':False,'reason':m.get('exclusion_note','invalid dataset excluded')})
        continue
    rows = list(csv.DictReader(req_path.open()))
    m['_analysis_scenarios']=[s for s in m.get('scenarios',[]) if s in ALL_SCENARIOS] or BASE_SCENARIOS
    # Schema-v1 records used an empty acknowledgement field for replay outcomes;
    # normalize this explicitly in-memory without rewriting the immutable raw CSV.
    for row in rows:
        if row.get('acknowledgement_result', '') == '': row['acknowledgement_result'] = 'not_applicable'
        if row.get('acknowledgement_count', '') == '': row['acknowledgement_count'] = 'not_applicable'
    events = [json.loads(x) for x in ev_path.read_text().splitlines() if x.strip()]
    errors = []
    required = {'experiment_id','run_id','repetition','scenario','backend','durability','replica_id','request_type','timestamp_utc','monotonic_ns','client_request_id','proof_jti_sha256','backend_result','acknowledgement_result','latency_ms','request_outcome','replay_outcome','protected_operation_executed'}
    for i, row in enumerate(rows, 1):
        missing = sorted(k for k in required if k not in row or row[k] == '')
        if missing: errors.append(f'row {i}: missing {missing}')
        if row.get('experiment_id') != m['experiment_id']: errors.append(f'row {i}: experiment id mismatch')
        if not row.get('client_request_id'): errors.append(f'row {i}: blank request id')
        try:
            if float(row['latency_ms']) < 0: errors.append(f'row {i}: negative latency')
            int(row['monotonic_ns'])
        except (ValueError, KeyError): errors.append(f'row {i}: invalid timing')
        if row.get('request_type') == 'replay' or 'replay' in row.get('request_type',''):
            if row.get('replay_outcome') == 'replay' and row.get('protected_operation_executed') == 'true': errors.append(f'row {i}: replay rejection executed operation')
    ids = [r.get('client_request_id') for r in rows]
    if len(ids) != len(set(ids)): errors.append('duplicate request IDs')
    run_ids={(r.get('experiment_id'),r.get('run_id')) for r in rows}
    expected_scenarios=set(m['_analysis_scenarios'])
    if len(run_ids)!=int(m['repetitions'])*len(expected_scenarios): errors.append('experiment/run ID count does not match repetition/scenario matrix')
    try:
        event_mono=[int(e['monotonic_ns']) for e in events]
        if any(b<=a for a,b in zip(event_mono,event_mono[1:])): errors.append('event monotonic timestamps not strictly increasing')
    except (KeyError,ValueError): errors.append('event missing/invalid monotonic timestamp')
    health=[e for e in events if e.get('event_type')=='backend_health' and (e.get('healthy') is True or (e.get('primary_healthy') is True and e.get('replica_healthy') is True))]
    if not health: errors.append('backend health before scenario missing')
    fault_scenarios=set(expected_scenarios)-{'memory_normal','memory_process_restart','redis_normal_cross_instance'}
    for rep in range(1,int(m['repetitions'])+1):
        for scenario in fault_scenarios:
            if not any(e.get('event_type')=='recovery_complete' and e.get('repetition')==rep and e.get('scenario')==scenario and e.get('backend_healthy') is True for e in events): errors.append(f'repetition {rep} {scenario}: backend healthy after recovery missing')
    by = {}
    for row in rows: by.setdefault((int(row['repetition']), row['scenario']), []).append(row)
    for rep in range(1, int(m['repetitions']) + 1):
        for scenario in expected_scenarios:
            group = by.get((rep, scenario), [])
            if len(group) != 2: errors.append(f'repetition {rep} {scenario}: expected 2 request rows, found {len(group)}'); continue
            first = next((r for r in group if r['request_type'] == 'first_use'), None)
            replay = next((r for r in group if r['request_type'] != 'first_use'), None)
            if not first or not replay: errors.append(f'repetition {rep} {scenario}: missing first/replay pair'); continue
            if first['proof_jti_sha256'] != replay['proof_jti_sha256']: errors.append(f'repetition {rep} {scenario}: JTI hash mismatch')
            if scenario=='wait_ack_insufficient':
                if first['backend_result']!='ACKNOWLEDGEMENT_INSUFFICIENT' or first['request_outcome']!='rejected' or first['protected_operation_executed']!='false': errors.append(f'repetition {rep} {scenario}: insufficient acknowledgement did not fail closed')
                if first.get('acknowledgement_count')!='0': errors.append(f'repetition {rep} {scenario}: actual WAIT count is not zero')
                detached=next((e for e in events if e.get('event_type')=='replication_detached' and e.get('repetition')==rep and e.get('scenario')==scenario),None)
                if not detached or detached.get('replica_link_status')!='down' or int(detached.get('monotonic_ns',0))>=int(first['monotonic_ns']): errors.append(f'repetition {rep} {scenario}: no verified replica-link interruption before WAIT')
            elif scenario=='wait_replica_acked':
                if first.get('acknowledgement_result')!='wait' or int(first.get('acknowledgement_count','0'))<1: errors.append(f'repetition {rep} {scenario}: required WAIT acknowledgement absent')
            elif scenario=='waitaof_local_replica_acked':
                if first.get('acknowledgement_result')!='waitaof' or int(first.get('acknowledgement_count','0'))<1 or int(first.get('local_aof_ack_count','0'))<1: errors.append(f'repetition {rep} {scenario}: local/replica WAITAOF acknowledgement absent')
            elif scenario=='primary_only_detached':
                if first.get('acknowledgement_result')!='primary_reply' or first.get('acknowledgement_count')!='0': errors.append(f'repetition {rep} {scenario}: primary-only acknowledgement metadata inconsistent')
                detached=next((e for e in events if e.get('event_type')=='replication_detached' and e.get('repetition')==rep and e.get('scenario')==scenario),None)
                if not detached or detached.get('replica_role')!='slave' or detached.get('replica_link_status')!='down' or int(detached.get('monotonic_ns',0))>=int(first['monotonic_ns']): errors.append(f'repetition {rep} {scenario}: replica link was not verified down before write')
            elif first['request_outcome'] != 'accepted' or first['protected_operation_executed'] != 'true': errors.append(f'repetition {rep} {scenario}: first use not accepted/executed')
    for rep in range(1, int(m['repetitions']) + 1):
      for scenario in fault_scenarios:
        sev = [e for e in events if e.get('repetition') == rep and e.get('scenario') == scenario]
        types = [e.get('event_type') for e in sev]
        for required_event in ('fault_start','recovery_complete','scenario_result'):
            if required_event not in types: errors.append(f'repetition {rep}: missing {required_event}')
        fault = next((e for e in sev if e.get('event_type') == 'fault_start'), {})
        result = next((e for e in sev if e.get('event_type') == 'scenario_result'), {})
        kill_event=next((e for e in sev if e.get('event_type')=='primary_sigkill_completed'),None)
        if scenario in ('primary_only_detached','wait_replica_acked','wait_ack_insufficient','waitaof_local_replica_acked') and not kill_event: errors.append(f'repetition {rep} {scenario}: completed SIGKILL event missing')
        if not any(e.get('event_type')=='primary_sigkill_completed' for e in sev):
            # Earlier complete records predate the explicit completion event. A
            # successful recovery/promoted-replica replay plus completed run
            # proves the synchronous Docker kill/control call returned first.
            if not any(e.get('event_type')=='recovery_complete' for e in sev) or not any(r.get('scenario')==scenario and int(r.get('repetition',0))==rep and r.get('request_type')!='first_use' for r in rows):
                errors.append(f'repetition {rep} {scenario}: no completed fault/recovery evidence')
        first_for_scenario=next((r for r in rows if int(r['repetition'])==rep and r['scenario']==scenario and r['request_type']=='first_use'),{})
        fault_ack=fault.get('acknowledgement_result',fault.get('ack_observed'))
        if fault_ack != first_for_scenario.get('acknowledgement_result'): errors.append(f'repetition {rep} {scenario}: acknowledgement/fault record mismatch')
        try:
            fault_ns=int(fault['monotonic_ns'])
            recovery=next(e for e in sev if e.get('event_type')=='recovery_complete')
            replay_row=next(r for r in rows if int(r['repetition'])==rep and r['scenario']==scenario and r['request_type']!='first_use')
            if int(recovery['monotonic_ns']) <= fault_ns: errors.append(f'repetition {rep}: recovery precedes fault')
            if kill_event and int(kill_event['monotonic_ns'])>=int(recovery['monotonic_ns']): errors.append(f'repetition {rep} {scenario}: recovery precedes primary SIGKILL')
            restore=next((e for e in sev if e.get('event_type')=='replica_network_restored'),None)
            if scenario in ('primary_only_detached','wait_ack_insufficient') and (not restore or int(restore['monotonic_ns'])>=int(recovery['monotonic_ns'])): errors.append(f'repetition {rep} {scenario}: replica network restoration missing/out of order')
            if int(replay_row['monotonic_ns']) <= int(recovery['monotonic_ns']): errors.append(f'repetition {rep}: replay precedes recovery')
            first_row=first_for_scenario
            result_event=next(e for e in sev if e.get('event_type')=='scenario_result')
            expected_loss=first_row.get('backend_result')=='FIRST_USE' and first_row.get('backend') not in ('memory',) and replay_row.get('request_outcome')=='accepted'
            if result_event.get('acknowledged_write_lost') is not bool(expected_loss): errors.append(f'repetition {rep} {scenario}: loss metric does not match request evidence')
        except (StopIteration,KeyError,ValueError): errors.append(f'repetition {rep}: incomplete fault timeline')
    if len(rows) != int(m['request_count']): errors.append('request count differs from run metadata')
    exclusions.append({'experiment_id': m['experiment_id'], 'valid': not errors, 'reason': '; '.join(errors) if errors else ''})
    if not errors: complete.append((folder, m, rows, events))

summary_dir = (complete[0][0] / 'summaries') if complete else (BASE / 'validation')
summary_dir.mkdir(parents=True, exist_ok=True)
with (summary_dir / 'invalid-run-exclusion-log.csv').open('w', newline='') as f:
    w=csv.DictWriter(f,fieldnames=['experiment_id','valid','reason']); w.writeheader(); w.writerows(exclusions)
if not complete:
    print(json.dumps({'valid_runs':0,'exclusions':exclusions},indent=2)); raise SystemExit(1)

summaries=[]
scenario_order=ALL_SCENARIOS.copy()
for folder, meta, rows, events in complete:
    for scenario in meta['_analysis_scenarios']:
        for rep in sorted({int(r['repetition']) for r in rows}):
            group=[r for r in rows if int(r['repetition'])==rep and r['scenario']==scenario]
            replay=next(r for r in group if r['request_type']!='first_use')
            first=next(r for r in group if r['request_type']=='first_use')
            loss=first['backend_result']=='FIRST_USE' and first['backend'] not in ('memory',) and replay['request_outcome']=='accepted'
            summaries.append({'experiment_id':meta['experiment_id'],'repetition':rep,'scenario':scenario,'backend':first['backend'],'replay_attempts':1,'replay_accepted':int(replay['request_outcome']=='accepted'),'replay_rejected_as_replay':int(replay['replay_outcome']=='replay'),'first_use_success':int(first['request_outcome']=='accepted'),'protected_executions_same_proof':int(first['protected_operation_executed']=='true')+int(replay['protected_operation_executed']=='true'),'acknowledged_write_lost':int(loss),'first_use_latency_ms':float(first['latency_ms']),'replay_latency_ms':float(replay['latency_ms'])})
scenario_order=[s for s in scenario_order if any(r['scenario']==s for r in summaries)]
summary_dir.mkdir(parents=True,exist_ok=True)
fields=list(summaries[0])
with (summary_dir/'per_repetition.csv').open('w',newline='') as f:
    w=csv.DictWriter(f,fieldnames=fields);w.writeheader();w.writerows(summaries)

def wilson(k,n,z=1.96):
    if not n:return (math.nan,math.nan)
    p=k/n; den=1+z*z/n; center=(p+z*z/(2*n))/den; half=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/den
    return max(0,center-half),min(1,center+half)
agg=[]
for scenario in scenario_order:
    group=[r for r in summaries if r['scenario']==scenario]
    n=len(group); accepted=sum(r['replay_accepted'] for r in group); detected=sum(r['replay_rejected_as_replay'] for r in group); lost=sum(r['acknowledged_write_lost'] for r in group)
    lo,hi=wilson(accepted,n)
    lats=[r['first_use_latency_ms'] for r in group]+[r['replay_latency_ms'] for r in group]
    agg.append({'scenario':scenario,'backend':group[0]['backend'],'independent_repetitions':n,'replay_attempts':n,'replay_acceptances':accepted,'replay_acceptance_rate':accepted/n,'wilson95_low':lo,'wilson95_high':hi,'replay_detections':detected,'acknowledged_write_losses':lost,'duplicate_protected_operations':sum(max(0,r['protected_executions_same_proof']-1) for r in group),'valid_first_uses_accepted':sum(r['first_use_success'] for r in group),'valid_first_use_success_rate':sum(r['first_use_success'] for r in group)/n,'latency_observations':len(lats),'latency_p50_ms':statistics.median(lats),'latency_p95_ms':sorted(lats)[math.ceil(.95*len(lats))-1],'latency_p99_ms':sorted(lats)[math.ceil(.99*len(lats))-1]})
with (summary_dir/'results-table.csv').open('w',newline='') as f:
    w=csv.DictWriter(f,fieldnames=list(agg[0]));w.writeheader();w.writerows(agg)
with (summary_dir/'results-table.md').open('w') as f:
    f.write('| Scenario | n runs | Replay accepted | Replay detections | Ack write loss | Duplicate operation executions | Valid first-use success | p50 / p95 / p99 local latency (ms) |\n|---|---:|---:|---:|---:|---:|---:|---:|\n')
    for a in agg:f.write(f"| {a['scenario']} | {a['independent_repetitions']} | {a['replay_acceptances']}/{a['replay_attempts']} ({a['replay_acceptance_rate']:.0%}) | {a['replay_detections']}/{a['replay_attempts']} | {a['acknowledged_write_losses']}/{a['replay_attempts']} | {a['duplicate_protected_operations']} | {a['valid_first_uses_accepted']}/{a['independent_repetitions']} | {a['latency_p50_ms']:.3f} / {a['latency_p95_ms']:.3f} / {a['latency_p99_ms']:.3f} |\n")
rq_map={'memory_normal':'RQ1, RQ3','memory_process_restart':'RQ1, RQ2','redis_normal_cross_instance':'RQ1, RQ3','redis_primary_sigkill':'RQ1, RQ2, RQ3','primary_only_detached':'RQ1, RQ2','wait_replica_acked':'RQ1, RQ2, RQ3','wait_ack_insufficient':'RQ1, RQ2, RQ3','waitaof_local_replica_acked':'RQ1, RQ2, RQ3'}
configuration_facts={
 'memory_normal':('process-local memory','volatile process state',1,'none; same-instance replay'),
 'memory_process_restart':('process-local memory','volatile process state',1,'reset memory store; replay original proof'),
 'redis_normal_cross_instance':('Redis 7.4.12','SET NX; 360s TTL; primary reply only; RDB/AOF off',1,'logical cross-instance replay; no Redis fault'),
 'redis_primary_sigkill':('Redis 7.4.12','SET NX; 360s TTL; primary reply only; RDB/AOF off',1,'SIGKILL; restart volatile primary; replay'),
 'primary_only_detached':('Redis 7.4.12','SET NX; 360s TTL; primary reply only; no persistence',2,'REPLICAOF NO ONE before write; SIGKILL; manual promotion'),
 'wait_replica_acked':('Redis 7.4.12','SET NX; WAIT 1 1500ms; AOF off',2,'WAIT replica ack; SIGKILL; manual promotion'),
 'wait_ack_insufficient':('Redis 7.4.12','SET NX; WAIT 1 250ms; AOF off',2,'detach replica; insufficient ack fail closed; SIGKILL; promote'),
 'waitaof_local_replica_acked':('Redis 7.4.12','AOF on; appendfsync always; WAITAOF 1 1 2000ms',2,'local+replica AOF ack; SIGKILL; manual promotion')}
configurations=[]
for s in scenario_order:
    backend,durability,repl,fault=configuration_facts[s]
    configurations.append({'scenario':s,'backend':backend,'durability':durability,'replica_count':repl,'fault':fault,'repetitions':len([r for r in summaries if r['scenario']==s]),'rq':rq_map[s]})
with (summary_dir/'configuration-matrix.csv').open('w',newline='') as f:
    w=csv.DictWriter(f,fieldnames=list(configurations[0]));w.writeheader();w.writerows(configurations)
with (summary_dir/'configuration-matrix.md').open('w') as f:
    f.write('| Scenario | Backend | Durability | Replicas | Fault | Repetitions | RQ |\n|---|---|---|---:|---|---:|---|\n')
    for c in configurations:f.write(f"| {c['scenario']} | {c['backend']} | {c['durability']} | {c['replica_count']} | {c['fault']} | {c['repetitions']} | {c['rq']} |\n")
coverage=[
 ('Replay acceptance/detection','measured','10 attempts per condition; raw counts and Wilson 95% intervals'),
 ('Acknowledged-write loss','measured','primary reply only, post-restart replay acceptance proves absence operationally'),
 ('Duplicate protected execution','measured','operation execution is the verifier result flag, one or two per proof'),
 ('Cross-instance replay','measured, logical only','separate store instances share standalone Redis; not separate service processes'),
 ('Concurrent identical proof','functional test only','32-way concurrency in process-memory unit test; not a multi-replica backend run'),
 ('Latency p50/p95/p99','measured, descriptive','20 local verifier/store observations per condition; no sustained load'),
 ('Throughput','not measured','no workload-duration throughput run'),
 ('CPU utilization','not measured','host load average is contextual only'),
 ('Memory utilization','not compared','runner RSS was logged; no per-backend controlled utilization analysis'),
 ('Recovery time','measured for Redis restart only','fault initiation to successful Redis PING; excludes service health/client outage'),
 ('Availability/fail-closed during outage','not measured experimentally','store error is covered by functional test; no live HTTP outage traffic'),
 ('Redis WAIT/WAITAOF/manual replica promotion','measured','single replica on same host; no Sentinel/Cluster; see scenario-specific rows'),
 ('MySQL InnoDB','not executed','no isolated DPoP MySQL condition')]
with (summary_dir/'metric-coverage.csv').open('w',newline='') as f:
    w=csv.writer(f);w.writerow(['metric','status','definition_or_limit']);w.writerows(coverage)
recovery_rows=[]
for folder, meta, rows, events in complete:
    for ev in events:
        if ev.get('event_type')=='recovery_complete': recovery_rows.append({'experiment_id':meta['experiment_id'],'repetition':ev['repetition'],'scenario':ev['scenario'],'fault_to_redis_ping_ms':ev.get('recovered_ms',ev.get('recovery_ms')),'backend_healthy':ev['backend_healthy']})
with (summary_dir/'recovery-time.csv').open('w',newline='') as f:
    w=csv.DictWriter(f,fieldnames=['experiment_id','repetition','scenario','fault_to_redis_ping_ms','backend_healthy']);w.writeheader();w.writerows(recovery_rows)
validation={'valid_experiment_runs':len(complete),'invalid_or_partial_runs':sum(not x['valid'] for x in exclusions),'runs':exclusions,'schema':'dpop-durability-v1','checks':['required fields','unique request IDs and experiment/run IDs','experiment metadata','request counts','strict event monotonic ordering','first-use/replay pairing','JTI correlation','first-use protected operation','replay not rejected after protected execution','backend health before scenarios and after recovery','fault event','recovery event','primary acknowledgement','acknowledged-loss outcome','run summaries recomputed from raw requests']}
for folder, *_ in complete:
    (folder/'validation'/'validation-summary.json').write_text(json.dumps(validation,indent=2)+'\n')
    with (folder/'validation'/'per-run-validity.csv').open('w',newline='') as f:
        w=csv.DictWriter(f,fieldnames=['experiment_id','valid','reason']);w.writeheader();w.writerows(exclusions)
    this_run=[r for r in summaries if r['experiment_id']==folder.name]
    (folder/'reports'/'run-report.md').write_text(f"# Run report: {folder.name}\n\n- Repetitions: {len({r['repetition'] for r in this_run})}.\n- Measured calls: {len(rows)}.\n- Scenarios: {', '.join(sorted({r['scenario'] for r in this_run}))}.\n- Topology and fault configuration: see `../metadata/run.json`.\n- Validation: PASS; see `../validation/validation-summary.json`.\n- Raw observations: `../raw/requests.csv`, `../raw/requests.jsonl`, `../raw/events.jsonl`.\n")

plt.rcParams.update({'font.size':9,'axes.titlesize':11,'figure.dpi':150,'savefig.dpi':300})
short_labels={'memory_normal':'Memory\nnormal','memory_process_restart':'Memory\nreset','redis_normal_cross_instance':'Redis\nshared','redis_primary_sigkill':'Redis\nprimary crash','primary_only_detached':'Primary only\nreplica detached','wait_replica_acked':'WAIT\nreplica ack','wait_ack_insufficient':'WAIT\nack insufficient','waitaof_local_replica_acked':'WAITAOF\nlocal + replica'}
fig,ax=plt.subplots(figsize=(11,4.8)); xs=range(len(agg)); rates=[a['replay_acceptance_rate'] for a in agg]; lows=[max(0,a['replay_acceptance_rate']-a['wilson95_low']) for a in agg]; highs=[max(0,a['wilson95_high']-a['replay_acceptance_rate']) for a in agg]
palette=['#64748b','#dc6b42','#3478a8','#bd3d3a','#b45309','#2f855a','#a16207','#047857']
ax.bar(list(xs),rates,color=palette[:len(agg)],width=.66);ax.errorbar(list(xs),rates,yerr=[lows,highs],fmt='none',ecolor='#172033',capsize=4,lw=1)
ax.set_xticks(list(xs),[short_labels[a['scenario']] for a in agg]);ax.set_ylabel('Replay acceptance rate');ax.set_ylim(0,1.08);ax.set_yticks([0,.25,.5,.75,1],['0%','25%','50%','75%','100%']);ax.set_title('Replay acceptance by tested condition (95% Wilson intervals)');ax.grid(axis='y',alpha=.25);fig.tight_layout()
for ext in ('png','pdf'):fig.savefig(complete[0][0]/'figures'/f'replay-acceptance.{ext}')
plt.close(fig)

# Representative standalone and replicated timelines use monotonic host clocks.
for target_scenario,timeline_name in [('redis_primary_sigkill','redis-crash-timeline'),('wait_replica_acked','redis-replicated-failover-timeline')]:
    source=next((x for x in complete if target_scenario in {r['scenario'] for r in x[2]}),None)
    if not source: continue
    _,meta,rows,events=source; rep=min(int(r['repetition']) for r in rows if r['scenario']==target_scenario)
    timeline=[e for e in events if e.get('repetition')==rep and e.get('scenario')==target_scenario and e.get('event_type') in ('request_complete','acknowledgement_observed','fault_start','primary_sigkill_completed','recovery_complete','scenario_result')]
    if timeline:
        base=min(int(e['monotonic_ns']) for e in timeline); fig,ax=plt.subplots(figsize=(9,3))
        for i,e in enumerate(timeline):
            t=(int(e['monotonic_ns'])-base)/1e6;label=e.get('event_type')
            if label=='request_complete':label=f"{e.get('backend_result')} ({e.get('acknowledgement_result') or 'no ack'})"
            elif label=='acknowledgement_observed':label=f"ack={e.get('acknowledgement_result')} count={e.get('acknowledgement_count')}"
            ax.scatter(t,i,s=35);ax.annotate(label,(t,i),xytext=(6,0),textcoords='offset points',va='center')
        ax.set_yticks([]);ax.set_xlabel('Monotonic elapsed time (ms)');ax.set_title(f'{target_scenario}: representative fault/recovery sequence (repetition {rep})');ax.grid(axis='x',alpha=.25);fig.tight_layout()
        for ext in ('png','pdf'):fig.savefig(complete[0][0]/'figures'/f'{timeline_name}.{ext}')
        plt.close(fig)

# Topology/setup diagram (schematic, not a measured production architecture).
fig,ax=plt.subplots(figsize=(9,3.1));ax.axis('off')
boxes=[(.03,.40,.18,.32,'DPoP client\nES256 proof +\nbound access token'),(.31,.40,.20,.32,'Resource verifier\nclaims, signature,\nkey binding, replay'),(.66,.62,.27,.23,'Redis primary\nSET NX + TTL\nWAIT / WAITAOF'),(.66,.17,.27,.23,'Redis replica\nmanual promotion\nAOF for WAITAOF'),(.02,.08,.22,.20,'Memory baseline\nprocess-local state')]
for x,y,w,h,label in boxes:
    ax.add_patch(plt.Rectangle((x,y),w,h,facecolor='#edf2f7',edgecolor='#334155',lw=1.2));ax.text(x+w/2,y+h/2,label,ha='center',va='center',fontsize=9)
ax.annotate('',xy=(.31,.56),xytext=(.21,.56),arrowprops={'arrowstyle':'->','lw':1.4});ax.text(.26,.62,'HTTPS not exercised',ha='center',fontsize=7)
ax.annotate('',xy=(.66,.70),xytext=(.51,.62),arrowprops={'arrowstyle':'->','lw':1.4});ax.annotate('',xy=(.66,.28),xytext=(.80,.62),arrowprops={'arrowstyle':'<->','lw':1.4});ax.text(.82,.46,'async replication',fontsize=7,rotation=90,ha='center')
ax.annotate('',xy=(.24,.18),xytext=(.40,.40),arrowprops={'arrowstyle':'->','lw':1.0,'linestyle':'--'});ax.text(.5,.04,'All containers share one host/kernel; no Sentinel/Cluster or separate resource-service processes',ha='center',fontsize=9,color='#7f1d1d')
fig.tight_layout()
for ext in ('png','pdf'):fig.savefig(complete[0][0]/'figures'/f'topology-schematic.{ext}')
plt.close(fig)

# Experiment matrix overview.
fig,ax=plt.subplots(figsize=(8.5,3.2));ax.axis('off')
matrix=[['Condition','Backend / policy','Fault / path','Repetitions','RQ'],['Memory normal','process-local','same instance replay',str(len([r for r in summaries if r['scenario']=='memory_normal'])),'RQ1, RQ3'],['Memory restart','process-local','reset store; replay',str(len([r for r in summaries if r['scenario']=='memory_process_restart'])),'RQ1, RQ2'],['Redis shared','Redis SET NX, primary reply','cross-instance replay',str(len([r for r in summaries if r['scenario']=='redis_normal_cross_instance'])),'RQ1, RQ3'],['Redis crash','Redis volatile, primary reply','SIGKILL + restart',str(len([r for r in summaries if r['scenario']=='redis_primary_sigkill'])),'RQ1, RQ2, RQ3']]
t=ax.table(cellText=matrix[1:],colLabels=matrix[0],loc='center',cellLoc='left');t.auto_set_font_size(False);t.set_fontsize(8);t.scale(1,1.55);ax.set_title('Executed experiment matrix (each run is one independent repetition)',pad=12);fig.tight_layout()
for ext in ('png','pdf'):fig.savefig(complete[0][0]/'figures'/f'experiment-matrix.{ext}')
plt.close(fig)

# Descriptive request-level latency percentiles from the validated local verifier/store call.
fig,ax=plt.subplots(figsize=(11,4.6)); width=.23
for j,key in enumerate(('latency_p50_ms','latency_p95_ms','latency_p99_ms')):
    vals=[a[key] for a in agg];ax.bar([i+(j-1)*width for i in range(len(agg))],vals,width=width,label=key.replace('latency_','').replace('_ms','').upper())
ax.set_xticks(list(range(len(agg))),[short_labels[a['scenario']] for a in agg]);ax.set_ylabel('Latency (ms)');ax.set_title('Local verifier plus replay-store latency (descriptive; nearest-rank p95/p99)');ax.legend(frameon=False,ncol=3);ax.grid(axis='y',alpha=.25);fig.tight_layout()
for ext in ('png','pdf'):fig.savefig(complete[0][0]/'figures'/f'latency-percentiles.{ext}')
plt.close(fig)

# Security/performance view is descriptive: it does not imply a causal policy trade-off.
fig,ax=plt.subplots(figsize=(7.5,4.5))
for a in agg:
    i=scenario_order.index(a['scenario']);ax.errorbar(a['latency_p50_ms'],a['replay_acceptance_rate'],yerr=[[max(0,a['replay_acceptance_rate']-a['wilson95_low'])],[max(0,a['wilson95_high']-a['replay_acceptance_rate'])]],fmt='o',capsize=4,label=a['scenario'])
ax.set_xlabel('Median local call latency (ms)');ax.set_ylabel('Observed replay acceptance');ax.set_ylim(-.05,1.08);ax.set_yticks([0,.25,.5,.75,1],['0%','25%','50%','75%','100%']);ax.set_title('Observed security and latency outcomes (descriptive)');ax.grid(alpha=.25);ax.legend(fontsize=7,frameon=False);fig.tight_layout()
for ext in ('png','pdf'):fig.savefig(complete[0][0]/'figures' / f'security-latency-descriptive.{ext}')
plt.close(fig)

manifest={
 'generated_by':'research/dpop-durability/scripts/analyze.py',
 'validated_datasets':[str(folder.relative_to(ROOT)) for folder, *_ in complete],
 'excluded_runs':exclusions,
 'tables':[{'path':str((summary_dir/name).relative_to(ROOT)),'source':'validated raw/requests.csv and raw/events.jsonl','script':'research/dpop-durability/scripts/analyze.py'} for name in ['per_repetition.csv','results-table.csv','results-table.md','configuration-matrix.csv','configuration-matrix.md','metric-coverage.csv','recovery-time.csv','invalid-run-exclusion-log.csv']],
 'figures':[{'path':str((complete[0][0]/'figures'/f'{name}.{ext}').relative_to(ROOT)),'source':'validated raw observations' if name not in ('topology-schematic','experiment-matrix') else 'documented topology/executed matrix','script':'research/dpop-durability/scripts/analyze.py'} for name in ['replay-acceptance','redis-crash-timeline','redis-replicated-failover-timeline','topology-schematic','experiment-matrix','latency-percentiles','security-latency-descriptive'] for ext in ['png','pdf']]
}
(BASE/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')

print(json.dumps({'valid_runs':len(complete),'exclusions':exclusions,'results':agg,'output':str(summary_dir)},indent=2))
