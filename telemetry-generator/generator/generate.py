#!/usr/bin/env python3
"""Brahmastra fictional, non-operational system-health telemetry generator RC1.

Runs: source samples and separately received delivery times; evaluation truth is private.
Requires: Python 3.10+, numpy, PyYAML. Reproducible by deterministic seeds.
"""
import csv, hashlib, json, math, sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
import numpy as np
import yaml

ROOT=Path(__file__).resolve().parents[1]
REGISTRY_PATH=ROOT/'source_registry/master_specification.yaml'
BASE_TIME=datetime(2026,1,1,0,0,0,tzinfo=timezone.utc)
GENERATOR_VERSION='RC1.0.0'


def stamp(seconds):
    return (BASE_TIME+timedelta(seconds=float(seconds))).isoformat(timespec='milliseconds').replace('+00:00','Z')


def hash_file(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def jdump(p, data):
    Path(p).parent.mkdir(parents=True,exist_ok=True)
    Path(p).write_text(json.dumps(data,indent=2,sort_keys=True,ensure_ascii=False)+'\n',encoding='utf-8')


def make_plan(spec):
    """Raw run numbers have no scenario mnemonic in agent-visible paths."""
    return [(sid, seed, f'BM-RUN-{(i*3+seed):04d}', f'{sid}-{seed:03d}')
            for i,sid in enumerate(s['id'] for s in spec['scenarios']) for seed in (1,2,3)]


def build_run(spec, scenario_id, seed, public_id, internal_id, output_root=ROOT):
    n=int(spec['simulation']['timestamp_model']['rows_per_run'])
    hz=spec['targets']['sampling_hz']
    assert hz==2 and n==1800
    phases=spec['phases']; channel_specs=spec['channels']
    t=np.arange(n,dtype=float)/hz
    phase_idx=np.empty(n,dtype=int); sub_ids=np.empty(n,dtype=object)
    for i,ph in enumerate(phases):
        a,b=ph['nominal_window_s']['start'],ph['nominal_window_s']['end_exclusive']
        phase_idx[(t>=a)&(t<b)]=i
        for sub in ph['subphases']:
            x,y=sub['nominal_window_s']['start'],sub['nominal_window_s']['end_exclusive']
            sub_ids[(t>=x)&(t<y)]=sub['id']
    # Independent controlled PRNG stream per run and scenario (no machine-dependent randomness).
    sid_index=int(scenario_id[1:]);rng=np.random.default_rng(100000+sid_index*1000+seed)
    v={};
    def norm(name,center,std=0.004,low=0,high=1):
        v[name]=np.clip(center+rng.normal(0,std,n),low,high)
    v['cfg_profile_id']=np.full(n,'PROFILE-A',dtype=object)
    v['cfg_revision_id']=np.full(n,'REV-001',dtype=object)
    v['cfg_integrity_ok']=np.ones(n,dtype=bool)
    norm('pwr_bus_level_pu',0.86,0.004)
    norm('pwr_load_pu',0.38,0.006)
    norm('pwr_margin_pu',0.75,0.005)
    v['pwr_fault']=np.zeros(n,dtype=bool)
    norm('thm_core_temp_pu',0.46,0.004)
    norm('thm_payload_temp_pu',0.43,0.003)
    v['thm_warning']=np.zeros(n,dtype=bool)
    norm('clk_offset_ms',0,1.3,-250,250)
    v['clk_lock_state']=np.full(n,'LOCKED',dtype=object)
    v['clk_resync_count']=np.zeros(n,dtype=int)
    norm('daq_rate_hz',2.0,0.005,0,10)
    v['daq_missing_samples']=np.zeros(n,dtype=int)
    norm('daq_quality_pu',0.991,0.002,0,1)
    norm('daq_buffer_pct',18,0.6,0,100)
    v['com_link_state']=np.full(n,'CONNECTED',dtype=object)
    norm('com_loss_pct',0.12,0.06,0,100)
    norm('com_latency_ms',45,2,0,10000)
    v['com_gap_s']=np.zeros(n,dtype=float)
    v['sup_state']=np.array([('IDLE' if i==0 else 'READY' if i==1 else 'ACTIVE' if i<=4 else 'SAFE' if i==5 else 'ARCHIVED' if sub_ids[k]=='P6B' else 'SAFE') for k,i in enumerate(phase_idx)],dtype=object)
    v['sup_mode']=np.full(n,'NORMAL',dtype=object)
    norm('sup_heartbeat_age_s',0.25,0.035,0,60)
    v['sup_fault_count']=np.zeros(n,dtype=int)
    v['seq_phase_id']=np.array([f'P{i}' for i in phase_idx],dtype=object)
    v['seq_subphase_id']=np.array(sub_ids,dtype=object)
    v['seq_pending']=np.array([s in ('P3A',) for s in sub_ids],dtype=bool)
    v['seq_delay_s']=np.zeros(n,dtype=float)
    v['stg_state']=np.full(n,'NOT_APPLICABLE',dtype=object)
    v['stg_state'][(t>=280)&(t<340)]='PENDING'
    v['stg_state'][(t>=340)&(t<400)]='CONFIRMED'
    v['stg_event']=np.isclose(t,340)
    v['stg_ack_age_s']=np.zeros(n,dtype=float)
    norm('env_pressure_pu',0.52,0.004)
    norm('env_temp_pu',0.42,0.003)
    norm('env_vibration_pu',0.24,0.006)
    v['act_state']=np.array(['IDLE' if i<=1 or i>=5 else 'ACTIVE' for i in phase_idx],dtype=object)
    norm('act_response_lag_ms',35,2.0,0,5000)
    v['act_fault']=np.zeros(n,dtype=bool)
    v['saf_state']=np.array(['CHECKING' if i==0 else 'READY' if i==1 else 'MONITORING' if i<=4 else 'SAFE' for i in phase_idx],dtype=object)
    v['saf_interlock_ok']=np.ones(n,dtype=bool)
    v['saf_event_count']=np.array([1 if x>=600 else 0 for x in t],dtype=int)
    v['log_integrity_ok']=np.ones(n,dtype=bool)
    v['log_backlog']=np.zeros(n,dtype=int)
    received_s=t+0.16
    delivery_state=np.full(n,'DELIVERED',dtype=object)
    keep=np.ones(n,dtype=bool)
    event_defs=[]
    def add_event(s,kind,source,message,actual_receipt=None):
        event_defs.append({'source_s':float(s),'type':kind,'subsystem_id':source,'message':message,'received_s':float(actual_receipt) if actual_receipt is not None else float(s)+0.16})
    add_event(0,'RUN_STARTED','SUP','Mission observation record started')
    for ph in phases:
        for sub in ph['subphases']:
            add_event(sub['nominal_window_s']['start'],'SUBPHASE_ENTER','SEQ',f"Reported {sub['id']} — {sub['name']}")
    add_event(340,'STG_STATE_CONFIRMED','STG','Independent stage-event monitor reports CONFIRMED')
    add_event(600,'TERMINAL_EVENT_OBSERVED','SAF','Terminal safe-state observation recorded')
    add_event(780,'RECONCILIATION_STARTED','LOG','Post-run reconciliation began')
    add_event(840,'RUN_ARCHIVED','SUP','Run archive phase entered')
    add_event(899.5,'RUN_COMPLETED','LOG','Observation run data closed')
    config={'onset_s':None,'offset_s':None,'affected_channels':[], 'cause_label':'none','effects':[]}
    onset=round((320+seed*4)/0.5)*0.5
    duration=26+3*seed
    end=onset+duration
    if scenario_id=='S02':
        onset=340.; duration=10+3*seed;end=onset+duration
        q=(t>=onset)&(t<end)
        v['seq_subphase_id'][q]='P3A'
        v['seq_pending'][q]=True
        v['seq_delay_s'][q]=t[q]-onset+0.5
        v['stg_ack_age_s'][q]=t[q]-onset
        # independently confirmed event at 340 is retained; reported P3B occurs late
        for ev in event_defs:
            if ev['type']=='SUBPHASE_ENTER' and ev['source_s']==340:
                ev['source_s']=end;ev['received_s']=end+0.16;ev['message']='Reported P3B — Transition confirmed (late indication)'
        add_event(onset,'SEQ_ACK_PENDING','SEQ','Reported phase acknowledgement pending')
        config={'onset_s':onset,'offset_s':end,'affected_channels':['seq_subphase_id','seq_pending','seq_delay_s','stg_ack_age_s'], 'cause_label':'reported_transition_delay','effects':['P3B reporting delayed; independent STG confirms canonical event at 340 s']}
    elif scenario_id=='S03':
        onset=355+seed*4;duration=110+seed*7;end=onset+duration
        ramp=np.clip((t-onset)/duration,0,1)
        v['env_temp_pu']+=0.17*ramp
        v['daq_quality_pu']-=0.045*ramp
        config={'onset_s':onset,'offset_s':900,'plateau_reached_s':end,'affected_channels':['env_temp_pu','daq_quality_pu','hlt_warning_count','hlt_overall_state'], 'cause_label':'environmental_sensor_bias','effects':['Environmental reading drifts; nearby payload temperature does not track it']}
    elif scenario_id=='S04':
        onset=319+seed*3;duration=23+2*seed;end=onset+duration
        q=(t>=onset)&(t<end)
        keep[q]=False
        missed=int(q.sum())
        v['daq_missing_samples'][t>=end]=missed
        qrec=(t>=end)&(t<end+12)
        v['daq_quality_pu'][qrec]=0.82+0.03*np.clip((t[qrec]-end)/12,0,1)
        v['daq_buffer_pct'][qrec]+=35*np.maximum(0,1-(t[qrec]-end)/12)
        add_event(end,'DAQ_CAPTURE_RESUMED','DAQ',f'Source capture resumed; cumulative missing samples {missed}')
        config={'onset_s':onset,'offset_s':end,'affected_channels':['daq_missing_samples','daq_quality_pu','daq_buffer_pct'], 'cause_label':'source_acquisition_dropout','effects':[f'{missed} scheduled source samples absent; source and delivery loss are distinct']}
    elif scenario_id=='S05':
        onset=314+seed*2;duration=30+seed*2;end=onset+duration
        q=(t>=onset)&(t<end)
        v['log_backlog'][q]=np.minimum(18,np.floor((t[q]-onset)/2).astype(int)+1)
        v['log_backlog'][(t>=end)&(t<end+16)]=np.maximum(0,np.ceil((end+16-t[(t>=end)&(t<end+16)])/2).astype(int))
        add_event(onset+3,'TRANSITION_CONFIRMED_REPORTED','LOG','Logged transition confirmation reported before independent monitor confirmation', actual_receipt=end+7)
        for ev in event_defs:
            if ev['source_s']>=onset and ev['source_s']<=end and ev['type'] in ('SUBPHASE_ENTER','STG_STATE_CONFIRMED'):
                ev['received_s']+=15+seed
        config={'onset_s':onset,'offset_s':end,'affected_channels':['log_backlog','log_seq','log_integrity_ok','seq_subphase_id'], 'cause_label':'delayed_log_with_incorrect_transition_record','effects':['Late-arriving log record contradicts independent STG timeline','Log chain remains intact despite incorrect semantic event']}
    elif scenario_id=='S06':
        onset=335+seed*3;duration=105+3*seed;end=onset+duration
        ramp=np.clip((t-onset)/20,0,1)
        v['pwr_bus_level_pu']-=0.23*ramp
        v['pwr_margin_pu']-=0.47*ramp
        v['pwr_load_pu']+=0.06*ramp
        v['pwr_fault']=ramp>0.7
        v['thm_core_temp_pu']+=0.08*np.clip((t-(onset+14))/25,0,1)
        v['thm_warning']=np.clip((t-(onset+14))/25,0,1)>0.72
        v['sup_mode'][v['pwr_fault']]='CAUTION'
        v['sup_fault_count'][t>=onset+14]=1
        add_event(onset+14.5,'PWR_WARNING_OBSERVED','PWR','Power monitoring flagged degradation')
        add_event(onset+33,'THM_WARNING_OBSERVED','THM','Thermal monitoring warning followed upstream health change')
        config={'onset_s':onset,'offset_s':900,'plateau_reached_s':end,'affected_channels':['pwr_bus_level_pu','pwr_margin_pu','pwr_fault','thm_core_temp_pu','thm_warning','hlt_warning_count','hlt_overall_state'], 'cause_label':'upstream_power_degradation','effects':['Power health warning precedes thermal warning','Aggregate health reflects both warnings']}
    elif scenario_id=='S07':
        onset=315+seed*4;duration=22+4*seed;end=onset+duration
        q=(t>=onset)&(t<end)
        v['com_link_state'][q]='DISCONNECTED'
        v['com_loss_pct'][q]=99
        v['com_gap_s'][q]=t[q]-onset+0.5
        v['com_latency_ms'][q]=9500
        received_s[q]=end+0.2+np.arange(np.sum(q))*0.003
        delivery_state[q]='BACKFILLED'
        qrec=(t>=end)&(t<end+9)
        v['com_link_state'][qrec]='DEGRADED'
        v['com_loss_pct'][qrec]=3+0.5*rng.random(np.sum(qrec))
        add_event(end,'COM_LINK_RESTORED','COM','Link restored and buffered source samples delivered')
        config={'onset_s':onset,'offset_s':end,'affected_channels':['com_link_state','com_loss_pct','com_gap_s','com_latency_ms'], 'cause_label':'communications_delivery_interruption','effects':['Source rows complete; received timestamps show delayed delivery','DAQ missing counter unchanged']}
    elif scenario_id=='S08':
        onset=315+seed*3;duration=37+2*seed;end=onset+duration
        q=(t>=onset)&(t<end)
        v['clk_lock_state'][q]='HOLDOVER'
        v['clk_offset_ms'][q]=80+0.7*(t[q]-onset)
        v['clk_resync_count'][t>=end]=1
        v['com_latency_ms'][q]=1100+10*(t[q]-onset)
        v['log_backlog'][q]=np.floor((t[q]-onset)/5).astype(int)+1
        for ev in event_defs:
            if onset<=ev['source_s']<end:
                ev['received_s']+=11+seed
        add_event(end,'CLK_RELOCK_OBSERVED','CLK','Clock lock restored after holdover')
        config={'onset_s':onset,'offset_s':end,'affected_channels':['clk_offset_ms','clk_lock_state','clk_resync_count','com_latency_ms','log_backlog','log_seq'], 'cause_label':'clock_holdover_and_delayed_log_delivery','effects':['Source timestamps remain monotonic while offset and receipt times diverge','Timestamp provenance is needed to distinguish explanations']}
    # Explicitly derived values follow perturbations.
    v['thm_delta_pu']=v['thm_core_temp_pu']-v['thm_payload_temp_pu']
    # Warnings are observations across modalities, never hidden cause labels.
    env_disagree=(v['env_temp_pu']-v['thm_payload_temp_pu'])>0.085
    pwr_warn=v['pwr_fault']
    thm_warn=v['thm_warning']
    v['hlt_warning_count']=pwr_warn.astype(int)+thm_warn.astype(int)+env_disagree.astype(int)
    v['hlt_degraded']=v['hlt_warning_count']>=2
    v['hlt_overall_state']=np.where(v['hlt_degraded'],'DEGRADED',np.where(v['hlt_warning_count']>0,'WARNING','NOMINAL'))
    if scenario_id=='S03':
        ix=np.flatnonzero(env_disagree)
        if len(ix): add_event(t[ix[0]],'SENSOR_READING_DISAGREEMENT','HLT','Environmental sensor reading differs from independent thermal observation')
    if scenario_id=='S06':
        # The cumulative fault count records first warning activation.
        first=np.flatnonzero(pwr_warn)
        if len(first):
            v['sup_fault_count'][t>=t[first[0]]]=1
    # The event sequence tracks event creation time, even if delivery delayed.
    event_defs.sort(key=lambda e:(e['source_s'],e['type']))
    for k,e in enumerate(event_defs,1): e['event_seq']=k
    event_times=np.array([e['source_s'] for e in event_defs])
    v['log_seq']=np.searchsorted(event_times,t,side='right').astype(int)
    # Contract checks before writing.
    ids=[c['id'] for c in channel_specs]
    assert set(ids)==set(v), (set(ids)-set(v),set(v)-set(ids))
    assert all(len(v[k])==n for k in v)
    for ch in channel_specs:
        a=v[ch['id']];domain=ch['domain'];kind=domain['kind']
        if kind=='range':
            assert np.all((a>=domain['minimum']-1e-8)&(a<=domain['maximum']+1e-8)),ch['id']
        elif kind=='enum':
            assert set(np.unique(a)).issubset(set(domain['values'])),ch['id']
    assert np.all(np.diff(v['log_seq'])>=0)
    assert np.allclose(v['thm_delta_pu'],v['thm_core_temp_pu']-v['thm_payload_temp_pu'])
    out=output_root/'agent_visible'/'runs'/public_id
    out.mkdir(parents=True,exist_ok=True)
    float_ids={c['id'] for c in channel_specs if c['type']=='float'}
    bool_ids={c['id'] for c in channel_specs if c['type']=='boolean'}
    cols=['run_id','sample_index','mission_elapsed_s','source_time_utc','received_time_utc','delivery_state']+ids
    with (out/'telemetry.csv').open('w',newline='',encoding='utf-8') as f:
        w=csv.writer(f,lineterminator='\n');w.writerow(cols)
        for k in np.flatnonzero(keep):
            row=[public_id,int(k),f'{t[k]:.1f}',stamp(t[k]),stamp(received_s[k]),str(delivery_state[k])]
            for ch in ids:
                x=v[ch][k]
                if ch in float_ids: row.append(f'{float(x):.4f}')
                elif ch in bool_ids: row.append('true' if bool(x) else 'false')
                else:row.append(str(x))
            w.writerow(row)
    with (out/'events.jsonl').open('w',encoding='utf-8',newline='\n') as f:
        for e in event_defs:
            pub={k:v for k,v in e.items() if k not in ('source_s','received_s')}
            pub.update({'run_id':public_id,'source_time_utc':stamp(e['source_s']),'received_time_utc':stamp(e['received_s']),'mission_elapsed_s':e['source_s']})
            f.write(json.dumps(pub,sort_keys=True,ensure_ascii=False)+'\n')
    reg_sha=hash_file(REGISTRY_PATH)
    manifest={'run_id':public_id,'spec_id':spec['spec_id'],'spec_version':spec['version'],'registry_sha256':reg_sha,
              'generator_version':GENERATOR_VERSION,'model_kind':'fictional_non_operational_telemetry',
              'source':'SYNTHETIC','sampling_hz':hz,'duration_s':n/hz,'expected_samples':n,
              'observed_samples':int(keep.sum()),'event_count':len(event_defs),
              'source_time_min':stamp(t[0]),'source_time_max':stamp(t[-1]),
              'telemetry_sha256':hash_file(out/'telemetry.csv'),'events_sha256':hash_file(out/'events.jsonl'),
              'agent_visible_only':True,
              'interpretation':'source timestamps are acquisition clock; received timestamps may be later for communication/log issues'}
    jdump(out/'run_manifest.json',manifest)
    private={'run_id':public_id,'internal_run_id':internal_id,'scenario_id':scenario_id,'seed':seed,'spec_version':spec['version'],
             'cause_label':config['cause_label'],'onset_s':config['onset_s'],'offset_s':config['offset_s'],'plateau_reached_s':config.get('plateau_reached_s'),
             'affected_channels':config['affected_channels'],'expected_observed_effects':config['effects'],
             'expected_samples':n,'observed_samples':int(keep.sum()),
             'canonical_phase_boundaries_s':[ph['nominal_window_s']['start'] for ph in phases],
             'independent_stage_confirmation_s':340,
             'evaluator_only':True}
    priv=output_root/'evaluator_only'/'ground_truth'/f'{public_id}.json'
    jdump(priv,private)
    return manifest, private


def main():
    spec=yaml.safe_load(REGISTRY_PATH.read_text(encoding='utf-8'))
    assert len(spec['channels'])==48 and len(spec['scenarios'])==8
    summary=[];private_index=[]
    for sid,seed,public_id,internal_id in make_plan(spec):
        public, hidden=build_run(spec,sid,seed,public_id,internal_id)
        summary.append({'run_id':public_id,'observed_samples':public['observed_samples'],'expected_samples':1800,'event_count':public['event_count']})
        private_index.append({'public_run_id':public_id,'internal_run_id':internal_id,'scenario_id':sid,'seed':seed})
    jdump(ROOT/'evaluator_only/private_run_index.json',{'entries':private_index,'evaluator_only':True})
    jdump(ROOT/'validation/generated_run_inventory.json',summary)
    print(f'Generated {len(summary)} deterministic synthetic runs, {sum(x["observed_samples"] for x in summary):,} observed source rows.')

if __name__=='__main__':main()
