import math
GIB=1024**3
ADMIT_BYTES=int(5.5*GIB)
RESERVE_BYTES=2*GIB
SWAP_BOUND=256*1024**2
MAX_CRITICAL_AGE=2.5

def finite(value):
 return isinstance(value,(int,float)) and math.isfinite(value)

def assess_guard(row,now,phase):
 measured=row.get('criticalMeasuredAt')
 if not finite(measured) or now-measured>MAX_CRITICAL_AGE or measured-now>1:return 'abort','stale_critical_sensor'
 available=row.get('availableFreeInactiveBytes')
 if not finite(available):return 'abort','missing_memory'
 if available<RESERVE_BYTES:return 'abort','memory_reserve'
 if not finite(row.get('swapGrowthBytes')) or not finite(row.get('swapoutBytes')):return 'abort','missing_swap'
 if row['swapGrowthBytes']>SWAP_BOUND or row['swapoutBytes']>SWAP_BOUND:return 'abort','swap'
 if phase=='baseline' and row.get('healthStatus')!=200:return 'abort','baseline_health'
 if row.get('consecutiveHealthFailures',0)>=2:return 'abort','health'
 if row.get('healthStatus')!=200:return 'wait','health'
 if available<ADMIT_BYTES:return 'wait','memory_admission'
 return 'admit',None

def observer_status(exit_code,result):
 if exit_code!=0 or not result or result.get('endedBy') not in ['inputs_exhausted','duration','attempt_cap']:return 'interrupted'
 if result.get('attempted',0)==0:return 'unexercised'
 if result['endedBy']=='inputs_exhausted':return 'completed_runtime_replay'
 return 'partial_runtime_replay'
