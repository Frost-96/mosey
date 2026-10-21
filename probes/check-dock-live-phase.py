#!/usr/bin/env python3
"""Check real CLI evidence against an independently inspected stable raster phase."""
import argparse,json
p=argparse.ArgumentParser()
p.add_argument('jsonl');p.add_argument('--after',type=float,default=0);p.add_argument('--before',type=float,required=True)
p.add_argument('--hidden-after',type=float);p.add_argument('--expected-hash',required=True);p.add_argument('--expect-idle-current',action='store_true')
a=p.parse_args()
records=[json.loads(line) for line in open(a.jsonl)]
phase=[r for r in records if a.after<=r.get('elapsed',-1)<=a.before]
frames=[r for r in phase if r['type']=='frame' and r['status']=='complete_raster_diagnostic' and r.get('raster',{}).get('largestComponent',{}).get('selectedPixelCount',0)>0]
assert frames,'No accepted nonempty frame in the operator-selected stable phase'
last=frames[-1]
assert last['raster']['largestComponent']['inwardContourSummaryPixels']['fnv1a64']==a.expected_hash,'Last accepted stable-phase contour disagrees with independent raster'
if a.expect_idle_current:
    idle=[r for r in phase if r['type']=='heartbeat' and r.get('candidateStatus')=='current_via_idle_heartbeat']
    assert idle,'No explicit diagnostic idle-current observation'
    stable=[r for r in idle if r['lastAcceptedSourceDisplayMachTicks']==last['sourceDisplayMachTicks']]
    assert stable,'Idle must retain the genuine complete-frame timestamp'
    config=next(r for r in records if r['type']=='stream_configuration')
    assert all(r['lastAcceptedSourceAgeSeconds']>config['diagnosticMaxFrameAgeSeconds'] for r in stable)
    assert all(r['lastCallbackAgeSeconds']<=r['callbackTimeoutSeconds'] for r in stable)
    assert all(r['pendingCompleteCount']==0 and r['acceptedCompleteSequence']==r['latestCompleteSequence'] for r in stable)
if a.hidden_after is not None:
    hidden=[r for r in records if r['type']=='heartbeat' and r['elapsed']>=a.hidden_after and r['lastFrameStatusCode'] in [2,3,5]]
    assert hidden,'No non-idle hidden-phase invalidation observed'
    assert all(r['candidateStatus']=='unavailable_or_stale' and r['lastAcceptedSourceAgeSeconds'] is None for r in hidden),'Hidden-phase non-idle status must clear the candidate'
assert all(r.get('supportEdge') is None for r in records)
print('PASS: externally selected stable phase matches independent contour; support remains unverified')
